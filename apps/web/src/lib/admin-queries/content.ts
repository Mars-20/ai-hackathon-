import "server-only";
import {
  escapePostgrest,
  getPagination,
  parseSearchQuery,
  scopedAdminQuery,
} from "@/lib/admin";
import type { AdminQueryBuilder } from "@/lib/admin";
import type { AdminQueryDeps } from "./shared";

const SORT_ALLOWLIST = ["created_at", "name", "flagged"] as const;
type SortCol = (typeof SORT_ALLOWLIST)[number];

const VALID_VERDICTS = ["go", "iterate", "stop", "test_more"] as const;
const VALID_CONFIDENCE = ["low", "medium", "high"] as const;

/** Local extension: PostgREST `.or()` is outside the shallow shared surface. */
interface FilterBuilder extends AdminQueryBuilder {
  or(filters: string): FilterBuilder;
}

export interface ContentStartupsInput {
  page: string | number | null;
  limit: string | number | null;
  sort: string | null;
  order: string | null;
  q: string | null;
  flagged: string | null;
  verdict: string | null;
  confidence: string | null;
}

export interface ContentLatestDecision {
  verdict: string;
  confidence: string;
  created_at: string;
}

export interface ContentStartupEntry {
  id: string;
  workspace_id: string | null;
  name: string;
  one_liner: string;
  domain: string;
  stage: string;
  flagged: boolean;
  created_at: string;
  latestDecision: ContentLatestDecision | null;
  evidenceCount: number;
}

export interface ContentStartupsResult {
  startups: ContentStartupEntry[];
  total: number;
  pages: number;
  page: number;
  limit: number;
}

export interface ContentDetailsResult {
  startup: Record<string, unknown>;
  assumptions: Record<string, unknown>[];
  evidence: Record<string, unknown>[];
  decisions: Record<string, unknown>[];
  traces: Record<string, unknown>[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
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

interface StartupRow {
  id: string;
  workspace_id: string | null;
  name: string;
  one_liner: string;
  domain: string;
  stage: string;
  flagged: boolean;
  created_at: string;
}

function asStartupRows(value: unknown): StartupRow[] {
  if (!Array.isArray(value)) return [];
  const out: StartupRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item["id"] !== "string") continue;
    out.push({
      id: item["id"] as string,
      workspace_id: typeof item["workspace_id"] === "string" ? (item["workspace_id"] as string) : null,
      name: typeof item["name"] === "string" ? (item["name"] as string) : "",
      one_liner: typeof item["one_liner"] === "string" ? (item["one_liner"] as string) : "",
      domain: typeof item["domain"] === "string" ? (item["domain"] as string) : "",
      stage: typeof item["stage"] === "string" ? (item["stage"] as string) : "",
      flagged: item["flagged"] === true,
      created_at: typeof item["created_at"] === "string" ? (item["created_at"] as string) : "",
    });
  }
  return out;
}

function startupIdsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const sid = item["startup_id"];
    if (typeof sid === "string" && sid.length > 0) out.push(sid);
  }
  return [...new Set(out)];
}

/** Combine escaped ilike fragments + an id set into one PostgREST or-string. */
function buildOrFilter(escaped: string | null, idList: string[]): string | null {
  const parts: string[] = [];
  if (escaped !== null) {
    parts.push(`name.ilike.%${escaped}%`);
    parts.push(`one_liner.ilike.%${escaped}%`);
    parts.push(`domain.ilike.%${escaped}%`);
  }
  if (idList.length > 0) parts.push(`id.in.(${idList.join(",")})`);
  return parts.length > 0 ? parts.join(",") : null;
}

const STARTUP_COLS =
  "id,workspace_id,name,one_liner,domain,stage,flagged,created_at";

/**
 * GET /api/admin/content/startups logic: { startups, total, pages, page,
 * limit } (spec §§2-3,7). Content review queue: flagged-first default
 * ordering, filters flagged / verdict / confidence, full-text q over startup
 * name/one_liner/domain + evidence claims + lead emails (canonical
 * escapePostgrest on every fragment; raw q is never interpolated).
 * Verdict/confidence match when ANY decision on the startup matches
 * (documented semantic). Platform tier reads all rows via service-role
 * (NULL-workspace rows EXCLUDED via `.not('workspace_id', 'is', null)`).
 * Workspace tier reads through the user client (RLS) + scopedQuery — the
 * scoping predicate `.in('workspace_id', workspaceIds)` is appended inside
 * scopedQuery (NULL rows never match the IN list); the total count reuses
 * the Task-3 users-route pattern (service-role count strictly filtered to
 * the in-scope workspace ids — a number, never row data).
 * Validation lives inside (spec §4.7): invalid flagged/verdict/confidence
 * filters throw structural 400, exactly like the route's inline bodies.
 */
