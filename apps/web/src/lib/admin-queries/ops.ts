import "server-only";
import {
  getPagination,
  parseAdminWindow,
  scopedAdminQuery,
} from "@/lib/admin";
import type { AdminQueryDeps } from "./shared";
import { BUDGET } from "@/lib/utils";

// Agent route cap (apps/web/src/lib/rate-limit.ts RATE_MAX, distributed
// sliding-window 10 req/min) — echoed as a read-only reference.
const AGENT_REQUESTS_PER_MINUTE = 10;
const TRACE_CAP = 10000;
const SETTINGS_CAP = 200;
const AUDIT_COLUMNS =
  "id,actor,action,target,reason,diff,workspace_id,result,created_at";
const WORKSPACE_FETCH_CAP = 1000;
// Invite token deliberately excluded — credential-equivalent.
const PENDING_COLUMNS =
  "id,workspace_id,email,role,status,expires_at,invited_by,created_at";
const PENDING_CAP = 1000;

const ROLE_RANK: Record<string, number> = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
};

export interface OpsWindow {
  preset: string;
  from: string;
  to: string;
  days: number;
}

export interface OpsLimitsResult {
  window: OpsWindow;
  severity: { error: number; warning: number; info: number };
  errorsByActor: Record<string, number>;
  rateLimited429: number;
  configured: {
    maxCostUsd: number;
    maxToolCalls: number;
    hardTimeoutMs: number;
    agentRequestsPerMinute: number;
  };
  meta: {
    source: string;
    readOnly: boolean;
    tier: string;
    fetched_at: string;
  };
  truncated: boolean;
}

export interface OpsAuditInput {
  page: string | number | null;
  limit: string | number | null;
  actor: string | null;
  action: string | null;
}

export interface OpsAuditEntry {
  id: string;
  actor: string | null;
  action: string;
  target: unknown;
  reason: string | null;
  diff: unknown;
  workspace_id: string | null;
  result: string;
  created_at: string;
}

export interface OpsAuditResult {
  entries: OpsAuditEntry[];
  total: number;
  pages: number;
  page: number;
  limit: number;
  truncated?: boolean;
}

export interface AgentSettingsResult {
  settings: Record<string, { value: unknown; updated_at: string | null }>;
  meta: {
    source: string;
    readOnly: boolean;
    tier: string;
    fetched_at: string;
  };
  truncated: boolean;
}

export interface OpsPendingInvite {
  id: string;
  workspace_id: string;
  email: string;
  role: string;
  status: string;
  expires_at: string | null;
  invited_by: string | null;
  created_at: string;
}

export interface OpsEmailResult {
  pending: OpsPendingInvite[];
  total: number;
  truncated: boolean;
}

export interface OpsPlatformAdmin {
  user_id: string;
  email: string;
  granted_by: string | null;
  granted_at: string;
}

export interface OpsAdminsResult {
  admins: OpsPlatformAdmin[];
  total: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Structurally AdminError (name/status/code/message), like the errors
// thrown in packages/admin/scopedQuery.ts — normalize identically through
// toEnvelope() in routes and runAdminQuery, reproducing the exact
// { error, code } bodies the routes returned inline.
function structuralAdminError(
  status: number,
  code: string,
  message: string,
): Error & { status: number; code: string } {
  const err = new Error(message) as Error & { status: number; code: string };
  err.name = "AdminError";
  err.status = status;
  err.code = code;
  return err;
}

interface TraceRow {
  actor: string;
  event_type: string;
  payload: unknown;
}

function asTraceRows(value: unknown): TraceRow[] {
  if (!Array.isArray(value)) return [];
  const out: TraceRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    out.push({
      actor: typeof item["actor"] === "string" ? item["actor"] : "unknown",
      event_type:
        typeof item["event_type"] === "string"
          ? (item["event_type"] as string)
          : "",
      payload: item["payload"] ?? null,
    });
  }
  return out;
}

