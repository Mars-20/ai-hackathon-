// ─────────────────────────────────────────────────────────────────────────────
// /admin/content — decision review queue (Server Component, spec §§2-3,7).
// Lists GET /api/admin/content/startups through adminApiFetch (no direct
// Supabase reads): filters flagged / verdict / confidence / q, sort
// allowlist (created_at/name/flagged), flagged-first default ordering.
// Row actions live in the ContentActions island: flag/unflag (member+) and
// policy screen approve/reject (admin/owner — API-enforced, denials
// surface as messages). ?startup_id= opens the evidence-inspection panel
// (GET /api/admin/content/details: assumptions, evidence, decisions,
// traces) — the same run-detail target linked from the ops audit table.
// ─────────────────────────────────────────────────────────────────────────────
import Link from "next/link";
import ContentActions from "@/components/admin/ContentActions";
import {
  buildAdminTableQuery,
  parseAdminTableParams,
} from "@/components/admin/table-helpers";
import { adminApiFetch, AdminApiError } from "@/lib/admin-fetch";
import { isRedirectError } from "next/dist/client/components/redirect-error";

const CONTENT_SORT_ALLOWLIST = ["created_at", "name", "flagged"] as const;
const CONTENT_DEFAULT_SORT = "created_at";

const VALID_VERDICTS = ["go", "iterate", "stop", "test_more"] as const;
const VALID_CONFIDENCE = ["low", "medium", "high"] as const;

interface LatestDecision {
  verdict: string;
  confidence: string;
  created_at: string;
}

