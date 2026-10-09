// Assistant chat HTTP handlers (companion http.ts pattern: handlers own the
// logic with injected deps; routes are thin wrappers).
//
// Response contract: pre-persist denials return JSON (400/402/403/409/422/429,
// 401 handled by routes/e2e); everything at/after persistence streams SSE
// (token/tool/done/error) with HTTP 200 so the client's streaming loop has
// one shape to parse.

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAgentGate, type EntitlementStatus } from "@/lib/entitlements";
import { checkRateLimit } from "@/lib/rate-limit";
import { extractUsageCost, recordSpendAsync } from "@/lib/cost";
import { createManualMemory, getCompiledContext } from "@/lib/companion/dal";
import { containsBlockedSecret } from "@/lib/companion/scans";
import { resolveEffectiveWorkspaceId } from "@/lib/agent-workspace";
import { resolveOrder, stagePosition } from "@/lib/progress/tracks";
import {
  adaptCitedRows,
  AssistantOutageError,
  callAssistantWithTools,
  criticScan,
  type AssistantToolCall,
} from "./model";
import {
  consumeOne,
  getDailyQuota,
  refundOne,
  secondsToUtcMidnight,
} from "./quota";
import {
  createExperiment,
  updateExperiment,
} from "@/lib/experiments";
import {
  resolveLocale,
  systemPromptFor,
  type AiLocale,
} from "@/lib/ai-locale";

const UUID = z.string().uuid();
const MESSAGE_MAX = 4000;
const REPLY_MAX = 8000;
const THREAD_CAP = 200;
const HISTORY_TURNS = 20;

const postSchema = z.object({
  conversation_id: UUID.optional(),
  client_message_id: UUID,
  message: z.string().min(1).max(MESSAGE_MAX),
  locale: z.enum(["ar", "en"]).optional(),
});

const CITATION_KINDS = new Set([
  "startup",
  "assumption",
  "evidence",
  "decision",
  "memory",
]);

export interface StartupBrief {
  id: string;
  name: string;
  one_liner: string | null;
  domain: string | null;
  stage: string | null;
  stage_track?: string | null;
  stage_order?: Array<{ key: string; label: string }> | null;
}

export interface AssistantTools {
  saveMemory(
    userId: string,
    args: { kind: string; value: string; startup_id?: string }
  ): Promise<{ id: string }>;
  createExperiment(
    userId: string,
    args: Record<string, unknown>
  ): Promise<{ id: string }>;
  updateExperiment(
    userId: string,
    args: Record<string, unknown>
  ): Promise<{ id: string }>;
  runValidation(
    userId: string,
    args: { idea: string; uploaded_data?: unknown }
  ): Promise<{ startup_id: string }>;
}

export interface AssistantGrounding {
  compiled(userId: string, message: string): Promise<string>;
  startups(userId: string): Promise<StartupBrief[]>;
}

export interface AssistantHttpContext {
  userId: string;
  /** User-scoped client (RLS). */
  db: SupabaseClient;
  /** Service-role client (quota RPCs, entitlement reads). */
  admin: SupabaseClient;
  entitlement: EntitlementStatus | null;
  quotaMax: number;
  /** Raw NEXT_LOCALE cookie value (route layer reads it via await cookies()). */
  cookieLocale?: string | null;
  nowMs?: () => number;
  rate?: (key: string) => Promise<{ limited: boolean; retryAfter: number }>;
  modelCaller?: typeof callAssistantWithTools;
  grounding?: AssistantGrounding;
  tools?: AssistantTools;
  spend?: (key: string, usd: number) => Promise<unknown>;
}

// sanitizeForPrompt replica (agent/route.ts:1747 owns its copy; this module
// owns its copy — same semantics, cited here so drift is greppable).
function sanitizeForPrompt(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*(system|assistant|user)\s*:/gim, " ")
    .replace(/ignore (all )?previous instructions/gi, "[filtered]")
    .replace(/jailbreak|DAN mode/gi, "[filtered]")
    .slice(0, MESSAGE_MAX + 8000);
}

/** PII redaction for persisted chat content (emails + long digit sequences). */
export function redactPii(s: string): string {
  return s
    .replace(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
      "[redacted-email]"
    )
    .replace(/\+?\d[\d\s-]{7,}\d/g, "[redacted-phone]");
}