function isWarningEvent(row: TraceRow): boolean {
  if (row.event_type !== "verification") return false;
  if (!isRecord(row.payload)) return false;
  const warning = row.payload["warning"];
  const unsupported = row.payload["unsupported_count"];
  const claims = row.payload["unsupported_claims"];
  return (
    (typeof warning === "string" && warning.length > 0) ||
    (typeof unsupported === "number" && unsupported > 0) ||
    (Array.isArray(claims) && claims.length > 0)
  );
}

function mentionsRateLimit(payload: unknown): boolean {
  if (payload === null || payload === undefined) return false;
  const text =
    typeof payload === "string" ? payload : JSON.stringify(payload);
  return /429|rate.?limit/i.test(text);
}

function asAuditEntries(value: unknown): OpsAuditEntry[] {
  if (!Array.isArray(value)) return [];
  const out: OpsAuditEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (
      typeof item["id"] !== "string" ||
      typeof item["action"] !== "string" ||
      typeof item["created_at"] !== "string"
    ) {
      continue;
    }
    const actor = item["actor"];
    const reason = item["reason"];
    const ws = item["workspace_id"];
    const result = item["result"];
    out.push({
      id: item["id"] as string,
      actor: typeof actor === "string" ? actor : null,
      action: item["action"] as string,
      target: item["target"] ?? null,
      reason: typeof reason === "string" ? reason : null,
      diff: item["diff"] ?? null,
      workspace_id: typeof ws === "string" ? ws : null,
      result: typeof result === "string" ? result : "",
      created_at: item["created_at"] as string,
    });
  }
  return out;
}

function asPendingInvites(value: unknown): OpsPendingInvite[] {
  if (!Array.isArray(value)) return [];
  const out: OpsPendingInvite[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (
      typeof item["id"] !== "string" ||
      typeof item["workspace_id"] !== "string" ||
      typeof item["email"] !== "string" ||
      typeof item["created_at"] !== "string"
    ) {
      continue;
    }
    const expires = item["expires_at"];
    const invitedBy = item["invited_by"];
    out.push({
      id: item["id"] as string,
      workspace_id: item["workspace_id"] as string,
      email: item["email"] as string,
      role: typeof item["role"] === "string" ? item["role"] : "",
      status: typeof item["status"] === "string" ? item["status"] : "",
      expires_at: typeof expires === "string" ? expires : null,
      invited_by: typeof invitedBy === "string" ? invitedBy : null,
      created_at: item["created_at"] as string,
    });
  }
  return out;
}

function asAdminEntries(
  rows: unknown,
  emailByUser: Map<string, string>,
): OpsPlatformAdmin[] {
  if (!Array.isArray(rows)) return [];
  const out: OpsPlatformAdmin[] = [];
  for (const item of rows) {
    if (!isRecord(item) || typeof item["user_id"] !== "string") continue;
    const grantedBy = item["granted_by"];
    const grantedAt = item["granted_at"];
    const userId = item["user_id"] as string;
    out.push({
      user_id: userId,
      email: emailByUser.get(userId) ?? "",
      granted_by: typeof grantedBy === "string" ? grantedBy : null,
      granted_at: typeof grantedAt === "string" ? grantedAt : "",
    });
  }
  out.sort((a, b) => a.user_id.localeCompare(b.user_id));
  return out;
}

/**
 * GET /api/admin/ops/limits logic: { window, severity, errorsByActor,
 * rateLimited429, configured, truncated }. Severity is derived from
 * trace_events over the window (?window=7d|30d|90d, default 7d; custom
 * capped at 90d via parseAdminWindow): error = event_type 'error';
 * warning = verification events carrying a warning/unsupported payload;
 * info = everything else. rateLimited429 counts events whose payload
 * mentions a 429/rate-limit signal (documented heuristic — the agent route
 * enforces its in-memory 10 req/min cap without persisting a row, so only
 * surfaced signals are counted). `configured` echoes the compiled caps as
 * a read-only reference. Server cap (traces 10000) sets `truncated: true`
 * when it binds. NULL-workspace rows EXCLUDED on the platform path;
 * workspace path via user client (RLS) + scopedQuery.
 */
