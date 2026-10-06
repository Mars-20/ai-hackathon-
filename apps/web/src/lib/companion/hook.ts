import "server-only";

import { extractUsageCost } from "@/lib/cost";
import type { runPostSessionInference } from "./infer";
import type { ProposeResult } from "./dal";

// Post-session inference hook (Task 8): scheduled synchronously in POST()
// scope via after(), NEVER from the background streaming IIFE (C4). The
// capture is snapshotted BY VALUE before `return new Response(...)`; the
// callback only reads the snapshot. Every failure path warns and resolves —
// the hook must never break the run.

export interface PostSessionCapture {
  userId: string;
  userEmail: string;
  memoText: string;
  startupName: string;
  budgetKey: string;
}

export interface PostSessionHookDeps {
  // Defaults to the real `after` from next/server (lazy so unit tests never
  // touch the Next runtime — inject a spy instead).
  afterImpl?: (cb: () => void | Promise<unknown>) => void;
  getApprovedValues?: (userId: string) => Promise<string[]>;
  runInference?: typeof runPostSessionInference;
  recordSpend?: (key: string, amountUsd: number) => Promise<number>;
  insertTrace?: (row: {
    userId: string;
    event_type: "companion_infer";
    proposed: number;
    dropped: number;
    latencyMs: number;
  }) => Promise<void>;
}

async function defaultAfterImpl(cb: () => void | Promise<unknown>): Promise<void> {
  const { after } = await import("next/server");
  after(cb);
}

async function defaultGetApprovedValues(userId: string): Promise<string[]> {
  const { listMemories } = await import("./dal");
  const { rows } = await listMemories(userId, "approved", 200);
  return rows.map((r) => r.value);
}

async function defaultCallAI(prompt: string): Promise<{
  text: string;
  usage: { totalTokenCount: number };
}> {
  const { getGeminiKeys } = await import("@/lib/provider-keys");
  const keys = getGeminiKeys();
  if (keys.length === 0) throw new Error("post-session inference: no Gemini keys");
  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const model = new GoogleGenerativeAI(keys[0]).getGenerativeModel({
    model: process.env.GEMINI_PLANNER_MODEL ?? "gemini-3.5-flash-lite",
    generationConfig: { responseMimeType: "application/json" },
  });
  const res = await model.generateContent(prompt);
  const um = (res.response as unknown as { usageMetadata?: { totalTokenCount?: number } })
    ?.usageMetadata;
  return {
    text: res.response.text(),
    usage: { totalTokenCount: typeof um?.totalTokenCount === "number" ? um.totalTokenCount : 0 },
  };
}

async function defaultRunInference(args: {
  userId: string;
  userEmail: string;
  memoText: string;
  startupName: string;
  approvedValues: string[];
}): Promise<ReturnType<typeof runPostSessionInference> extends Promise<infer T> ? T : never> {
  const { runPostSessionInference } = await import("./infer");
  const { getCompanionProfile, proposeMemories } = await import("./dal");
  let enabled = true;
  try {
    enabled = (await getCompanionProfile(args.userId)).memory_enabled;
  } catch {
    enabled = true;
  }
  return runPostSessionInference({
    ...args,
    isEnabled: enabled,
    callAI: defaultCallAI,
    propose: (rows) => proposeMemories(args.userId, rows),
  });
}

async function defaultInsertTrace(row: {
  userId: string;
  event_type: "companion_infer";
  proposed: number;
  dropped: number;
  latencyMs: number;
}): Promise<void> {
  const { createServiceRoleClient } = await import("@/lib/supabase/server");
  const admin = createServiceRoleClient();
  const { error } = await admin.from("trace_events").insert({
    startup_id: null,
    workspace_id: null,
    actor: "companion",
    event_type: row.event_type,
    payload: { user_id: row.userId, proposed: row.proposed, dropped: row.dropped },
    cost_usd: null,
    latency_ms: row.latencyMs,
  });
  if (error) throw error;
}

// Dispatcher: calls after() SYNCHRONOUSLY with a snapshot-bound callback.
// Route code calls this in POST() scope with defaults; tests inject a spy.
export function schedulePostSessionHook(
  capture: PostSessionCapture,
  over?: Partial<PostSessionHookDeps>,
): void {
  const schedule = over?.afterImpl ?? defaultAfterImpl;
  schedule(() => {
    void executePostSessionHook(capture, over);
  });
}

export async function executePostSessionHook(
  capture: PostSessionCapture,
  over?: Partial<PostSessionHookDeps>,
): Promise<void> {
  const t0 = Date.now();
  const getApproved = over?.getApprovedValues ?? defaultGetApprovedValues;
  const runInference = (over?.runInference ?? defaultRunInference) as (
    args: Parameters<typeof defaultRunInference>[0],
  ) => Promise<
    | { skipped: string }
    | { proposed: ProposeResult; usage: { totalTokenCount: number }; proposeError?: string }
  >;
  let approvedValues: string[] = [];
  try {
    approvedValues = await getApproved(capture.userId);
  } catch (err) {
    console.warn("[companion] post-session approved-values lookup failed, continuing without dedupe", err);
  }
  let out: { skipped: string } | { proposed: ProposeResult; usage: { totalTokenCount: number }; proposeError?: string };
  try {
    out = await runInference({
      userId: capture.userId,
      userEmail: capture.userEmail,
      memoText: capture.memoText,
      startupName: capture.startupName,
      approvedValues,
    });
  } catch (err) {
    console.warn("[companion] post-session inference failed", err);
    return;
  }
  if ("skipped" in out) return;
  // H5: infer spend is ledgered like any other provider call.
  const record = over?.recordSpend;
  try {
    if (record) {
      await record(capture.budgetKey, extractUsageCost(out.usage, "gemini_call"));
    } else {
      const { recordSpendAsync } = await import("@/lib/cost");
      await recordSpendAsync(capture.budgetKey, extractUsageCost(out.usage, "gemini_call"));
    }
  } catch (err) {
    console.warn("[companion] infer spend ledger failed", err);
  }
  // Propose failed AFTER a successful model call: spend above is already
  // ledgered — say so loudly instead of looking like a silent skip (#9).
  if (out.proposeError) {
    console.warn("[companion] post-session propose failed, spend ledgered", out.proposeError);
  }
  const insert = over?.insertTrace ?? defaultInsertTrace;
  try {
    await insert({
      userId: capture.userId,
      event_type: "companion_infer",
      proposed: out.proposed.results.length,
      dropped: out.proposed.dropped.length,
      latencyMs: Date.now() - t0,
    });
  } catch (err) {
    console.warn("[companion] companion_infer trace insert failed", err);
  }
}