const GATE_MESSAGES: Record<string, string> = {
  TRIAL_CONSUMED: "انتهت تجربتك المجانية — اشترك لمواصلة العمل",
  SUBSCRIPTION_REQUIRED: "هذا الإجراء يتطلب اشتراكًا",
  ACCOUNT_PAUSED: "حسابك موقوف مؤقتًا — راجع الإدارة",
};

function json(body: unknown, status: number, retryAfter?: number): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof retryAfter === "number") headers["Retry-After"] = String(retryAfter);
  return new Response(JSON.stringify(body), { status, headers });
}

function sse(events: unknown[]): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(text, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function chunk(text: string, size = 60): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

interface ConvRow {
  id: string;
  user_id: string;
  title: string;
}

/** Owned evidence rows for the critic (claim + source_url, capped). */
async function ownedEvidenceRows(
  ctx: AssistantHttpContext
): Promise<Array<{ claim: string; source_url: string }>> {
  try {
    const { data: owned } = (await ctx.db
      .from("startups")
      .select("id")
      .eq("owner_id", ctx.userId)
      .limit(50)) as unknown as { data: Array<{ id: string }> | null };
    const ids = (owned ?? []).map((s) => s.id);
    if (ids.length === 0) return [];
    const { data: rows } = (await ctx.db
      .from("evidence")
      .select("claim,source_url")
      .in("startup_id", ids)
      .limit(100)) as unknown as {
      data: Array<{ claim: string; source_url: string | null }> | null;
    };
    return (rows ?? [])
      .filter((r) => typeof r.claim === "string" && typeof r.source_url === "string" && r.source_url.length > 0)
      .map((r) => ({ claim: r.claim, source_url: r.source_url as string }));
  } catch {
    return [];
  }
}

/** Owned startup claims for the critic (name + one-liner + stage + position
 * ordinal). Read fresh from the DB at critic time like evidence/memories —
 * the grounding object may be stale or stubbed. The stage/position text is
 * what makes a grounded "(1/4)" matchable (live regression 2026-10-09). */
async function ownedStartupRows(ctx: AssistantHttpContext): Promise<string[]> {
  try {
    const extended = (await ctx.db
      .from("startups")
      .select("name,one_liner,stage,stage_track,stage_order")
      .eq("owner_id", ctx.userId)
      .limit(50)) as unknown as { data: StartupBrief[] | null };
    const rows = (extended.data ?? []) as StartupBrief[];
    return rows
      .filter((s) => typeof s.name === "string")
      .map((s) => {
        const order = resolveOrder(
          s.stage_track ?? null,
          (s.stage_order ?? null) as Array<{ key: string; label: string }> | null,
        );
        const pos = stagePosition(order, s.stage ?? "idea");
        const position = pos >= 0 ? ` stage ${pos + 1}/${order.length}` : "";
        return `${s.name}: ${s.one_liner ?? ""} ${s.stage ?? ""}${position}`;
      });
  } catch {
    return [];
  }
}

/** Approved memory values for the critic. Memories carry no URL, so they
 * are keyed with source "memory" — claimHasUrlSupport only needs a truthy
 * source plus token overlap. Live regression 2026-10-07: a just-saved
 * memory cited as [M1] was critic-blocked because the adapted rows
 * excluded memories entirely, so saved memories could never be quoted. */
async function ownedMemoryRows(
  ctx: AssistantHttpContext
): Promise<Array<{ claim: string; source_url: string }>> {
  try {
    const { data: rows } = (await ctx.db
      .from("companion_memory")
      .select("value")
      .eq("user_id", ctx.userId)
      .eq("status", "approved")
      .order("created_at", { ascending: false })
      .limit(200)) as unknown as {
      data: Array<{ value: unknown }> | null;
    };
    return (rows ?? [])
      .filter((r) => typeof r.value === "string" && r.value.length > 0)
      .map((r) => ({ claim: r.value as string, source_url: "memory" }));
  } catch {
    return [];
  }
}

interface Row {
  [k: string]: unknown;
}

async function getOwnedConversation(
  db: SupabaseClient,
  userId: string,
  id: string
): Promise<ConvRow | null> {
  const { data } = await db
    .from("assistant_conversations")
    .select("id,user_id,title")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  return (data as unknown as ConvRow | null) ?? null;
}

async function defaultGrounding(userId: string, db: SupabaseClient): Promise<AssistantGrounding> {
  void userId;
  void db;
  return {
    compiled: (uid, message) => getCompiledContext(uid, message).catch(() => ""),
    startups: async (uid) => {
      // Extended select first; pre-migration-0016 fallback to legacy
      // columns so grounding never degrades on old schemas.
      const extended = (await db
        .from("startups")
        .select("id,name,one_liner,domain,stage,stage_track,stage_order")
        .eq("owner_id", uid)
        .limit(50)) as unknown as { data: StartupBrief[] | null };
      if (extended.data) return extended.data;
      const { data } = await db
        .from("startups")
        .select("id,name,one_liner,domain,stage")
        .eq("owner_id", uid)
        .limit(50);
      return ((data ?? []) as unknown as StartupBrief[]);
    },
  };
}

function defaultTools(db: SupabaseClient): AssistantTools {
  return {
    saveMemory: (userId, args) =>
      createManualMemory(userId, {
        kind: args.kind,
        value: args.value,
        startup_id: args.startup_id ?? null,
      }),
    createExperiment: (userId, args) =>
      createExperiment(db, userId, {
        startup_id: args.startup_id as string,
        assumption_id: (args.assumption_id as string | null | undefined) ?? null,
        type: args.type as string,
        design: args.design,
        status: (args.status as string | undefined) ?? "draft",
      }),
    updateExperiment: (userId, args) =>
      updateExperiment(db, userId, {
        experiment_id: args.experiment_id as string,
        patch: args.patch as { status?: string; design?: unknown },
      }),
    runValidation: async (userId, args) => {
      const workspaceId = await resolveEffectiveWorkspaceId(db, userId, "");
      if (!workspaceId) throw new Error("No workspace available for validation");
      const id = crypto.randomUUID();
      const idea = args.idea.trim();
      const { error } = await db.from("startups").insert({
        id,
        workspace_id: workspaceId,
        owner_id: userId,
        name: idea.slice(0, 120),
        one_liner: idea.slice(0, 280),
        domain: "general",
        target_customer: null,
        stage: "idea",
        business_model: null,
      });
      if (error) throw error;
      return { startup_id: id };
    },
  };
}

function systemPrompt(locale: AiLocale = "en"): string {
  return [
    systemPromptFor(locale),
    "Ground every factual claim about the user's data in the context rows and cite them.",
    "When no supporting rows exist, refuse explicitly and name the missing data.",
    "Never invent startups, numbers, URLs, or decisions.",
  ].join(" ");
}

function refusalFor(locale: AiLocale = "en"): string {
  return locale === "ar"
    ? "لا أجد بيانات في مساحات عملك تدعم الإجابة عن هذا — أخبرني باسم المشروع أو أضف البيانات أولا."
    : "I can't find supporting data in your workspaces for this — tell me the project name or add the data first.";
}

interface Persisted {
  content: string;
  citations: Array<{ kind: string; id: string; label: string }>;
}

async function persistAssistantTurn(
  db: SupabaseClient,
  conversationId: string,
  reply: string,
  citations: Persisted["citations"]
): Promise<void> {
  await db.from("assistant_messages").insert({
    id: crypto.randomUUID(),
    conversation_id: conversationId,
    client_message_id: crypto.randomUUID(),
    role: "assistant",
    content: redactPii(reply).slice(0, REPLY_MAX),
    citations,
  });
}

async function traceTool(
  db: SupabaseClient,
  eventType: "tool_call" | "tool_result",
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await db.from("trace_events").insert({
      startup_id: null,
      workspace_id: null,
      actor: "executor",
      event_type: eventType,
      payload,
    });
  } catch {
    // best-effort only — trace failure must not break the stream
  }
}