export async function queryOpsLimits(
  deps: AdminQueryDeps,
  window: string | null,
): Promise<OpsLimitsResult> {
  const parsed = parseAdminWindow({
    get: (name: string) => (name === "window" ? window : null),
  });

  const { admin, userClient, service } = deps;

  let traces: TraceRow[];
  let truncated = false;

  if (admin.tier === "platform") {
    // NULL workspace_id rows EXCLUDED — never attributed.
    const tracesRes = await service
      .from("trace_events")
      .select("actor,event_type,payload")
      .gte("created_at", parsed.from)
      .lte("created_at", parsed.to)
      .not("workspace_id", "is", null)
      .limit(TRACE_CAP);
    if (tracesRes.error) throw tracesRes.error;
    traces = asTraceRows(tracesRes.data);
    if (traces.length >= TRACE_CAP) truncated = true;
  } else {
    // Workspace tier: user client (RLS) + scopedQuery — the scoping
    // predicate `.in('workspace_id', workspaceIds)` is appended inside
    // scopedQuery (NULL rows never match the IN list).
    const traceRowsUnknown: unknown = await scopedAdminQuery(
      userClient,
      "trace_events",
      admin.workspaceIds,
      (q) =>
        q
          .select("actor,event_type,payload")
          .gte("created_at", parsed.from)
          .lte("created_at", parsed.to)
          .limit(TRACE_CAP),
    );
    traces = asTraceRows(traceRowsUnknown);
    if (traces.length >= TRACE_CAP) truncated = true;
  }

  const severity = { error: 0, warning: 0, info: 0 };
  const errorsByActor: Record<string, number> = {};
  let rateLimited429 = 0;
  for (const row of traces) {
    if (row.event_type === "error") {
      severity.error += 1;
      errorsByActor[row.actor] = (errorsByActor[row.actor] ?? 0) + 1;
    } else if (isWarningEvent(row)) {
      severity.warning += 1;
    } else {
      severity.info += 1;
    }
    if (mentionsRateLimit(row.payload)) rateLimited429 += 1;
  }

  return {
    window: {
      preset: parsed.preset,
      from: parsed.from,
      to: parsed.to,
      days: parsed.days,
    },
    severity,
    errorsByActor,
    rateLimited429,
    configured: {
      maxCostUsd: BUDGET.MAX_COST_USD,
      maxToolCalls: BUDGET.MAX_TOOL_CALLS,
      hardTimeoutMs: BUDGET.HARD_TIMEOUT_MS,
      agentRequestsPerMinute: AGENT_REQUESTS_PER_MINUTE,
    },
    meta: {
      source: "trace_events",
      readOnly: true,
      tier: admin.tier,
      fetched_at: new Date().toISOString(),
    },
    truncated,
  };
}

/**
 * GET /api/admin/ops/audit logic: { entries, total, pages, page, limit }
 * (+ truncated on the workspace path). Actor/action exact-match filters,
 * newest-first, paginated. Only safe audit_log columns are selected — no
 * stack traces or server internals are ever returned. Workspace tier
 * requires admin/owner (S7-strict): members get structural 403, enforced
 * inside the helper via the ROLE_RANK max-own guard.
 */
