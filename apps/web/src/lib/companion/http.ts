// HTTP orchestration for the companion API routes (Task 7, spec §8).
// Deliberately NO `server-only` import: auth, rate-limit, and DAL access all
// arrive via the injected CompanionHttpContext, so companion-api.test.ts
// imports this module directly with fully-fake deps.
import { ZodError } from "zod";
import {
  CompanionError,
  createManualMemory,
  decideMemory,
  forgetMemory,
  getCompanionProfile,
  listMemories,
  setMemoryEnabled,
  type CompanionDeps,
  type MemoryCursor,
} from "./dal";
import { flagPossibleConflicts } from "./ranker";
import type { MemoryRow } from "./ranker";
import { MEMORY_COPY } from "./copy";
import {
  decideActionSchema,
  memoryIdSchema,
  memoryKindSchema,
  memoryStartupIdSchema,
  memoryValueSchema,
  statusFilterSchema,
} from "./validation";

export interface CompanionHttpContext {
  getUser(): Promise<{ id: string } | null>;
  checkRate(key: string): Promise<{ limited: boolean; retryAfter: number }>;
  dalOver?: Partial<CompanionDeps>;
}

export const COMPANION_RATE_LIMIT = 30;
export const COMPANION_RATE_WINDOW_MS = 60_000;

export function companionRateKey(userId: string): string {
  return `mem:${userId}`;
}

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function unauth(): Response {
  return json(401, { error: "unauthorized", code: "UNAUTHORIZED" });
}

function invalid(): Response {
  return json(422, { error: "invalid input", code: "INVALID" });
}

function rateLimited(retryAfter: number): Response {
  return json(
    429,
    { error: "Rate limit exceeded. Try again shortly.", retryAfter },
    { "Retry-After": String(retryAfter) },
  );
}

function gate402(code: string, error: string): Response {
  return json(402, { error, code, plans_url: "/plans" });
}

function mapCompanionError(e: CompanionError): Response {
  switch (e.code) {
    case "NOT_AUTHENTICATED":
      return unauth();
    case "FORBIDDEN":
      return json(403, { error: "forbidden", code: "FORBIDDEN" });
    case "INVALID":
      return invalid();
    case "STARTUP_NOT_OWNED":
      return json(422, { error: MEMORY_COPY.startup_not_owned, code: "STARTUP_NOT_OWNED" });
    case "NOT_FOUND":
      // Advisory only: the rows a client holds that vanish are TTL-archived
      // rejects; the hint is identical for never-existed ids (no oracle).
      return json(404, { error: "not found", code: "NOT_FOUND", hint: "likely-archived" });
    case "MEMORY_FULL":
      return json(409, { error: MEMORY_COPY.memory_full, code: "MEMORY_FULL" });
    case "MEMORY_DUPLICATE":
      return json(409, { error: MEMORY_COPY.memory_duplicate, code: "MEMORY_DUPLICATE" });
    case "SECRET_BLOCKED":
      return json(422, { error: MEMORY_COPY.secret_blocked, code: "SECRET_BLOCKED" });
    case "TRIAL_CONSUMED":
      return gate402(e.code, "trial consumed");
    case "ACCOUNT_PAUSED":
      return gate402(e.code, "account paused");
    case "SUBSCRIPTION_REQUIRED":
      return gate402(e.code, "subscription required");
    default:
      return json(500, { error: "internal error", code: "INTERNAL" });
  }
}

function mapError(handler: string, e: unknown): Response {
  if (e instanceof CompanionError) return mapCompanionError(e);
  if (e instanceof ZodError) return invalid();
  console.error(`[companion] ${handler} failed`, e);
  return json(500, { error: "internal error", code: "INTERNAL" });
}

// Spec §8 item shape: exactly these fields, nothing internal.
function toItem(r: MemoryRow): Record<string, unknown> {
  return {
    id: r.id,
    kind: r.kind,
    value: r.value,
    status: r.status ?? null,
    confidence: r.confidence ?? null,
    source_ref: r.source_ref ?? null,
    created_at: r.created_at,
  };
}