export async function handleAssistantPost(
  ctx: AssistantHttpContext,
  rawBody: unknown
): Promise<Response> {
  const parsed = postSchema.safeParse(rawBody);
  if (!parsed.success) {
    return json({ error: "Invalid request", code: "INVALID" }, 400);
  }
  const { conversation_id, client_message_id, message, locale: bodyLocale } = parsed.data;
  // Effective locale: body.locale > NEXT_LOCALE cookie > "en"
  // (resolveLocale pins the parenthesized fallback chain).
  const effectiveLocale = resolveLocale(bodyLocale, ctx.cookieLocale);
  const nowMs = (ctx.nowMs ?? Date.now)();
  const modelCaller = ctx.modelCaller ?? callAssistantWithTools;
  const spend = ctx.spend ?? recordSpendAsync;

  // 2. rate limit (fail-closed)
  const rate = ctx.rate ?? (async (key: string) => checkRateLimit({ key }));
  const rl = await rate(`assistant:${ctx.userId}`);
  if (rl.limited) {
    return json(
      { error: "Too many requests", code: "RATE_LIMITED", retryAfter: rl.retryAfter },
      429,
      rl.retryAfter
    );
  }

  // Secret sweep before quota: blocked input consumes nothing.
  if (containsBlockedSecret(message)) {
    return json({ error: "Message contains a blocked secret", code: "SECRET_BLOCKED" }, 422);
  }

  // 3. entitlement gate (402, mirrors agent shape + plans_url)
  const gate = resolveAgentGate(ctx.entitlement);
  if (!gate.allowed) {
    return json(
      {
        error: GATE_MESSAGES[gate.code] ?? GATE_MESSAGES.SUBSCRIPTION_REQUIRED,
        code: gate.code,
        plans_url: "/plans",
      },
      402
    );
  }

  // 4. conversation resolve (uniform 403, no existence oracle)
  let conversation: ConvRow | null = null;
  let isNew = false;
  // True when a user row with this client_message_id already exists (retry
  // after an undelivered turn): the re-execution must NOT re-insert it —
  // unique(conversation_id, client_message_id) would 23505.
  let userRowPersisted = false;
  if (conversation_id) {
    conversation = await getOwnedConversation(ctx.db, ctx.userId, conversation_id);
    if (!conversation) return json({ error: "Forbidden", code: "FORBIDDEN" }, 403);
  } else {
    // Double-submit of a new-chat request: same client id already persisted?
    const ownConvos = (await ctx.db
      .from("assistant_conversations")
      .select("id")
      .eq("user_id", ctx.userId)) as unknown as { data: Array<{ id: string }> | null };
    const ids = (ownConvos.data ?? []).map((c) => c.id);
    if (ids.length > 0) {
      const { data: dupe } = await ctx.db
        .from("assistant_messages")
        .select("id,conversation_id,role,content,citations")
        .eq("client_message_id", client_message_id)
        .in("conversation_id", ids)
        .maybeSingle();
      const dupeRow = dupe as unknown as {
        conversation_id: string;
        role: string;
        content: string;
        citations: Persisted["citations"];
      } | null;
      if (dupeRow && dupeRow.role === "user") {
        const { data: follow } = await ctx.db
          .from("assistant_messages")
          .select("role,content,citations")
          .eq("conversation_id", dupeRow.conversation_id)
          .order("seq", { ascending: true });
        const rows = (follow ?? []) as unknown as Array<{
          role: string;
          content: string;
          citations: Persisted["citations"];
        }>;
        // Replay only a DELIVERED exchange; an outage persisted the user row
        // with no answer — that retry must re-execute, not echo the question.
        const assistantRow = [...rows].reverse().find((r) => r.role === "assistant");
          if (assistantRow) {
            const reply = assistantRow.content;
            const citations = assistantRow.citations ?? [];
            return sse([
              ...chunk(reply).map((text) => ({ type: "token", text })),
              {
                type: "done",
                conversation_id: dupeRow.conversation_id,
                citations,
                deduped: true,
              },
            ]);
          }
          // Undelivered (outage persisted only the question): adopt the
          // existing thread and re-execute there — no orphan duplicate.
          const adopted = await getOwnedConversation(
            ctx.db,
            ctx.userId,
            dupeRow.conversation_id
          );
          if (adopted) {
            conversation = adopted;
            userRowPersisted = true;
          } else {
            return json({ error: "Forbidden", code: "FORBIDDEN" }, 403);
          }
      }
    }
    if (!conversation) {
      const id = crypto.randomUUID();
      const { error } = await ctx.db.from("assistant_conversations").insert({
        id,
        user_id: ctx.userId,
        title: message.slice(0, 60),
      });
      if (error) return json({ error: "Could not start conversation", code: "INVALID" }, 400);
      conversation = { id, user_id: ctx.userId, title: message.slice(0, 60) };
      isNew = true;
    }
  }

  // Same-conversation retry: same client id already has a persisted exchange.
  const { data: existing } = await ctx.db
    .from("assistant_messages")
    .select("role,content,citations")
    .eq("conversation_id", conversation.id)
    .eq("client_message_id", client_message_id)
    .maybeSingle();
  const existingRow = existing as unknown as {
    role: string;
    content: string;
    citations: Persisted["citations"];
  } | null;
  if (existingRow && existingRow.role === "user") {
    const { data: follow } = await ctx.db
      .from("assistant_messages")
      .select("role,content,citations")
      .eq("conversation_id", conversation.id)
      .order("seq", { ascending: true });
    const rows = (follow ?? []) as unknown as Array<{
      role: string;
      content: string;
      citations: Persisted["citations"];
    }>;
    const assistantRow = [...rows].reverse().find((r) => r.role === "assistant");
    if (assistantRow) {
      const reply = assistantRow.content;
      const citations = assistantRow.citations ?? [];
      return sse([
        ...chunk(reply).map((text) => ({ type: "token", text })),
        { type: "done", conversation_id: conversation.id, citations, deduped: true },
      ]);
    }
    // No delivered answer (e.g. outage persisted only the question):
    // fall through and re-execute — quota was never consumed for it.
    // The user row already exists: skip the insert below (unique guard).
    userRowPersisted = true;
  }

  // Thread cap 200 (before quota: 409 consumes nothing).
  const { data: counted } = (await ctx.db
    .from("assistant_messages")
    .select("id")
    .eq("conversation_id", conversation.id)) as unknown as {
    data: unknown[] | null;
  };
  if ((counted ?? []).length >= THREAD_CAP) {
    return json(
      { error: "Conversation is full — start a new chat", code: "CONVERSATION_FULL" },
      409
    );
  }

  // 5. quota consume (fail-closed on RPC error → 429)
  const quotaMax = ctx.quotaMax || getDailyQuota();
  let quota;
  try {
    quota = await consumeOne(ctx.admin, ctx.userId, quotaMax);
  } catch {
    return json(
      { error: "Quota check unavailable. Try again shortly.", code: "QUOTA_UNAVAILABLE", retryAfter: 60 },
      429,
      60
    );
  }
  if (!quota.allowed) {
    const retryAfter = secondsToUtcMidnight(nowMs);
    return json(
      {
        error: "انتهت حصتك اليومية من المحادثة — جدد غدا أو راجع الخطط",
        code: "ASSISTANT_QUOTA_EXHAUSTED",
        retryAfter,
        plans_url: "/plans?reason=assistant_quota",
      },
      402,
      retryAfter
    );
  }

  // Persist the user message (swept + redacted) — unless this is a retry
  // of an undelivered turn whose row is already stored (see above).
  const safeMessage = redactPii(sanitizeForPrompt(message));
  if (!userRowPersisted) {
    await ctx.db.from("assistant_messages").insert({
      id: crypto.randomUUID(),
      conversation_id: conversation.id,
      client_message_id,
      role: "user",
      content: safeMessage.slice(0, REPLY_MAX),
    });
  }
  void isNew;

  // 6. grounding: compiled memory context + owned startups + last turns.
  const grounding = ctx.grounding ?? (await defaultGrounding(ctx.userId, ctx.db));
  const tools = ctx.tools ?? defaultTools(ctx.db);
  const compiled = await grounding.compiled(ctx.userId, message).catch(() => "");
  const startups = await grounding.startups(ctx.userId).catch(() => []);
  const { data: historyRows } = (await ctx.db
    .from("assistant_messages")
    .select("role,content")
    .eq("conversation_id", conversation.id)
    .order("seq", { ascending: true })) as unknown as {
    data: Array<{ role: string; content: string }> | null;
  };
  const history = (historyRows ?? [])
    .filter((r) => r.role === "user" || r.role === "assistant")
    .slice(-HISTORY_TURNS)
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
  const startupBrief = startups
    .map((s) => {
      const order = resolveOrder(
        s.stage_track ?? null,
        (s.stage_order ?? null) as Array<{ key: string; label: string }> | null,
      );
      const pos = stagePosition(order, s.stage ?? "idea");
      const position = pos >= 0 ? ` stage ${pos + 1}/${order.length}` : "";
      return `- ${s.name} (${s.stage ?? "idea"}${position}): ${s.one_liner ?? ""} [startup:${s.id}]`;
    })
    .join("\n");
  const context = `Startups:\n${startupBrief}\n\nMemory:\n${compiled}`;

  // 7. model call; total pre-dispatch outage → refund + SSE error.
  let turn;
  try {
    turn = await modelCaller({
      systemPrompt: systemPrompt(effectiveLocale),
      context: `${context}\n\nUser message (untrusted): ${safeMessage}`,
      history,
      message: safeMessage,
    });
  } catch (err) {
    if (err instanceof AssistantOutageError) {
      try {
        await refundOne(ctx.admin, ctx.userId);
      } catch {
        // best-effort refund
      }
      try {
        await spend(`assistant:${ctx.userId}`, 0).catch(() => {});
      } catch {
        // never break the error event
      }
      return sse([
        {
          type: "error",
          code: "MODEL_UNAVAILABLE",
          message: "AI providers temporarily unavailable. Please retry shortly.",
          retryAfter: 60,
        },
      ]);
    }
    throw err;
  }

  // 8. execute tool calls sequentially (failures → inline cards, no extra quota).
  const toolEvents: unknown[] = [];
  for (const tc of turn.toolCalls as AssistantToolCall[]) {
    // Redacted once, reused for the trace payload, the persisted row, and
    // the SSE event (spec §5 requires `args` on tool events).
    const safeArgs = JSON.parse(redactPii(JSON.stringify(tc.args)));
    await traceTool(ctx.admin, "tool_call", { tool: tc.name, args: safeArgs });
    try {
      let summary = "";
      let url: string | undefined;
      if (tc.name === "save_memory") {
        const { id } = await tools.saveMemory(ctx.userId, {
          kind: tc.args.kind as string,
          value: tc.args.value as string,
          startup_id: tc.args.startup_id as string | undefined,
        });
        summary = `Saved to memory (${id})`;
      } else if (tc.name === "create_experiment") {
        const { id } = await tools.createExperiment(ctx.userId, tc.args);
        summary = `Experiment created (${id})`;
      } else if (tc.name === "update_experiment") {
        const { id } = await tools.updateExperiment(ctx.userId, tc.args);
        summary = `Experiment updated (${id})`;
      } else if (tc.name === "run_validation") {
        const { startup_id } = await tools.runValidation(ctx.userId, {
          idea: tc.args.idea as string,
          uploaded_data: tc.args.uploaded_data,
        });
        url = `/validate?startup_id=${startup_id}`;
        summary = `Validation session started`;
      } else {
        const sid = tc.args.startup_id as string;
        url = `/validate?startup_id=${sid}`;
        summary = `Opening project`;
      }
      await traceTool(ctx.admin, "tool_result", { tool: tc.name, ok: true });
      const safeSummary = redactPii(summary).slice(0, 2000);
      await ctx.db.from("assistant_messages").insert({
        id: crypto.randomUUID(),
        conversation_id: conversation.id,
        client_message_id: crypto.randomUUID(),
        role: "tool",
        content: safeSummary,
        tool_name: tc.name,
        tool_args: safeArgs,
      });
      toolEvents.push({
        type: "tool",
        tool: tc.name,
        args: safeArgs,
        result_summary: safeSummary,
        ...(url ? { url } : {}),
      });
    } catch (toolErr) {
      const msg = toolErr instanceof Error ? toolErr.message : String(toolErr);
      await traceTool(ctx.admin, "tool_result", { tool: tc.name, ok: false, error: msg });
      const summary = `Action failed: ${msg.slice(0, 500)} — you can retry this action.`;
      await ctx.db.from("assistant_messages").insert({
        id: crypto.randomUUID(),
        conversation_id: conversation.id,
        client_message_id: crypto.randomUUID(),
        role: "tool",
        content: summary,
        tool_name: tc.name,
        tool_args: JSON.parse(JSON.stringify(redactPii(JSON.stringify(tc.args)))),
      });
      toolEvents.push({ type: "tool", tool: tc.name, result_summary: summary, error: true });
    }
  }

  // 9. verifier-as-critic rescan; flagged draft → refusal + trace row.
  // URL support covers evidence rows; startup/memory claims ride the
  // owned-row path in criticScan (token overlap + number containment), so
  // the startup claim carries stage + position ordinal text too — otherwise
  // a grounded "(1/4)" is unmatchable (live regression 2026-10-09).
  let reply = turn.reply;
  const adapted = adaptCitedRows([
    ...(await ownedStartupRows(ctx)).map((claim) => ({ claim })),
    ...(await ownedEvidenceRows(ctx)),
    ...(await ownedMemoryRows(ctx)),
  ]);
  const verdict = criticScan(reply, adapted);
  if (verdict.blocked) {
    reply = refusalFor(effectiveLocale);
    await traceTool(ctx.admin, "tool_result", {
      critic: "blocked",
      unsupported: verdict.unsupported.slice(0, 10),
    });
  }
  const citations = (Array.isArray(turn.citations) ? turn.citations : [])
    .filter(
      (c) =>
        c &&
        CITATION_KINDS.has(c.kind) &&
        UUID.safeParse(c.id).success &&
        typeof c.label === "string"
    )
    .map((c) => ({ kind: c.kind, id: c.id, label: c.label.slice(0, 200) }));
  await persistAssistantTurn(ctx.db, conversation.id, reply, citations);

  // Spend ledger (success AND partial — best-effort, never breaks the stream).
  const totalTokens = (turn.usage ?? []).reduce(
    (sum, u) => sum + (u.totalTokenCount ?? 0),
    0
  );
  try {
    await spend(
      `assistant:${ctx.userId}`,
      extractUsageCost(
        totalTokens > 0 ? { totalTokenCount: totalTokens } : undefined,
        "gemini_call"
      )
    );
  } catch {
    // best-effort only
  }

  return sse([
    ...chunk(reply).map((text) => ({ type: "token", text })),
    ...toolEvents,
    { type: "done", conversation_id: conversation.id, citations, deduped: false },
  ]);
}

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Quota snapshot for the list endpoint (F17: visible on load). Reads the
// service-role table directly — assistant_quota has zero public policies,
// so the user-scoped client (RLS) can never see it. Fail-open with used=0:
// worst case the bar under-reports until the first answer lands.
async function readQuotaToday(
  ctx: AssistantHttpContext
): Promise<{ used: number; quota: number }> {
  const quota = ctx.quotaMax || getDailyQuota();
  try {
    const { data } = (await ctx.admin
      .from("assistant_quota")
      .select("day,used_count")
      .eq("user_id", ctx.userId)
      .order("day", { ascending: false })
      .limit(1)
      .maybeSingle()) as unknown as {
      data: { day: string; used_count: number } | null;
    };
    const today = new Date().toISOString().slice(0, 10);
    const used =
      data && data.day === today && Number.isFinite(data.used_count)
        ? data.used_count
        : 0;
    return { used, quota };
  } catch {
    return { used: 0, quota };
  }
}