export async function queryOpsAudit(
  deps: AdminQueryDeps,
  input: OpsAuditInput,
): Promise<OpsAuditResult> {
  const { admin, userClient, service } = deps;

  // S7-strict guard: workspace tier needs admin/owner (max-own rank >= 3
  // across the caller's scoped workspaces); members get 403. Platform tier
  // bypasses. The audit RLS policy re-enforces owner/admin read at the row
  // level.
  if (admin.tier !== "platform") {
    if (admin.workspaceIds.length === 0) {
      throw structuralAdminError(
        403,
        "FORBIDDEN",
        "Audit log requires an admin role or higher",
      );
    }
    const { data: callerRows, error: callerError } = await userClient
      .from("workspace_members")
      .select("role")
      .eq("user_id", admin.user.id)
      .in("workspace_id", admin.workspaceIds);
    if (callerError) throw callerError;
    let maxRank = 0;
    if (Array.isArray(callerRows)) {
      for (const row of callerRows) {
        if (!isRecord(row)) continue;
        const role = row["role"];
        if (typeof role !== "string") continue;
        const rank = ROLE_RANK[role] ?? 0;
        if (rank > maxRank) maxRank = rank;
      }
    }
    if (maxRank < (ROLE_RANK["admin"] ?? 3)) {
      throw structuralAdminError(
        403,
        "FORBIDDEN",
        "Audit log requires an admin role or higher",
      );
    }
  }

  const actor =
    typeof input.actor === "string" && input.actor.trim().length > 0
      ? input.actor.trim()
      : null;
  const action =
    typeof input.action === "string" && input.action.trim().length > 0
      ? input.action.trim()
      : null;
  const { page, limit, offset } = getPagination({
    page: input.page,
    limit: input.limit,
  });

  if (admin.tier === "platform") {
    const countQuery = service
      .from("audit_log")
      .select("id", { count: "exact", head: true });
    if (actor) countQuery.eq("actor", actor);
    if (action) countQuery.eq("action", action);
    const countRes = await countQuery;
    if (countRes.error) throw countRes.error;
    const total = typeof countRes.count === "number" ? countRes.count : 0;

    const dataQuery = service
      .from("audit_log")
      .select(AUDIT_COLUMNS)
      .order("created_at", { ascending: false });
    if (actor) dataQuery.eq("actor", actor);
    if (action) dataQuery.eq("action", action);
    const dataRes = await dataQuery.range(offset, offset + limit - 1);
    if (dataRes.error) throw dataRes.error;

    return {
      entries: asAuditEntries(dataRes.data),
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      page,
      limit,
    };
  }

  // Workspace tier: USER client (RLS) + scopedQuery. Exact-match filters
  // are parameterized (no PostgREST string interpolation); RLS plus the
  // IN predicate jointly scope rows to the caller's workspaces.
  const rowsUnknown: unknown = await scopedAdminQuery(
    userClient,
    "audit_log",
    admin.workspaceIds,
    (q) => {
      let builder = q
        .select(AUDIT_COLUMNS)
        .order("created_at", { ascending: false })
        .limit(WORKSPACE_FETCH_CAP);
      if (actor) builder = builder.eq("actor", actor);
      if (action) builder = builder.eq("action", action);
      return builder;
    },
  );
  const all = asAuditEntries(rowsUnknown);
  const total = all.length;
  return {
    entries: all.slice(offset, offset + limit),
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
    page,
    limit,
    truncated: total >= WORKSPACE_FETCH_CAP,
  };
}

/**
 * GET /api/admin/agent logic: agent settings READ view — the full
 * `admin_settings` key/value map with per-key updated_at. Operational
 * knobs only; only key/value/updated_at columns are selected, so no
 * secret materializes even if the table ever held one. Both tiers read
 * the identical global map via the service-role client (documented
 * global-knobs exception — admin_settings has no workspace_id to scope on
 * and RLS permits only platform selects).
 */
export async function queryAgentSettings(
  deps: AdminQueryDeps,
): Promise<AgentSettingsResult> {
  const { admin, service } = deps;
  const { data, error } = await service
    .from("admin_settings")
    .select("key,value,updated_at")
    .order("key", { ascending: true })
    .limit(SETTINGS_CAP);
  if (error) throw error;

  const settings: Record<string, { value: unknown; updated_at: string | null }> =
    {};
  let truncated = false;
  if (Array.isArray(data)) {
    if (data.length >= SETTINGS_CAP) truncated = true;
    for (const row of data) {
      if (!isRecord(row)) continue;
      if (typeof row["key"] !== "string") continue;
      const updated = row["updated_at"];
      settings[row["key"] as string] = {
        value: row["value"] ?? null,
        updated_at: typeof updated === "string" ? updated : null,
      };
    }
  }

  return {
    settings,
    meta: {
      source: "admin_settings",
      readOnly: true,
      tier: admin.tier,
      fetched_at: new Date().toISOString(),
    },
    truncated,
  };
}

