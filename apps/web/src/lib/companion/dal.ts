import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAgentGate, type EntitlementStatus } from "@/lib/entitlements";
import { compileContext, type MemoryRow } from "./ranker";
import { normalizeForMatch } from "./normalize";
import { companionCtxKey, redisDel, redisGet, redisSetex } from "./redis";
import {
  decideActionSchema,
  memoryIdSchema,
  memoryKindSchema,
  memoryStartupIdSchema,
  memoryValueSchema,
  statusFilterSchema,
  type DecideActionInput,
  type StatusFilterInput,
} from "./validation";

export type CompanionCode =
  | "OK"
  | "NOT_AUTHENTICATED"
  | "FORBIDDEN"
  | "INVALID"
  | "NOT_FOUND"
  | "MEMORY_FULL"
  | "MEMORY_DUPLICATE"
  | "STARTUP_NOT_OWNED"
  | "TRIAL_CONSUMED"
  | "ACCOUNT_PAUSED"
  | "SUBSCRIPTION_REQUIRED";

export class CompanionError extends Error {
  code: CompanionCode;
  constructor(code: CompanionCode, message?: string) {
    super(message ?? code);
    this.name = "CompanionError";
    this.code = code;
  }
}

export interface ProposeRow {
  kind: string;
  value: string;
  confidence: number | null;
  source_ref?: string;
  startup_id?: string | null;
}

export interface ProposeResult {
  results: Array<{ index: number; ok: boolean; code: string; id?: string }>;
  dropped: string[];
}

export interface MemoryCursor {
  created_at: string;
  id: string;
}

export interface CompanionDeps {
  userClient(): Promise<SupabaseClient>;
  getEntitlementStatus(userId: string): Promise<EntitlementStatus | null>;
  redisGet(key: string): Promise<string | null>;
  redisSetex(key: string, ttlSec: number, value: string): Promise<void>;
  redisDel(key: string): Promise<void>;
  nowMs(): number;
}

async function defaultDeps(): Promise<CompanionDeps> {
  // Lazy server clients: unit tests always inject deps, so importing
  // next/headers-bound modules here keeps the static graph test-safe.
  const { createServerSupabaseClient, createServiceRoleClient } = await import(
    "@/lib/supabase/server"
  );
  const service = createServiceRoleClient();
  return {
    userClient: () => createServerSupabaseClient(),
    // Same service-role user_entitlements read as the agent route (~1877).
    // Missing row stays null (→ SUBSCRIPTION_REQUIRED), never legacy.
    getEntitlementStatus: async (userId: string) => {
      const { data, error } = await service
        .from("user_entitlements")
        .select("status")
        .eq("user_id", userId)
        .maybeSingle();
      if (error || !data) return null;
      return (data as { status: unknown }).status as EntitlementStatus;
    },
    redisGet,
    redisSetex,
    redisDel,
    nowMs: () => Date.now(),
  };
}

async function depsWith(over?: Partial<CompanionDeps>): Promise<CompanionDeps> {
  // Fully-injected deps (unit tests) resolve with ZERO production imports —
  // defaultDeps() eagerly builds a service client, so never call it then.
  const partial = over as Partial<CompanionDeps> | undefined;
  if (
    partial?.userClient &&
    partial?.getEntitlementStatus &&
    partial?.redisGet &&
    partial?.redisSetex &&
    partial?.redisDel &&
    partial?.nowMs
  ) {
    return over as CompanionDeps;
  }
  return { ...(await defaultDeps()), ...over };
}

// Reads (list/profile/context) are allowed wherever the queue is visible:
// trial_consumed included, paused/unknown denied.
function throwIfDeniedForList(status: EntitlementStatus | null): void {
  if (status === "trial_consumed") return;
  const g = resolveAgentGate(status);
  if (!g.allowed) throw new CompanionError(g.code);
}

// Writes (decide/forget/toggle/manual/propose) follow the agent gate exactly.
function throwIfDeniedForWrite(status: EntitlementStatus | null): void {
  const g = resolveAgentGate(status);
  if (!g.allowed) throw new CompanionError(g.code);
}

function isMissingTableError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === "PGRST205") return true;
  const msg = err.message ?? "";
  return /relation .* does not exist/i.test(msg) || /schema cache/i.test(msg);
}

function throwIfRpcDenied(envelope: { ok: boolean; code: string }): void {
  if (!envelope.ok) throw new CompanionError(envelope.code as CompanionCode);
}