export async function queryContentStartups(
  deps: AdminQueryDeps,
  input: ContentStartupsInput,
): Promise<ContentStartupsResult> {
  const { admin, userClient, service } = deps;

  const { page, limit, offset } = getPagination({
    page: input.page,
    limit: input.limit,
  });
  const rawSort = input.sort ?? "created_at";
  const sort: SortCol = (SORT_ALLOWLIST as readonly string[]).includes(rawSort)
    ? (rawSort as SortCol)
    : "created_at";
  const ascending = input.order === "asc";
  const search = parseSearchQuery(input.q);

  const rawFlagged = input.flagged;
  let flagged: string | null = null;
  if (rawFlagged !== null && rawFlagged !== "" && rawFlagged !== "all") {
    if (rawFlagged !== "true" && rawFlagged !== "false") {
      throw structuralAdminError(400, "BAD_REQUEST", "Invalid flagged filter");
    }
    flagged = rawFlagged;
  }
  const rawVerdict = input.verdict;
  const verdict: string | null = rawVerdict === null || rawVerdict === "" ? null : rawVerdict;
  if (verdict !== null && !(VALID_VERDICTS as readonly string[]).includes(verdict)) {
    throw structuralAdminError(400, "BAD_REQUEST", "Invalid verdict filter");
  }
  const rawConfidence = input.confidence;
  const confidence: string | null = rawConfidence === null || rawConfidence === "" ? null : rawConfidence;
  if (confidence !== null && !(VALID_CONFIDENCE as readonly string[]).includes(confidence)) {
    throw structuralAdminError(400, "BAD_REQUEST", "Invalid confidence filter");
  }

  const scopeIds: string[] | null =
    admin.tier === "platform" ? null : [...admin.workspaceIds];
  if (scopeIds !== null && scopeIds.length === 0) {
    return { startups: [], total: 0, pages: 0, page, limit };
  }

  const escaped = search === null ? null : escapePostgrest(search);

  // Candidate startup ids from cross-table full-text (evidence claims +
  // lead emails). Scope-filtered where the table carries workspace_id
  // (evidence); the final query re-applies scope, so lead-derived ids can
  // never leak cross-workspace rows. Capped (v1) — noted in the report.
  // When q AND a verdict/confidence filter are both present, text matches
  // on the startups table itself are resolved to ids first so the final
  // constraint is an exact AND (pure id list, no ilike bypass).
  async function textMatchIds(): Promise<string[]> {
    if (escaped === null) return [];
    let evQuery = service
      .from("evidence")
      .select("startup_id")
      .ilike("claim", `%${escaped}%`)
      .limit(2000);
    if (scopeIds !== null) evQuery = evQuery.in('workspace_id', scopeIds);
    else evQuery = evQuery.not("workspace_id", "is", null);
    let stQuery = service
      .from("startups")
      .select("id")
      .or(`name.ilike.%${escaped}%,one_liner.ilike.%${escaped}%,domain.ilike.%${escaped}%`)
      .limit(2000);
    if (scopeIds !== null) stQuery = stQuery.in('workspace_id', scopeIds);
    else stQuery = stQuery.not("workspace_id", "is", null);
    const [evRes, leadRes, stRes] = await Promise.all([
      evQuery,
      service.from("leads").select("startup_id").ilike("email", `%${escaped}%`).limit(2000),
      stQuery,
    ]);
    if (evRes.error) throw evRes.error;
    if (leadRes.error) throw leadRes.error;
    if (stRes.error) throw stRes.error;
    const startupTextIds: string[] = asRows(stRes.data)
      .map((r) => r["id"])
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    return [...new Set([...startupTextIds, ...startupIdsOf(evRes.data), ...startupIdsOf(leadRes.data)])];
  }

  // Verdict/confidence filter: startups having ANY matching decision.
  async function decisionMatchIds(verdictValue: string | null, confidenceValue: string | null): Promise<string[] | null> {
    if (verdictValue === null && confidenceValue === null) return null;
    let dQuery = service.from("decisions").select("startup_id").limit(5000);
    if (verdictValue !== null) dQuery = dQuery.eq("verdict", verdictValue);
    if (confidenceValue !== null) dQuery = dQuery.eq("confidence", confidenceValue);
    if (scopeIds !== null) dQuery = dQuery.in('workspace_id', scopeIds);
    else dQuery = dQuery.not("workspace_id", "is", null);
    const { data, error } = await dQuery;
    if (error) throw error;
    return startupIdsOf(data);
  }

  const [matchedTextIds, matchedDecisionIds] = await Promise.all([
    textMatchIds(),
    decisionMatchIds(verdict, confidence),
  ]);

  let orFilter: string | null = null;
  if (matchedDecisionIds !== null) {
    // Exact AND: verdict set ∩ text set (text set ignored when no q).
    const finalIds =
      escaped === null
        ? matchedDecisionIds
        : matchedDecisionIds.filter((id) => matchedTextIds.includes(id));
    if (finalIds.length === 0) {
      return { startups: [], total: 0, pages: 0, page, limit };
    }
    orFilter = buildOrFilter(null, finalIds);
  } else {
    // q only: startup-column ilikes OR evidence/lead id matches.
    orFilter = buildOrFilter(escaped, matchedTextIds);
  }

  function applySort(q: AdminQueryBuilder): AdminQueryBuilder {
    // Flagged-first default: flagged rows surface before unflagged ones.
    if (sort === "name") {
      return q.order("name", { ascending }).order("created_at", { ascending: false });
    }
    if (sort === "flagged") {
      return q.order("flagged", { ascending }).order("created_at", { ascending: false });
    }
    return q.order("flagged", { ascending: false }).order("created_at", { ascending });
  }

  let rows: StartupRow[];
  let total: number;
  if (admin.tier === "platform") {
    let query = service.from("startups").select(STARTUP_COLS, { count: "exact" });
    // NULL-workspace legacy rows EXCLUDED — never attributed.
    query = query.not("workspace_id", "is", null);
    if (flagged !== null) query = query.eq("flagged", flagged);
    if (orFilter !== null) query = query.or(orFilter);
    query = applySort(query as unknown as AdminQueryBuilder) as unknown as typeof query;
    query = query.range(offset, offset + limit - 1);
    const { data, count, error } = await query;
    if (error) throw error;
    rows = asStartupRows(data);
    total = typeof count === "number" ? count : rows.length;
  } else {
    // Workspace tier: user client (RLS) + scopedQuery (`.in('workspace_id',
    // workspaceIds)` appended inside scopedQuery; NULL rows never match).
    const dataUnknown: unknown = await scopedAdminQuery(
      userClient,
      "startups",
      scopeIds ?? [],
      (q) => {
        let b: AdminQueryBuilder = q.select(STARTUP_COLS);
        if (flagged !== null) b = b.eq("flagged", flagged);
        let fb: AdminQueryBuilder = b;
        if (orFilter !== null) fb = (b as unknown as FilterBuilder).or(orFilter);
        fb = applySort(fb);
        return fb.range(offset, offset + limit - 1);
      },
    );
    rows = asStartupRows(dataUnknown);
    // Total: service-role count strictly filtered to in-scope ids
    // (a number, never row data — Task-3 users-route pattern).
    let cQuery = service.from("startups").select("id", { count: "exact", head: true });
    cQuery = cQuery.in('workspace_id', scopeIds ?? []);
    if (flagged !== null) cQuery = cQuery.eq("flagged", flagged);
    if (orFilter !== null) cQuery = cQuery.or(orFilter);
    const { count, error } = await cQuery;
    if (error) throw error;
    total = typeof count === "number" ? count : rows.length;
  }

  // Per-startup extras, batched over the page's own ids only.
  const pageIds = rows.map((s) => s.id);
  const latestByStartup = new Map<string, { verdict: string; confidence: string; created_at: string }>();
  const evidenceCounts = new Map<string, number>();
  if (pageIds.length > 0) {
    const [decRes, evRes] = await Promise.all([
      service.from("decisions").select("startup_id,verdict,confidence,created_at").in("startup_id", pageIds).order("created_at", { ascending: false }).limit(2000),
      service.from("evidence").select("startup_id").in("startup_id", pageIds).limit(5000),
    ]);
    if (decRes.error) throw decRes.error;
    if (evRes.error) throw evRes.error;
    if (Array.isArray(decRes.data)) {
      for (const item of decRes.data) {
        if (!isRecord(item)) continue;
        const sid = item["startup_id"];
        if (typeof sid !== "string" || latestByStartup.has(sid)) continue;
        latestByStartup.set(sid, {
          verdict: typeof item["verdict"] === "string" ? (item["verdict"] as string) : "",
          confidence: typeof item["confidence"] === "string" ? (item["confidence"] as string) : "",
          created_at: typeof item["created_at"] === "string" ? (item["created_at"] as string) : "",
        });
      }
    }
    if (Array.isArray(evRes.data)) {
      for (const item of evRes.data) {
        if (!isRecord(item)) continue;
        const sid = item["startup_id"];
        if (typeof sid !== "string") continue;
        evidenceCounts.set(sid, (evidenceCounts.get(sid) ?? 0) + 1);
      }
    }
  }

  return {
    startups: rows.map((s) => ({
      id: s.id,
      workspace_id: s.workspace_id,
      name: s.name,
      one_liner: s.one_liner,
      domain: s.domain,
      stage: s.stage,
      flagged: s.flagged,
      created_at: s.created_at,
      latestDecision: latestByStartup.get(s.id) ?? null,
      evidenceCount: evidenceCounts.get(s.id) ?? 0,
    })),
    total,
    pages: limit > 0 ? Math.ceil(total / limit) : 0,
    page,
    limit,
  };
}