function decodeCursor(raw: string | null): MemoryCursor | undefined {
  if (raw === null || raw === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new CompanionError("INVALID");
  }
  if (typeof parsed !== "object" || parsed === null) throw new CompanionError("INVALID");
  const rec = parsed as Record<string, unknown>;
  // created_at must be a non-empty PARSEABLE timestamp: raw interpolation
  // into the PostgREST .or() filter otherwise (review minor).
  if (typeof rec.created_at !== "string" || rec.created_at.length === 0) {
    throw new CompanionError("INVALID");
  }
  if (Number.isNaN(Date.parse(rec.created_at))) throw new CompanionError("INVALID");
  const id = memoryIdSchema.safeParse(rec.id);
  if (!id.success) throw new CompanionError("INVALID");
  return { created_at: rec.created_at, id: id.data };
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new CompanionError("INVALID");
  }
  if (typeof raw !== "object" || raw === null) throw new CompanionError("INVALID");
  return raw as Record<string, unknown>;
}

export async function handleListCompanionMemories(
  req: Request,
  ctx: CompanionHttpContext,
): Promise<Response> {
  const user = await ctx.getUser();
  if (!user) return unauth();
  let cursor: MemoryCursor | undefined;
  let limit = 20;
  let statusRaw: unknown = "all";
  try {
    const url = new URL(req.url);
    statusRaw = url.searchParams.get("status") ?? "all";
    if (!statusFilterSchema.safeParse(statusRaw).success) throw new CompanionError("INVALID");
    const rawLimit = url.searchParams.get("limit");
    if (rawLimit !== null) {
      if (!/^\d+$/.test(rawLimit)) throw new CompanionError("INVALID");
      limit = Number(rawLimit);
      if (limit < 1 || limit > 100) throw new CompanionError("INVALID");
    }
    cursor = decodeCursor(url.searchParams.get("cursor"));
  } catch (e) {
    if (e instanceof CompanionError) return mapCompanionError(e);
    return invalid();
  }
  const rate = await ctx.checkRate(companionRateKey(user.id));
  if (rate.limited) return rateLimited(rate.retryAfter);
  try {
    const status = statusRaw as "pending" | "approved" | "rejected" | "all";
    const { rows, nextCursor } = await listMemories(user.id, status, limit, cursor, ctx.dalOver);
    // Opaque cursor: base64url-encoded here, decoded by decodeCursor above.
    // The raw {created_at,id} object must never leave the server — no client
    // can build a valid cursor from parts (review #6).
    const opaque =
      nextCursor === null
        ? null
        : Buffer.from(JSON.stringify(nextCursor), "utf8").toString("base64url");
    return json(200, { items: rows.map(toItem), nextCursor: opaque });
  } catch (e) {
    return mapError("list", e);
  }
}

export async function handleCreateCompanionMemory(
  req: Request,
  ctx: CompanionHttpContext,
): Promise<Response> {
  const user = await ctx.getUser();
  if (!user) return unauth();
  let kind: string;
  let value: string;
  let startup_id: string | null;
  try {
    const rec = await readJsonBody(req);
    if (!memoryKindSchema.safeParse(rec.kind).success) throw new CompanionError("INVALID");
    kind = rec.kind as string;
    if (typeof rec.value !== "string") throw new CompanionError("INVALID");
    const trimmed = rec.value.trim();
    if (!memoryValueSchema.safeParse(trimmed).success) throw new CompanionError("INVALID");
    value = trimmed;
    const sid = memoryStartupIdSchema.safeParse(rec.startup_id ?? null);
    if (!sid.success) throw new CompanionError("INVALID");
    startup_id = sid.data ?? null;
  } catch (e) {
    if (e instanceof CompanionError) return mapCompanionError(e);
    return invalid();
  }
  const rate = await ctx.checkRate(companionRateKey(user.id));
  if (rate.limited) return rateLimited(rate.retryAfter);
  try {
    const { id } = await createManualMemory(user.id, { kind, value, startup_id }, ctx.dalOver);
    return json(201, { id });
  } catch (e) {
    return mapError("create", e);
  }
}