export interface CompanionProfile {
  user_id: string;
  memory_enabled: boolean;
}

export async function getCompanionProfile(
  userId: string,
  over?: Partial<CompanionDeps>,
): Promise<CompanionProfile> {
  const d = await depsWith(over);
  throwIfDeniedForList(await d.getEntitlementStatus(userId));
  const client = await d.userClient();
  const { data, error } = await client
    .from("companion_profile")
    .select("user_id, memory_enabled")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    // Pre-0011 database: behave as enabled until the ledger exists (M6).
    if (isMissingTableError(error as { code?: string; message?: string })) {
      console.warn("[companion] companion_profile missing, defaulting enabled");
      return { user_id: userId, memory_enabled: true };
    }
    throw error;
  }
  if (!data) {
    // Lazy profile: insert-or-ignore (0010:109 guard idiom), default enabled.
    await client.from("companion_profile").upsert(
      { user_id: userId },
      { onConflict: "user_id", ignoreDuplicates: true },
    );
    return { user_id: userId, memory_enabled: true };
  }
  return data as CompanionProfile;
}

export async function listMemories(
  userId: string,
  status: StatusFilterInput,
  limit: number,
  cursor?: MemoryCursor,
  over?: Partial<CompanionDeps>,
): Promise<{ rows: MemoryRow[]; nextCursor: MemoryCursor | null }> {
  const d = await depsWith(over);
  const safeStatus = statusFilterSchema.parse(status);
  const safeLimit = Math.min(Math.max(Math.floor(limit) || 20, 1), 100);
  throwIfDeniedForList(await d.getEntitlementStatus(userId));
  const client = await d.userClient();
  // `all` ≡ pending + approved — rejected is NEVER surfaced (H10).
  let q = client.from("companion_memory").select("*").eq("user_id", userId);
  q = (
    safeStatus === "all" ? q.in("status", ["pending", "approved"]) : q.eq("status", safeStatus)
  ) as typeof q;
  q = q.order("created_at", { ascending: false }).order("id", { ascending: false });
  if (cursor) {
    q = q.or(
      `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`,
    );
  }
  const { data, error } = await q.limit(safeLimit + 1);
  if (error) throw error;
  const rows = (data ?? []) as MemoryRow[];
  const page = rows.slice(0, safeLimit);
  const nextCursor =
    rows.length > safeLimit
      ? { created_at: page[page.length - 1].created_at, id: page[page.length - 1].id }
      : null;
  return { rows: page, nextCursor };
}

export async function createManualMemory(
  userId: string,
  input: { kind: string; value: string; startup_id?: string | null },
  over?: Partial<CompanionDeps>,
): Promise<{ id: string }> {
  const d = await depsWith(over);
  throwIfDeniedForWrite(await d.getEntitlementStatus(userId));
  const kind = memoryKindSchema.parse(input.kind);
  const value = memoryValueSchema.parse(input.value);
  const startup_id = memoryStartupIdSchema.parse(input.startup_id ?? null) ?? null;
  const client = await d.userClient();
  // App-level normalized-dupe pre-check with the full normalizer (the RPC is
  // only the race backstop).
  const want = normalizeForMatch(value).join(" ");
  const { data: approved, error: listError } = await client
    .from("companion_memory")
    .select("value")
    .eq("user_id", userId)
    .eq("status", "approved");
  if (listError) throw listError;
  for (const row of (approved ?? []) as Array<{ value: string }>) {
    if (normalizeForMatch(row.value).join(" ") === want) {
      throw new CompanionError("MEMORY_DUPLICATE");
    }
  }
  const { data, error } = await client.rpc("propose_memories", {
    p_user_id: userId,
    p_rows: [{ kind, value, confidence: null, source_ref: "manual", startup_id }],
  });
  if (error) throw error;
  const envelope = data as { ok: boolean; code: string; results?: ProposeResult["results"] };
  throwIfRpcDenied(envelope);
  const first = envelope.results?.[0];
  if (!first?.ok) throw new CompanionError((first?.code ?? "INVALID") as CompanionCode);
  if (typeof first.id !== "string" || first.id.length === 0)
    throw new CompanionError("INVALID");
  // Spec §8: human-entered rows are APPROVED inline (confidence NULL), never
  // left pending. Composed propose → decide through the named RPCs only
  // (single-writer rule); decideMemory also purges the ctx cache. If the
  // approve step fails (e.g. MEMORY_FULL at the 200 cap) the pending row
  // stays visible in the queue — surfaced, never silent.
  const id = first.id as string;
  await decideMemory(userId, id, "approve", undefined, d);
  return { id };
}