/**
 * GET /api/admin/ops/email logic: { pending, total, truncated } — pending
 * workspace_invites (status='pending'), the v1 email queue. Invite tokens
 * are NEVER selected or returned (token = credential-equivalent).
 * Platform reads all via service-role; workspace tier reads through the
 * user client (RLS) + scopedQuery.
 */
export async function queryOpsEmail(
  deps: AdminQueryDeps,
): Promise<OpsEmailResult> {
  const { admin, userClient, service } = deps;
  let pending: OpsPendingInvite[];
  if (admin.tier === "platform") {
    const { data, error } = await service
      .from("workspace_invites")
      .select(PENDING_COLUMNS)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(PENDING_CAP);
    if (error) throw error;
    pending = asPendingInvites(data);
  } else {
    // Workspace tier: user client (RLS) + scopedQuery — the scoping
    // predicate `.in('workspace_id', workspaceIds)` is appended inside
    // scopedQuery (single DB round-trip).
    const rowsUnknown: unknown = await scopedAdminQuery(
      userClient,
      "workspace_invites",
      admin.workspaceIds,
      (q) =>
        q
          .select(PENDING_COLUMNS)
          .eq("status", "pending")
          .order("created_at", { ascending: false })
          .limit(PENDING_CAP),
    );
    pending = asPendingInvites(rowsUnknown);
  }
  return {
    pending,
    total: pending.length,
    truncated: pending.length >= PENDING_CAP,
  };
}

/**
 * GET /api/admin/ops/admins logic: { admins, total } — platform_admins
 * list (user_id + email + granted_by/granted_at). Platform-tier only:
 * workspace-tier callers route through the `admin_action`/
 * `grant_platform` RPC from the user client first (commits the denied
 * trail), then get structural 403 — enforced inside the helper, not just
 * the page, so direct calls can never leak the list.
 */
export async function queryOpsAdmins(
  deps: AdminQueryDeps,
): Promise<OpsAdminsResult> {
  const { admin, userClient, service } = deps;

  // Platform-tier only: workspace-tier GET is denied with a committed
  // `denied` trail. The grant_platform branch checks platform-tier first,
  // so an empty target still records a `forbidden` trail.
  if (admin.tier !== "platform") {
    try {
      await userClient.rpc("admin_action", {
        action: "grant_platform",
        target: {},
        payload: {},
        reason: "platform admins list read",
      });
    } catch {
      // Best-effort trail: a trail failure must not mask the 403.
    }
    throw structuralAdminError(
      403,
      "FORBIDDEN",
      "Platform admins are platform-managed",
    );
  }

  const { data, error } = await service
    .from("platform_admins")
    .select("user_id,granted_by,granted_at")
    .limit(1000);
  if (error) throw error;
  const rows: unknown[] = Array.isArray(data) ? data : [];
  const ids = rows
    .filter(isRecord)
    .map((r) => r["user_id"])
    .filter((v): v is string => typeof v === "string");
  const emailByUser = new Map<string, string>();
  if (ids.length > 0) {
    const { data: profiles, error: profilesError } = await service
      .from("profiles")
      .select("user_id,email")
      .in("user_id", ids);
    if (profilesError) throw profilesError;
    if (Array.isArray(profiles)) {
      for (const p of profiles) {
        if (!isRecord(p) || typeof p["user_id"] !== "string") continue;
        emailByUser.set(
          p["user_id"] as string,
          typeof p["email"] === "string" ? (p["email"] as string) : "",
        );
      }
    }
  }
  const admins = asAdminEntries(rows, emailByUser);
  return { admins, total: admins.length };
}