export async function handleDecideCompanionMemory(
  req: Request,
  id: string,
  ctx: CompanionHttpContext,
): Promise<Response> {
  const user = await ctx.getUser();
  if (!user) return unauth();
  const idParse = memoryIdSchema.safeParse(id);
  if (!idParse.success) return invalid();
  let action: "approve" | "reject";
  let value: string | undefined;
  try {
    const rec = await readJsonBody(req);
    if (!decideActionSchema.safeParse(rec.action).success) throw new CompanionError("INVALID");
    action = rec.action as "approve" | "reject";
    if (rec.value !== undefined) {
      if (typeof rec.value !== "string") throw new CompanionError("INVALID");
      const trimmed = rec.value.trim();
      if (!memoryValueSchema.safeParse(trimmed).success) throw new CompanionError("INVALID");
      value = trimmed;
    }
  } catch (e) {
    if (e instanceof CompanionError) return mapCompanionError(e);
    return invalid();
  }
  const rate = await ctx.checkRate(companionRateKey(user.id));
  if (rate.limited) return rateLimited(rate.retryAfter);
  try {
    const out = await decideMemory(user.id, idParse.data, action, value, ctx.dalOver);
    const item = toItem(out);
    // Decide-and-edit approve: surface a conflicting approved id (if any) so
    // the ذكرياتي console can show the pair together (spec §5.3, no overwrite).
    // Best-effort: the decide already committed — a lookup outage must not
    // turn it into a 500; the row returns without the flag instead.
    if (action === "approve" && value !== undefined) {
      try {
        const approved = await listMemories(user.id, "approved", 200, undefined, ctx.dalOver);
        const others = approved.rows
          .filter((r) => r.id !== out.id)
          .map((r) => ({ id: r.id, kind: r.kind, value: r.value, created_at: r.created_at }));
        const flags = flagPossibleConflicts(
          [{ id: out.id, kind: out.kind, value: out.value, created_at: out.created_at }],
          others,
        );
        const hit = flags.get(0);
        if (hit) return json(200, { ...item, possible_conflict_with: hit });
      } catch (e) {
        console.warn("[companion] conflict lookup failed, returning row without flag", e);
      }
    }
    return json(200, item);
  } catch (e) {
    return mapError("decide", e);
  }
}

export async function handleDeleteCompanionMemory(
  _req: Request,
  id: string,
  ctx: CompanionHttpContext,
): Promise<Response> {
  const user = await ctx.getUser();
  if (!user) return unauth();
  const idParse = memoryIdSchema.safeParse(id);
  if (!idParse.success) return invalid();
  const rate = await ctx.checkRate(companionRateKey(user.id));
  if (rate.limited) return rateLimited(rate.retryAfter);
  try {
    await forgetMemory(user.id, idParse.data, ctx.dalOver);
    return json(200, { purged: true });
  } catch (e) {
    return mapError("delete", e);
  }
}

export async function handleGetCompanionProfile(
  _req: Request,
  ctx: CompanionHttpContext,
): Promise<Response> {
  const user = await ctx.getUser();
  if (!user) return unauth();
  const rate = await ctx.checkRate(companionRateKey(user.id));
  if (rate.limited) return rateLimited(rate.retryAfter);
  try {
    const p = await getCompanionProfile(user.id, ctx.dalOver);
    return json(200, { user_id: p.user_id, memory_enabled: p.memory_enabled });
  } catch (e) {
    return mapError("profile", e);
  }
}

export async function handleToggleCompanionProfile(
  req: Request,
  ctx: CompanionHttpContext,
): Promise<Response> {
  const user = await ctx.getUser();
  if (!user) return unauth();
  let enabled: boolean;
  try {
    const rec = await readJsonBody(req);
    if (typeof rec.memory_enabled !== "boolean") throw new CompanionError("INVALID");
    enabled = rec.memory_enabled;
  } catch (e) {
    if (e instanceof CompanionError) return mapCompanionError(e);
    return invalid();
  }
  const rate = await ctx.checkRate(companionRateKey(user.id));
  if (rate.limited) return rateLimited(rate.retryAfter);
  try {
    const p = await setMemoryEnabled(user.id, enabled, ctx.dalOver);
    return json(200, { user_id: p.user_id, memory_enabled: p.memory_enabled });
  } catch (e) {
    return mapError("toggle", e);
  }
}
