import "server-only";
import {
  getPagination,
  parseAdminWindow,
  scopedAdminQuery,
} from "@/lib/admin";
import type { AdminQueryDeps } from "./shared";

const TRACE_CAP = 10000;
const DECISION_CAP = 5000;
const SIGNUP_CAP = 5000;
const EXPERIMENT_CAP = 2000;
const STARTUP_LOOKUP_CAP = 2000;

const EXPERIMENT_SORT_ALLOWLIST = ["name", "status", "sample_size"] as const;
type ExperimentSortCol = (typeof EXPERIMENT_SORT_ALLOWLIST)[number];

export interface AnalyticsWindowInput {
  window: string | null;
  from: string | null;
  to: string | null;
}

export interface AnalyticsWindow {
  preset: string;
  from: string;
  to: string;
  days: number;
}

export interface TrendPoint {
  day: string;
  runs: number;
  cost: number;
}

export interface AnalyticsResult {
  window: AnalyticsWindow;
  distribution: {
    go: number;
    iterate: number;
    stop: number;
    test_more: number;
    total: number;
  };
  trends: TrendPoint[];
  // Estimated — COST_TABLE metering, not provider billing.
  costPerRun: { value: number; estimated: true } | null;
  signups: number;
  unsupportedClaimRate: number | null;
  truncated: boolean;
}

export interface ExperimentsInput {
  sort: string | null;
  order: string | null;
  page: string | number | null;
  limit: string | number | null;
}

export interface ExperimentViewsInput {
  sort: string | null;
  order: string | null;
}

export interface ExperimentView {
  id: string;
  name: string;
  startup_id: string;
  status: string;
  type: string;
  sample_size: number;
  created_at: string;
}

export interface ExperimentsResult {
  experiments: ExperimentView[];
  total: number;
  pages: number;
  page: number;
  limit: number;
  sort: ExperimentSortCol;
  order: "asc" | "desc";
  truncated: boolean;
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
  workspace_id: string | null;
  cost_usd: number | string | null;
  created_at: string;
  event_type: string;
  payload: unknown;
}

interface DecisionRow {
  verdict: string | null;
  created_at: string;
}

function toCostNumber(value: number | string | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function asTraceRows(value: unknown): TraceRow[] {
  if (!Array.isArray(value)) return [];
  const out: TraceRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item["created_at"] !== "string") continue;
    const cost = item["cost_usd"];
    const ws = item["workspace_id"];
    out.push({
      workspace_id: typeof ws === "string" ? ws : null,
      cost_usd:
        typeof cost === "number" || typeof cost === "string" ? cost : null,
      created_at: item["created_at"] as string,
      event_type:
        typeof item["event_type"] === "string"
          ? (item["event_type"] as string)
          : "",
      payload: item["payload"] ?? null,
    });
  }
  return out;
}

function asDecisionRows(value: unknown): DecisionRow[] {
  if (!Array.isArray(value)) return [];
  const out: DecisionRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item["created_at"] !== "string") continue;
    out.push({
      verdict: typeof item["verdict"] === "string" ? item["verdict"] : null,
      created_at: item["created_at"] as string,
    });
  }
  return out;
}