interface StartupEntry {
  id: string;
  workspace_id: string | null;
  name: string;
  one_liner: string;
  domain: string;
  stage: string;
  flagged: boolean;
  created_at: string;
  latestDecision: LatestDecision | null;
  evidenceCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asDecision(value: unknown): LatestDecision | null {
  if (!isRecord(value)) return null;
  if (
    typeof value["verdict"] !== "string" ||
    typeof value["confidence"] !== "string" ||
    typeof value["created_at"] !== "string"
  ) {
    return null;
  }
  return {
    verdict: value["verdict"] as string,
    confidence: value["confidence"] as string,
    created_at: value["created_at"] as string,
  };
}

function narrowStartups(body: unknown): {
  startups: StartupEntry[];
  total: number;
  pages: number;
  page: number;
  limit: number;
} | null {
  if (!isRecord(body) || !Array.isArray(body["startups"])) return null;
  const startups: StartupEntry[] = [];
  for (const item of body["startups"] as unknown[]) {
    if (!isRecord(item) || typeof item["id"] !== "string") continue;
    const ws = item["workspace_id"];
    startups.push({
      id: item["id"] as string,
      workspace_id: typeof ws === "string" ? ws : null,
      name: typeof item["name"] === "string" ? (item["name"] as string) : "",
      one_liner:
        typeof item["one_liner"] === "string"
          ? (item["one_liner"] as string)
          : "",
      domain:
        typeof item["domain"] === "string" ? (item["domain"] as string) : "",
      stage: typeof item["stage"] === "string" ? (item["stage"] as string) : "",
      flagged: item["flagged"] === true,
      created_at:
        typeof item["created_at"] === "string"
          ? (item["created_at"] as string)
          : "",
      latestDecision: asDecision(item["latestDecision"]),
      evidenceCount:
        typeof item["evidenceCount"] === "number" &&
        Number.isFinite(item["evidenceCount"])
          ? (item["evidenceCount"] as number)
          : 0,
    });
  }
  const total =
    typeof body["total"] === "number" ? body["total"] : startups.length;
  const pages = typeof body["pages"] === "number" ? body["pages"] : 0;
  const page = typeof body["page"] === "number" ? body["page"] : 1;
  const limit = typeof body["limit"] === "number" ? body["limit"] : 20;
  return { startups, total, pages, page, limit };
}

function readSingle(
  params: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const raw = params[name];
  if (raw === undefined) return null;
  const value = Array.isArray(raw) ? (raw[0] ?? "") : raw;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function verdictBadge(verdict: string): string {
  if (verdict === "go") return "border-green-500/30 bg-green-500/10 text-green-400";
  if (verdict === "stop") return "border-red-500/30 bg-red-500/10 text-red-400";
  return "border-yellow-500/30 bg-yellow-500/10 text-yellow-400";
}

function sortHref(
  base: string,
  current: { q: string | null; order: string; limit: number },
  extra: string,
  col: string,
  sort: string,
  order: string,
): string {
  const qs = new URLSearchParams();
  if (current.q !== null) qs.set("q", current.q);
  qs.set("sort", col);
  qs.set("order", sort === col && order === "desc" ? "asc" : "desc");
  qs.set("limit", String(current.limit));
  qs.set("page", "1");
  const rest = extra.length > 0 ? `&${extra}` : "";
  return `${base}?${qs.toString()}${rest}`;
}

export default async function AdminContentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const params = parseAdminTableParams(
    raw,
    CONTENT_SORT_ALLOWLIST,
    CONTENT_DEFAULT_SORT,
  );

  const flaggedRaw = readSingle(raw, "flagged");
  const flagged =
    flaggedRaw === "true" || flaggedRaw === "false" ? flaggedRaw : null;
  const verdictRaw = readSingle(raw, "verdict");
  const verdict =
    verdictRaw !== null &&
    (VALID_VERDICTS as readonly string[]).includes(verdictRaw)
      ? verdictRaw
      : null;
  const confidenceRaw = readSingle(raw, "confidence");
  const confidence =
    confidenceRaw !== null &&
    (VALID_CONFIDENCE as readonly string[]).includes(confidenceRaw)
      ? confidenceRaw
      : null;
  const focusId = readSingle(raw, "startup_id");

  let body: unknown = null;
  let loadError: string | null = null;
  try {
    const qs = new URLSearchParams(buildAdminTableQuery(params));
    if (flagged !== null) qs.set("flagged", flagged);
    if (verdict !== null) qs.set("verdict", verdict);
    if (confidence !== null) qs.set("confidence", confidence);
    body = await adminApiFetch("/api/admin/content/startups", qs.toString());
  } catch (err: unknown) {
    if (isRedirectError(err)) throw err;
    loadError =
      err instanceof AdminApiError ? err.message : "Failed to load content";
  }

  const data = body !== null ? narrowStartups(body) : null;
  if (data === null && loadError === null) {
    loadError = "Unexpected content response shape";
  }

  // Evidence-inspection panel (auxiliary — never fails the queue).
  let details: {
    startupName: string;
    assumptions: number;
    evidence: { claim: string }[];
    decisions: { verdict: string; confidence: string; created_at: string }[];
    traces: number;
  } | null = null;
  if (focusId !== null) {
    try {
      const detailBody: unknown = await adminApiFetch(
        "/api/admin/content/details",
        `startup_id=${encodeURIComponent(focusId)}`,
      );
      if (isRecord(detailBody) && isRecord(detailBody["startup"])) {
        const startup = detailBody["startup"] as Record<string, unknown>;
        const evidenceRows = Array.isArray(detailBody["evidence"])
          ? (detailBody["evidence"] as unknown[]).filter(isRecord)
          : [];
        const decisionRows = Array.isArray(detailBody["decisions"])
          ? (detailBody["decisions"] as unknown[]).filter(isRecord)
          : [];
        details = {
          startupName:
            typeof startup["name"] === "string"
              ? (startup["name"] as string)
              : focusId,
          assumptions: Array.isArray(detailBody["assumptions"])
            ? (detailBody["assumptions"] as unknown[]).length
            : 0,
          evidence: evidenceRows.slice(0, 10).map((row) => ({
            claim:
              typeof row["claim"] === "string" ? (row["claim"] as string) : "—",
          })),
          decisions: decisionRows.slice(0, 10).map((row) => ({
            verdict:
              typeof row["verdict"] === "string"
                ? (row["verdict"] as string)
                : "—",
            confidence:
              typeof row["confidence"] === "string"
                ? (row["confidence"] as string)
                : "—",
            created_at:
              typeof row["created_at"] === "string"
                ? (row["created_at"] as string)
                : "",
          })),
          traces: Array.isArray(detailBody["traces"])
            ? (detailBody["traces"] as unknown[]).length
            : 0,
        };
      }
    } catch (err: unknown) {
      if (isRedirectError(err)) throw err;
      details = null;
    }
  }

  const current = { q: params.q, order: params.order, limit: params.limit };
  const extraParts: string[] = [];
  if (flagged !== null) extraParts.push(`flagged=${flagged}`);
  if (verdict !== null) extraParts.push(`verdict=${verdict}`);
  if (confidence !== null) extraParts.push(`confidence=${confidence}`);
  const extra = extraParts.join("&");
  const extraSuffix = extra.length > 0 ? `&${extra}` : "";
  const pageBase = `/admin/content?sort=${params.sort}&order=${params.order}&limit=${params.limit}${params.q !== null ? `&q=${encodeURIComponent(params.q)}` : ""}${extraSuffix}`;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-black mb-1">
          Admin <span className="gradient-text">Content</span>
        </h1>
        <p className="text-slate-400 text-sm">
          Decision review queue · flag hides from the unflagged filter only
          (no effect on agent output) · screening requires admin/owner
        </p>
      </div>

      <form
        method="get"
        action="/admin/content"
        className="flex flex-wrap gap-3 mb-4 items-end"
      >
        <input type="hidden" name="sort" value={params.sort} />
        <input type="hidden" name="order" value={params.order} />
        <input type="hidden" name="limit" value={String(params.limit)} />
        <label className="text-xs text-slate-400 space-y-1">
          Search
          <input
            type="text"
            name="q"
            defaultValue={params.q ?? ""}
            minLength={2}
            placeholder="Name, claim, lead email…"
            className="block glass rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 outline-none border border-white/5 focus:border-brand-500/50 bg-transparent w-56"
          />
        </label>
        <label className="text-xs text-slate-400 space-y-1">
          Flagged
          <select
            name="flagged"
            defaultValue={flagged ?? ""}
            className="block glass rounded-lg px-2 py-2 text-sm text-slate-200 outline-none border border-white/5 bg-transparent"
          >
            <option value="">All</option>
            <option value="true">Flagged</option>
            <option value="false">Unflagged</option>
          </select>
        </label>
        <label className="text-xs text-slate-400 space-y-1">
          Verdict
          <select
            name="verdict"
            defaultValue={verdict ?? ""}
            className="block glass rounded-lg px-2 py-2 text-sm text-slate-200 outline-none border border-white/5 bg-transparent"
          >
            <option value="">Any verdict</option>
            {VALID_VERDICTS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-400 space-y-1">
          Confidence
          <select
            name="confidence"
            defaultValue={confidence ?? ""}
            className="block glass rounded-lg px-2 py-2 text-sm text-slate-200 outline-none border border-white/5 bg-transparent"
          >
            <option value="">Any confidence</option>
            {VALID_CONFIDENCE.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="glass glass-hover px-4 py-2 rounded-xl text-sm border border-white/5 text-slate-300"
        >
          Apply
        </button>
      </form>

      {focusId !== null && (
        <div className="glass rounded-2xl p-5 border border-white/10 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-slate-200">
              {details !== null ? details.startupName : "Startup detail"}
            </h2>
            <Link
              href={pageBase}
              className="text-xs text-slate-500 hover:text-slate-300"
            >
              Close ✕
            </Link>
          </div>
          {details === null ? (
            <p className="text-sm text-slate-500">
              Detail unavailable (out of scope or not found).
            </p>
          ) : (
            <div className="text-sm text-slate-300 space-y-3">
              <p className="text-xs text-slate-500">
                {details.assumptions} assumptions · {details.traces} trace
                events
              </p>
              <div>
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  Decisions
                </p>
                {details.decisions.length === 0 ? (
                  <p className="text-xs text-slate-500">No decisions yet.</p>
                ) : (
                  <ul className="space-y-1">
                    {details.decisions.map((d, i) => (
                      <li key={i} className="text-xs">
                        <span
                          className={`px-2 py-0.5 rounded-full border ${verdictBadge(d.verdict)}`}
                        >
                          {d.verdict} · {d.confidence}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  Evidence (first 10 claims)
                </p>
                {details.evidence.length === 0 ? (
                  <p className="text-xs text-slate-500">No evidence.</p>
                ) : (
                  <ul className="space-y-1 list-disc list-inside text-xs text-slate-400">
                    {details.evidence.map((e, i) => (
                      <li key={i}>{e.claim}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {loadError !== null || data === null ? (
        <div className="glass rounded-2xl p-10 text-center border border-red-500/20">
          <p className="text-red-300 text-sm">
            {loadError ?? "Failed to load content"}
          </p>
        </div>
      ) : (
        <>
          <div className="glass rounded-2xl border border-white/5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    <Link
                      href={sortHref("/admin/content", current, extra, "name", params.sort, params.order)}
                      className="hover:text-brand-400 transition-colors"
                    >
                      Startup
                      {params.sort === "name" &&
                        (params.order === "desc" ? " ▼" : " ▲")}
                    </Link>
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Latest decision
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Evidence
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    <Link
                      href={sortHref("/admin/content", current, extra, "flagged", params.sort, params.order)}
                      className="hover:text-brand-400 transition-colors"
                    >
                      Flag
                      {params.sort === "flagged" &&
                        (params.order === "desc" ? " ▼" : " ▲")}
                    </Link>
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.startups.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-10 text-center text-sm text-slate-500"
                    >
                      No startups match these filters.
                    </td>
                  </tr>
                ) : (
                  data.startups.map((s) => (
                    <tr
                      key={s.id}
                      className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]"
                    >
                      <td className="px-4 py-3 align-top">
                        <Link
                          href={`${pageBase}&startup_id=${encodeURIComponent(s.id)}`}
                          className="text-brand-400 hover:text-brand-300"
                        >
                          {s.name.length > 0 ? s.name : "Untitled"}
                        </Link>
                        {s.one_liner.length > 0 && (
                          <span className="block text-xs text-slate-500 mt-0.5">
                            {s.one_liner}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top">
                        {s.latestDecision === null ? (
                          <span className="text-xs text-slate-500">—</span>
                        ) : (
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full border ${verdictBadge(s.latestDecision.verdict)}`}
                          >
                            {s.latestDecision.verdict} ·{" "}
                            {s.latestDecision.confidence}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-300 align-top">
                        {s.evidenceCount}
                      </td>
                      <td className="px-4 py-3 align-top">
                        {s.flagged ? (
                          <span className="text-xs px-2 py-0.5 rounded-full border border-yellow-500/30 bg-yellow-500/10 text-yellow-400">
                            flagged
                          </span>
                        ) : (
                          <span className="text-xs text-slate-500">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top">
                        <ContentActions
                          startupId={s.id}
                          startupName={
                            s.name.length > 0 ? s.name : "this startup"
                          }
                          flagged={s.flagged}
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-center gap-3 mt-6">
            {data.page > 1 ? (
              <Link
                href={`${pageBase}&page=${data.page - 1}`}
                className="glass glass-hover w-9 h-9 rounded-xl flex items-center justify-center border border-white/5 text-slate-400"
                aria-label="Previous page"
              >
                ←
              </Link>
            ) : (
              <span className="w-9 h-9 rounded-xl flex items-center justify-center border border-white/5 text-slate-700 opacity-30">
                ←
              </span>
            )}
            <span className="text-xs text-slate-500">
              Page {data.page} of {data.pages} · {data.total} total
            </span>
            {data.page < data.pages ? (
              <Link
                href={`${pageBase}&page=${data.page + 1}`}
                className="glass glass-hover w-9 h-9 rounded-xl flex items-center justify-center border border-white/5 text-slate-400"
                aria-label="Next page"
              >
                →
              </Link>
            ) : (
              <span className="w-9 h-9 rounded-xl flex items-center justify-center border border-white/5 text-slate-700 opacity-30">
                →
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