export async function handleListConversations(
  ctx: AssistantHttpContext,
  query: unknown
): Promise<Response> {
  const parsed = pageSchema.safeParse(query ?? {});
  if (!parsed.success) return json({ error: "Invalid query", code: "INVALID" }, 400);
  const { page, limit } = parsed.data;
  const { data } = (await ctx.db
    .from("assistant_conversations")
    .select("id,title,updated_at")
    .eq("user_id", ctx.userId)
    .order("updated_at", { ascending: false })) as unknown as {
    data: Array<{ id: string; title: string; updated_at: string }> | null;
  };
  const rows = data ?? [];
  const total = rows.length;
  const pageRows = rows.slice((page - 1) * limit, page * limit);
  const ids = pageRows.map((r) => r.id);
  let counts = new Map<string, number>();
  if (ids.length > 0) {
    const { data: msgs } = (await ctx.db
      .from("assistant_messages")
      .select("conversation_id")
      .in("conversation_id", ids)) as unknown as {
      data: Array<{ conversation_id: string }> | null;
    };
    counts = new Map<string, number>();
    for (const m of msgs ?? []) {
      counts.set(m.conversation_id, (counts.get(m.conversation_id) ?? 0) + 1);
    }
  }
  return json(
    {
      conversations: pageRows.map((r) => ({
        id: r.id,
        title: r.title,
        updated_at: r.updated_at,
        message_count: counts.get(r.id) ?? 0,
      })),
      meta: { page, limit, pages: Math.max(1, Math.ceil(total / limit)) },
      quota: await readQuotaToday(ctx),
    },
    200
  );
}