export async function decideMemory(
  userId: string,
  id: string,
  action: DecideActionInput,
  value?: string,
  over?: Partial<CompanionDeps>,
): Promise<MemoryRow> {
  const d = await depsWith(over);
  throwIfDeniedForWrite(await d.getEntitlementStatus(userId));
  const safeId = memoryIdSchema.parse(id);
  const safeAction = decideActionSchema.parse(action);
  const safeValue = value === undefined ? null : memoryValueSchema.parse(value);
  const client = await d.userClient();
  const { data, error } = await client.rpc("decide_memory", {
    p_user_id: userId,
    p_id: safeId,
    p_action: safeAction,
    p_value: safeValue,
  });
  if (error) throw error;
  const envelope = data as { ok: boolean; code: string; row?: MemoryRow };
  throwIfRpcDenied(envelope);
  await d.redisDel(companionCtxKey(userId));
  return envelope.row as MemoryRow;
}

export async function forgetMemory(
  userId: string,
  id: string,
  over?: Partial<CompanionDeps>,
): Promise<void> {
  const d = await depsWith(over);
  throwIfDeniedForWrite(await d.getEntitlementStatus(userId));
  const safeId = memoryIdSchema.parse(id);
  const client = await d.userClient();
  const { data, error } = await client
    .from("companion_memory")
    .delete()
    .eq("id", safeId)
    .eq("user_id", userId)
    .select("id");
  if (error) throw error;
  if (!data || (data as unknown[]).length === 0) throw new CompanionError("NOT_FOUND");
  await d.redisDel(companionCtxKey(userId));
}

export async function setMemoryEnabled(
  userId: string,
  enabled: boolean,
  over?: Partial<CompanionDeps>,
): Promise<CompanionProfile> {
  const d = await depsWith(over);
  throwIfDeniedForWrite(await d.getEntitlementStatus(userId));
  const client = await d.userClient();
  const { data, error } = await client
    .from("companion_profile")
    .upsert(
      { user_id: userId, memory_enabled: enabled, updated_at: new Date(d.nowMs()).toISOString() },
      { onConflict: "user_id" },
    )
    .select("user_id, memory_enabled")
    .maybeSingle();
  if (error) throw error;
  await d.redisDel(companionCtxKey(userId));
  return (data ?? { user_id: userId, memory_enabled: enabled }) as CompanionProfile;
}

export async function getCompiledContext(
  userId: string,
  query: string,
  over?: Partial<CompanionDeps>,
): Promise<string> {
  const d = await depsWith(over);
  const profile = await getCompanionProfile(userId, d);
  // Disabled → "" with NO Redis touch (Review-Focus #3).
  if (!profile.memory_enabled) return "";
  const key = companionCtxKey(userId);
  try {
    const hit = await d.redisGet(key);
    if (typeof hit === "string" && hit.length > 0) return hit;
  } catch {
    // Redis outage at DAL level: fall through to Postgres (Review-Focus #4).
  }
  const client = await d.userClient();
  const { data, error } = await client
    .from("companion_memory")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "approved")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    if (isMissingTableError(error as { code?: string; message?: string })) {
      console.warn("[companion] companion_memory missing, injecting nothing");
      return "";
    }
    throw error;
  }
  const block = compileContext((data ?? []) as MemoryRow[], query, d.nowMs());
  try {
    await d.redisSetex(key, 3600, block);
  } catch {
    // Best-effort cache write; the block itself is already compiled.
  }
  return block;
}

export async function proposeMemories(
  userId: string,
  rows: ProposeRow[],
  over?: Partial<CompanionDeps>,
): Promise<ProposeResult> {
  const d = await depsWith(over);
  throwIfDeniedForWrite(await d.getEntitlementStatus(userId));
  const client = await d.userClient();
  const { data, error } = await client.rpc("propose_memories", { p_user_id: userId, p_rows: rows });
  if (error) throw error;
  const envelope = data as { ok: boolean; code: string } & ProposeResult;
  throwIfRpcDenied(envelope);
  return { results: envelope.results ?? [], dropped: envelope.dropped ?? [] };
}

export async function purgeCompanionCache(
  userId: string,
  over?: Partial<CompanionDeps>,
): Promise<void> {
  const d = await depsWith(over);
  await d.redisDel(companionCtxKey(userId));
}