/** Bucket rows by UTC day across the whole window (zero-filled). */
function buildTrends(rows: TraceRow[], fromIso: string, toIso: string): TrendPoint[] {
  const points: TrendPoint[] = [];
  const cursor = new Date(fromIso);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(toIso);
  end.setUTCHours(0, 0, 0, 0);
  const runsByDay = new Map<string, number>();
  const costByDay = new Map<string, number>();
  for (const row of rows) {
    const day = new Date(row.created_at).toISOString().slice(0, 10);
    runsByDay.set(day, (runsByDay.get(day) ?? 0) + 1);
    costByDay.set(
      day,
      (costByDay.get(day) ?? 0) + toCostNumber(row.cost_usd),
    );
  }
  while (cursor <= end) {
    const day = cursor.toISOString().slice(0, 10);
    points.push({
      day,
      runs: runsByDay.get(day) ?? 0,
      cost:
        Math.round(((costByDay.get(day) ?? 0) + Number.EPSILON) * 100) / 100,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return points;
}

interface ExperimentRow {
  id: string;
  startup_id: string;
  workspace_id: string | null;
  status: string;
  type: string;
  design: unknown;
  created_at: string;
}

function asExperimentRows(value: unknown): ExperimentRow[] {
  if (!Array.isArray(value)) return [];
  const out: ExperimentRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (
      typeof item["id"] !== "string" ||
      typeof item["startup_id"] !== "string" ||
      typeof item["created_at"] !== "string"
    ) {
      continue;
    }
    const ws = item["workspace_id"];
    out.push({
      id: item["id"] as string,
      startup_id: item["startup_id"] as string,
      workspace_id: typeof ws === "string" ? ws : null,
      status: typeof item["status"] === "string" ? item["status"] : "",
      type: typeof item["type"] === "string" ? item["type"] : "",
      design: item["design"] ?? null,
      created_at: item["created_at"] as string,
    });
  }
  return out;
}

function designTitle(design: unknown): string | null {
  if (!isRecord(design)) return null;
  const title = design["title"];
  return typeof title === "string" && title.length > 0 ? title : null;
}

function designSampleSize(design: unknown): number {
  if (!isRecord(design)) return 0;
  const size = design["target_sample_size"];
  return typeof size === "number" && Number.isFinite(size) && size >= 0
    ? Math.floor(size)
    : 0;
}

function toViews(
  rows: ExperimentRow[],
  nameByStartup: Map<string, string>,
): ExperimentView[] {
  return rows.map((r) => ({
    id: r.id,
    name: nameByStartup.get(r.startup_id) ?? designTitle(r.design) ?? "Untitled",
    startup_id: r.startup_id,
    status: r.status,
    type: r.type,
    sample_size: designSampleSize(r.design),
    created_at: r.created_at,
  }));
}

function sortViews(
  views: ExperimentView[],
  sort: ExperimentSortCol,
  order: "asc" | "desc",
): ExperimentView[] {
  const dir = order === "desc" ? -1 : 1;
  return [...views].sort((x, y) => {
    let cmp = 0;
    if (sort === "name") cmp = x.name.localeCompare(y.name);
    else if (sort === "status") cmp = x.status.localeCompare(y.status);
    else cmp = x.sample_size - y.sample_size;
    if (cmp === 0) cmp = x.created_at.localeCompare(y.created_at);
    return cmp * dir;
  });
}

/**
 * Validate experiment sort/order WITHOUT any reads (route pre-check mirrors
 * the original inline order sort → order → format → pagination, so
 * invalid-format requests never pay the EXPERIMENT_CAP + startup-lookup
 * cost; the helpers re-validate internally before reading — this is purely
 * the cheap early gate).
 */
export function parseExperimentSortOrder(input: ExperimentViewsInput): {
  sort: ExperimentSortCol;
  order: "asc" | "desc";
} {
  const rawSort = (input.sort ?? "name").trim().toLowerCase();
  if (!(EXPERIMENT_SORT_ALLOWLIST as readonly string[]).includes(rawSort)) {
    throw structuralAdminError(
      400,
      "BAD_REQUEST",
      "Invalid sort (expected name, status, sample_size)",
    );
  }
  const rawOrder = (input.order ?? "asc").trim().toLowerCase();
  if (rawOrder !== "asc" && rawOrder !== "desc") {
    throw structuralAdminError(
      400,
      "BAD_REQUEST",
      "Invalid order (expected asc or desc)",
    );
  }
  return { sort: rawSort as ExperimentSortCol, order: rawOrder };
}

/**
 * Validate the experiments `?format=` param WITHOUT any reads (original
 * inline order checked format before getPagination + reads; the route calls
 * this before createQueryDeps/helper so invalid formats return the exact
 * 400 with zero DB cost).
 */
export function parseExperimentFormat(raw: string | null): "json" | "csv" {
  const normalized = (raw ?? "json").trim().toLowerCase();
  if (normalized !== "json" && normalized !== "csv") {
    throw structuralAdminError(
      400,
      "BAD_REQUEST",
      "Invalid format (expected json or csv)",
    );
  }
  return normalized;
}

/**
 * GET /api/admin/analytics logic: { window, distribution, trends,
 * costPerRun, signups, unsupportedClaimRate, truncated }. Window arrives
 * RAW (?window=7d|30d|90d, default 7d; ?window=custom&from=ISO&to=ISO, span
 * capped at 90d) and validates inside via parseAdminWindow (invalid → 400).
 * Verdict distribution + runs/day + cost/day trends over the window; spend
 * labeled estimated (sum(trace_events.cost_usd) — COST_TABLE metering, not
 * provider billing). NULL-workspace legacy rows EXCLUDED on the platform
 * path; the workspace path goes through the user client (RLS) +
 * scopedQuery, whose `.in('workspace_id', workspaceIds)` predicate never
 * matches NULL rows. Server-side caps (traces 10000, decisions 5000,
 * signups 5000) set `truncated: true` when they bind.
 */
export async function queryAnalytics(
  deps: AdminQueryDeps,
  input: AnalyticsWindowInput,
): Promise<AnalyticsResult> {
  const window = parseAdminWindow({
    get: (name: string) =>
      name === "window"
        ? input.window
        : name === "from"
          ? input.from
          : name === "to"
            ? input.to
            : null,
  });

  const { admin, userClient, service } = deps;

  let traces: TraceRow[];
  let decisions: DecisionRow[];
  let signups: number;
  let truncated = false;

  if (admin.tier === "platform") {
    // NULL workspace_id rows EXCLUDED — never attributed.
    const tracesRes = await service
      .from("trace_events")
      .select("workspace_id,cost_usd,created_at,event_type,payload")
      .gte("created_at", window.from)
      .lte("created_at", window.to)
      .not("workspace_id", "is", null)
      .order("created_at", { ascending: true })
      .limit(TRACE_CAP);
    if (tracesRes.error) throw tracesRes.error;
    traces = asTraceRows(tracesRes.data);
    if (traces.length >= TRACE_CAP) truncated = true;

    const decisionsRes = await service
      .from("decisions")
      .select("verdict,created_at")
      .gte("created_at", window.from)
      .lte("created_at", window.to)
      .not("workspace_id", "is", null)
      .limit(DECISION_CAP);
    if (decisionsRes.error) throw decisionsRes.error;
    decisions = asDecisionRows(decisionsRes.data);
    if (decisions.length >= DECISION_CAP) truncated = true;

    const signupsRes = await service
      .from("profiles")
      .select("user_id", { count: "exact", head: true })
      .gte("created_at", window.from)
      .lte("created_at", window.to);
    if (signupsRes.error) throw signupsRes.error;
    signups = typeof signupsRes.count === "number" ? signupsRes.count : 0;
  } else {
    // Workspace tier: user client (RLS) + scopedQuery — the scoping
    // predicate `.in('workspace_id', workspaceIds)` is appended inside
    // scopedQuery (single DB round-trip; NULL rows never match the IN
    // list).
    const traceRowsUnknown: unknown = await scopedAdminQuery(
      userClient,
      "trace_events",
      admin.workspaceIds,
      (q) =>
        q
          .select("workspace_id,cost_usd,created_at,event_type,payload")
          .gte("created_at", window.from)
          .lte("created_at", window.to)
          .order("created_at", { ascending: true })
          .limit(TRACE_CAP),
    );
    traces = asTraceRows(traceRowsUnknown);
    if (traces.length >= TRACE_CAP) truncated = true;

    const decisionRowsUnknown: unknown = await scopedAdminQuery(
      userClient,
      "decisions",
      admin.workspaceIds,
      (q) =>
        q
          .select("verdict,created_at")
          .gte("created_at", window.from)
          .lte("created_at", window.to)
          .limit(DECISION_CAP),
    );
    decisions = asDecisionRows(decisionRowsUnknown);
    if (decisions.length >= DECISION_CAP) truncated = true;

    const memberRowsUnknown: unknown = await scopedAdminQuery(
      userClient,
      "workspace_members",
      admin.workspaceIds,
      (q) =>
        q
          .select("user_id,joined_at")
          .gte("joined_at", window.from)
          .limit(SIGNUP_CAP),
    );
    const memberRows: unknown[] = Array.isArray(memberRowsUnknown)
      ? memberRowsUnknown
      : [];
    if (memberRows.length >= SIGNUP_CAP) truncated = true;
    signups = memberRows.filter(
      (r) =>
        isRecord(r) &&
        typeof r["joined_at"] === "string" &&
        (r["joined_at"] as string) <= window.to,
    ).length;
  }

  const distribution = { go: 0, iterate: 0, stop: 0, test_more: 0 };
  for (const d of decisions) {
    if (d.verdict === "go") distribution.go += 1;
    else if (d.verdict === "iterate") distribution.iterate += 1;
    else if (d.verdict === "stop") distribution.stop += 1;
    else if (d.verdict === "test_more") distribution.test_more += 1;
  }

  let spendRaw = 0;
  for (const row of traces) spendRaw += toCostNumber(row.cost_usd);
  const spend = Math.round((spendRaw + Number.EPSILON) * 100) / 100;

  let verificationTotal = 0;
  let verificationUnsupported = 0;
  for (const row of traces) {
    if (row.event_type !== "verification") continue;
    verificationTotal += 1;
    if (!isRecord(row.payload)) continue;
    const unsupported = row.payload["unsupported_count"];
    const claims = row.payload["unsupported_claims"];
    if (
      (typeof unsupported === "number" && unsupported > 0) ||
      (Array.isArray(claims) && claims.length > 0)
    ) {
      verificationUnsupported += 1;
    }
  }

  return {
    window: {
      preset: window.preset,
      from: window.from,
      to: window.to,
      days: window.days,
    },
    distribution: { ...distribution, total: decisions.length },
    trends: buildTrends(traces, window.from, window.to),
    // Estimated — COST_TABLE metering, not provider billing.
    costPerRun:
      traces.length > 0
        ? {
            value:
              Math.round((spend / traces.length + Number.EPSILON) * 100) /
              100,
            estimated: true as const,
          }
        : null,
    signups,
    unsupportedClaimRate:
      verificationTotal > 0
        ? Math.round(
            (verificationUnsupported / verificationTotal + Number.EPSILON) *
              1000,
          ) / 1000
        : null,
    truncated,
  };
}

/**
 * Experiment rows for GET /api/admin/analytics/experiments: the FULL
 * sorted view list (cap-bound). Sort/order arrive RAW and validate inside
 * (invalid → 400); name = parent startup name (fallback: design.title,
 * then "Untitled"); sample_size = design.target_sample_size (recruitment
 * target — observed sample lives on evidence rows). NULL-workspace legacy
 * rows EXCLUDED on the platform path; workspace path via user client (RLS)
 * + scopedQuery. `truncated: true` signals the server cap bound.
 */
export async function queryExperimentViews(
  deps: AdminQueryDeps,
  input: ExperimentViewsInput,
): Promise<{ views: ExperimentView[]; truncated: boolean }> {
  const { sort, order } = parseExperimentSortOrder(input);
  const { admin, userClient, service } = deps;

  let experiments: ExperimentRow[];
  let truncated = false;
  const nameByStartup = new Map<string, string>();

  if (admin.tier === "platform") {
    // NULL workspace_id rows EXCLUDED — never attributed.
    const expRes = await service
      .from("experiments")
      .select("id,startup_id,workspace_id,status,type,design,created_at")
      .not("workspace_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(EXPERIMENT_CAP);
    if (expRes.error) throw expRes.error;
    experiments = asExperimentRows(expRes.data);
    if (experiments.length >= EXPERIMENT_CAP) truncated = true;

    const startupIds = [...new Set(experiments.map((r) => r.startup_id))];
    for (let i = 0; i < startupIds.length; i += 200) {
      const chunk = startupIds.slice(i, i + 200);
      if (chunk.length === 0) continue;
      const startupRes = await service
        .from("startups")
        .select("id,name")
        .in("id", chunk)
        .limit(STARTUP_LOOKUP_CAP);
      if (startupRes.error) throw startupRes.error;
      if (Array.isArray(startupRes.data)) {
        if (startupRes.data.length >= STARTUP_LOOKUP_CAP) truncated = true;
        for (const s of startupRes.data) {
          if (!isRecord(s)) continue;
          if (typeof s["id"] === "string" && typeof s["name"] === "string") {
            nameByStartup.set(s["id"] as string, s["name"] as string);
          }
        }
      }
    }
  } else {
    // Workspace tier: user client (RLS) + scopedQuery for both reads —
    // the `.in('workspace_id', workspaceIds)` predicate is appended
    // inside scopedQuery (NULL rows never match the IN list).
    const expRowsUnknown: unknown = await scopedAdminQuery(
      userClient,
      "experiments",
      admin.workspaceIds,
      (q) =>
        q
          .select("id,startup_id,workspace_id,status,type,design,created_at")
          .order("created_at", { ascending: false })
          .limit(EXPERIMENT_CAP),
    );
    experiments = asExperimentRows(expRowsUnknown);
    if (experiments.length >= EXPERIMENT_CAP) truncated = true;

    const startupRowsUnknown: unknown = await scopedAdminQuery(
      userClient,
      "startups",
      admin.workspaceIds,
      (q) => q.select("id,name").limit(STARTUP_LOOKUP_CAP),
    );
    const startupRows: unknown[] = Array.isArray(startupRowsUnknown)
      ? startupRowsUnknown
      : [];
    if (startupRows.length >= STARTUP_LOOKUP_CAP) truncated = true;
    for (const s of startupRows) {
      if (!isRecord(s)) continue;
      if (typeof s["id"] === "string" && typeof s["name"] === "string") {
        nameByStartup.set(s["id"] as string, s["name"] as string);
      }
    }
  }

  return { views: sortViews(toViews(experiments, nameByStartup), sort, order), truncated };
}

/**
 * GET /api/admin/analytics/experiments JSON logic: { experiments (page
 * slice), total, pages, page, limit, sort, order, truncated }.
 * Sorting/pagination apply post-fetch within the server cap via
 * getPagination (defaults page 20 / max 100). The `?format=csv` branch
 * does NOT go through here — the route calls queryExperimentViews for
 * the full sorted rows and formats CSV inline (byte-identical).
 */
export async function queryExperiments(
  deps: AdminQueryDeps,
  input: ExperimentsInput,
): Promise<ExperimentsResult> {
  const { sort, order } = parseExperimentSortOrder(input);
  const { page, limit, offset } = getPagination({
    page: input.page,
    limit: input.limit,
  });
  const { views, truncated } = await queryExperimentViews(deps, {
    sort: input.sort,
    order: input.order,
  });
  const total = views.length;
  return {
    experiments: views.slice(offset, offset + limit),
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
    page,
    limit,
    sort,
    order,
    truncated,
  };
}