const messagesQuerySchema = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function handleGetMessages(
  ctx: AssistantHttpContext,
  id: string,
  query: unknown
): Promise<Response> {
  if (!UUID.safeParse(id).success) return json({ error: "Invalid id", code: "INVALID" }, 400);
  const conversation = await getOwnedConversation(ctx.db, ctx.userId, id);
  if (!conversation) return json({ error: "Forbidden", code: "FORBIDDEN" }, 403);
  const parsed = messagesQuerySchema.safeParse(query ?? {});
  if (!parsed.success) return json({ error: "Invalid query", code: "INVALID" }, 400);
  const { before, limit } = parsed.data;
  let q = ctx.db
    .from("assistant_messages")
    .select("id,role,content,tool_name,tool_args,citations,created_at")
    .eq("conversation_id", id)
    .order("seq", { ascending: true });
  if (before) q = q.lt("created_at", before);
  const { data } = (await q.limit(limit + 1)) as unknown as {
    data: Row[] | null;
  };
  const rows = data ?? [];
  const has_more = rows.length > limit;
  return json({ messages: rows.slice(0, limit), has_more }, 200);
}

const titleSchema = z.object({ title: z.string().min(1).max(200) });

export async function handleRenameConversation(
  ctx: AssistantHttpContext,
  id: string,
  rawBody: unknown
): Promise<Response> {
  if (!UUID.safeParse(id).success) return json({ error: "Invalid id", code: "INVALID" }, 400);
  const conversation = await getOwnedConversation(ctx.db, ctx.userId, id);
  if (!conversation) return json({ error: "Forbidden", code: "FORBIDDEN" }, 403);
  const parsed = titleSchema.safeParse(rawBody);
  if (!parsed.success) return json({ error: "Invalid title", code: "INVALID" }, 400);
  await ctx.db
    .from("assistant_conversations")
    .update({ title: parsed.data.title, updated_at: new Date((ctx.nowMs ?? Date.now)()).toISOString() })
    .eq("id", id);
  return json({ id, title: parsed.data.title }, 200);
}