/**
 * GET /api/admin/content/details logic: full detail graph { startup,
 * assumptions, evidence, decisions, traces } (spec §§2-3,7).
 * Both tiers read through scopedQuery: platform via the service-role client
 * filtered to the single startup id (+ `.not('workspace_id', 'is', null)`
 * on child reads so NULL-workspace rows never mix in); workspace tier via
 * the user client (RLS) + scopedQuery — the scoping predicate
 * `.in('workspace_id', workspaceIds)` is appended inside scopedQuery, so an
 * out-of-scope id yields 404 (no existence leak).
 * Missing startup_id throws structural 400; a missing or out-of-scope
 * startup throws structural 404 (indistinguishable by design — the scoped
 * read returns zero rows either way, so existence never leaks).
 */
export async function queryContentDetails(
  deps: AdminQueryDeps,
  startupId: string | null,
): Promise<ContentDetailsResult> {
  const { admin, userClient, service } = deps;

  if (typeof startupId !== "string" || startupId.length === 0) {
    throw structuralAdminError(400, "BAD_REQUEST", "startup_id is required");
  }

  if (admin.tier === "platform") {
    const [startupRes, assumptionsRes, evidenceRes, decisionsRes, tracesRes] =
      await Promise.all([
        service.from("startups").select("*").eq("id", startupId).maybeSingle(),
        service.from("evidence").select("*").eq("startup_id", startupId).not("workspace_id", "is", null).order("collected_at", { ascending: false }).limit(1000),
        service.from("assumptions").select("*").eq("startup_id", startupId).not("workspace_id", "is", null).order("created_at", { ascending: false }).limit(1000),
        service.from("decisions").select("*").eq("startup_id", startupId).not("workspace_id", "is", null).order("created_at", { ascending: false }).limit(500),
        service.from("trace_events").select("*").eq("startup_id", startupId).not("workspace_id", "is", null).order("created_at", { ascending: false }).limit(1000),
      ]);
    if (startupRes.error) throw startupRes.error;
    if (assumptionsRes.error) throw assumptionsRes.error;
    if (evidenceRes.error) throw evidenceRes.error;
    if (decisionsRes.error) throw decisionsRes.error;
    if (tracesRes.error) throw tracesRes.error;
    if (!isRecord(startupRes.data)) {
      throw structuralAdminError(404, "NOT_FOUND", "Startup not found");
    }
    return {
      startup: startupRes.data,
      assumptions: asRows(assumptionsRes.data),
      evidence: asRows(evidenceRes.data),
      decisions: asRows(decisionsRes.data),
      traces: asRows(tracesRes.data),
    };
  }

  // Workspace tier: user client (RLS) + scopedQuery — the scoping
  // predicate `.in('workspace_id', workspaceIds)` is appended inside
  // scopedQuery (single DB round-trip per table; NULL rows never match).
  const [startupUnknown, assumptionsUnknown, evidenceUnknown, decisionsUnknown, tracesUnknown] =
    await Promise.all([
      scopedAdminQuery(userClient, "startups", admin.workspaceIds, (q) =>
        q.select("*").eq("id", startupId),
      ),
      scopedAdminQuery(userClient, "assumptions", admin.workspaceIds, (q) =>
        q.select("*").eq("startup_id", startupId).order("created_at", { ascending: false }).limit(1000),
      ),
      scopedAdminQuery(userClient, "evidence", admin.workspaceIds, (q) =>
        q.select("*").eq("startup_id", startupId).order("collected_at", { ascending: false }).limit(1000),
      ),
      scopedAdminQuery(userClient, "decisions", admin.workspaceIds, (q) =>
        q.select("*").eq("startup_id", startupId).order("created_at", { ascending: false }).limit(500),
      ),
      scopedAdminQuery(userClient, "trace_events", admin.workspaceIds, (q) =>
        q.select("*").eq("startup_id", startupId).order("created_at", { ascending: false }).limit(1000),
      ),
    ]);
  const startupRows = asRows(startupUnknown);
  // `.eq("id", ...)` returns at most one row; out-of-scope → zero rows.
  const startup: Record<string, unknown> | null =
    startupRows.length > 0 ? (startupRows[0] as Record<string, unknown>) : null;
  if (startup === null) {
    throw structuralAdminError(404, "NOT_FOUND", "Startup not found");
  }
  return {
    startup,
    assumptions: asRows(assumptionsUnknown),
    evidence: asRows(evidenceUnknown),
    decisions: asRows(decisionsUnknown),
    traces: asRows(tracesUnknown),
  };
}