export async function handleDeleteConversation(
  ctx: AssistantHttpContext,
  id: string
): Promise<Response> {
  if (!UUID.safeParse(id).success) return json({ error: "Invalid id", code: "INVALID" }, 400);
  const conversation = await getOwnedConversation(ctx.db, ctx.userId, id);
  if (!conversation) return json({ error: "Forbidden", code: "FORBIDDEN" }, 403);
  await ctx.db.from("assistant_conversations").delete().eq("id", id);
  return json({ id, deleted: true }, 200);
}

export async function handleGetPrefs(ctx: AssistantHttpContext): Promise<Response> {  const { data } = await ctx.db
    .from("assistant_prefs")
    .select("float_enabled,active_conversation_id")
    .eq("user_id", ctx.userId)
    .maybeSingle();
  const row = (data as unknown as {
    float_enabled: boolean;
    active_conversation_id: string | null;
  } | null) ?? { float_enabled: false, active_conversation_id: null };
  return json(
    { float_enabled: row.float_enabled, active_conversation_id: row.active_conversation_id },
    200
  );
}

const prefsSchema = z.object({
  float_enabled: z.boolean(),
  active_conversation_id: UUID.nullable().optional(),
});

export async function handlePutPrefs(
  ctx: AssistantHttpContext,
  rawBody: unknown
): Promise<Response> {
  const parsed = prefsSchema.safeParse(rawBody);
  if (!parsed.success) return json({ error: "Invalid prefs", code: "INVALID" }, 400);
  const { float_enabled, active_conversation_id } = parsed.data;
  // An omitted active_conversation_id preserves the stored value — a plain
  // upsert would otherwise null out the pinned thread on float-only writes.
  let activeId: string | null = active_conversation_id ?? null;
  if (active_conversation_id === undefined) {
    const { data: current } = await ctx.db
      .from("assistant_prefs")
      .select("active_conversation_id")
      .eq("user_id", ctx.userId)
      .maybeSingle();
    activeId =
      (current as unknown as { active_conversation_id: string | null } | null)
        ?.active_conversation_id ?? null;
  } else if (active_conversation_id) {
    const owned = await getOwnedConversation(ctx.db, ctx.userId, active_conversation_id);
    if (!owned) return json({ error: "Forbidden", code: "FORBIDDEN" }, 403);
  }
  await ctx.db.from("assistant_prefs").upsert({
    user_id: ctx.userId,
    float_enabled,
    active_conversation_id: activeId,
    updated_at: new Date((ctx.nowMs ?? Date.now)()).toISOString(),
  });
  // Select-after-write: prove the row landed and echo stored state.
  const { data: stored } = await ctx.db
    .from("assistant_prefs")
    .select("float_enabled,active_conversation_id")
    .eq("user_id", ctx.userId)
    .maybeSingle();
  const row = (stored as unknown as {
    float_enabled: boolean;
    active_conversation_id: string | null;
  } | null) ?? { float_enabled, active_conversation_id: activeId };
  return json(
    { float_enabled: row.float_enabled, active_conversation_id: row.active_conversation_id },
    200
  );
}

// Route-layer helper: read the caller's entitlement via the service-role
// client (user_entitlements has no RLS read policies � agent/route.ts:1904).
// Fail-closed: unreadable entitlement throws (routes map to 429).
export async function resolveEntitlementFor(
  admin: SupabaseClient,
  userId: string
): Promise<EntitlementStatus | null> {
  const { data, error } = await admin
    .from("user_entitlements")
    .select("status")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  const status = (data as unknown as { status?: unknown } | null)?.status;
  return typeof status === "string" ? (status as EntitlementStatus) : "legacy";
}

