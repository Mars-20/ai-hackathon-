// ─────────────────────────────────────────────────────────────────────────────
// /admin/content — decision review queue (Server Component, spec §§2-3,7).
// Reads DIRECTLY via the admin DAL (runAdminQuery + queryContentStartups /
// queryContentDetails — same helpers the GET routes delegate to, so rows
// are identical): filters flagged / verdict / confidence / q, sort
// allowlist (created_at/name/flagged), flagged-first default ordering.
// Row actions live in the ContentActions island: flag/unflag (member+) and
// policy screen approve/reject (admin/owner — API-enforced, denials
// surface as messages). ?startup_id= opens the evidence-inspection panel
// (queryContentDetails: assumptions, evidence, decisions,
// traces) — the same run-detail target linked from the ops audit table.
// ─────────────────────────────────────────────────────────────────────────────
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import ContentActions from "@/components/admin/ContentActions";
import {
  parseAdminTableParams,
} from "@/components/admin/table-helpers";
import { runAdminQuery } from "@/lib/admin-dal";
import { withLocale, type AppLocale } from "@/lib/i18n-path";
import {
  queryContentDetails,
  queryContentStartups,
  type ContentStartupsResult,
} from "@/lib/admin-queries/content";

const CONTENT_SORT_ALLOWLIST = ["created_at", "name", "flagged"] as const;
const CONTENT_DEFAULT_SORT = "created_at";

const VALID_VERDICTS = ["go", "iterate", "stop", "test_more"] as const;
const VALID_CONFIDENCE = ["low", "medium", "high"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
  params: routeParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await routeParams;
  const appLocale = locale as AppLocale;
  const contentBase = withLocale("/admin/content", appLocale);
  const t = await getTranslations("admin.content");
  const tShared = await getTranslations("shared");
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

  // Queue list and evidence panel are independent — one concurrent DAL
  // round (same helpers the GET routes delegate to, so figures are
  // identical). Gate failures (401 → /login) throw redirect errors that
  // propagate uncaught from the Promise.all; data failures arrive as
  // values — the list failure fails the queue, the detail failure only
  // hides the panel, exactly like the loader's settled pattern.
  const [startupsResult, detailsResult] = await Promise.all([
    runAdminQuery((deps) =>
      queryContentStartups(deps, {
        page: params.page,
        limit: params.limit,
        sort: params.sort,
        order: params.order,
        q: params.q,
        flagged,
        verdict,
        confidence,
      }),
    ),
    focusId !== null
      ? runAdminQuery((deps) => queryContentDetails(deps, focusId))
      : Promise.resolve(null),
  ]);

  let loadError: string | null = null;
  let data: ContentStartupsResult | null = null;
  if (startupsResult.ok) {
    data = startupsResult.data;
  } else {
    loadError = startupsResult.error.message;
  }

  // Evidence-inspection panel (auxiliary — never fails the queue).
  // Arrived in the same concurrent round as the list above.
  const detailBody =
    detailsResult !== null && detailsResult.ok ? detailsResult.data : null;
  let details: {
    startupName: string;
    assumptions: number;
    evidence: { claim: string }[];
    decisions: { verdict: string; confidence: string; created_at: string }[];
    traces: number;
  } | null = null;
  if (detailBody !== null) {
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
            : (focusId ?? ""),
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
  }

  const current = { q: params.q, order: params.order, limit: params.limit };
  const extraParts: string[] = [];
  if (flagged !== null) extraParts.push(`flagged=${flagged}`);
  if (verdict !== null) extraParts.push(`verdict=${verdict}`);
  if (confidence !== null) extraParts.push(`confidence=${confidence}`);
  const extra = extraParts.join("&");
  const extraSuffix = extra.length > 0 ? `&${extra}` : "";
  const pageBase = `${contentBase}?sort=${params.sort}&order=${params.order}&limit=${params.limit}${params.q !== null ? `&q=${encodeURIComponent(params.q)}` : ""}${extraSuffix}`;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-black mb-1">
          {t("titlePrefix")} <span className="gradient-text">{t("titleAccent")}</span>
        </h1>
        <p className="text-slate-400 text-sm">
          {t("sub")}
        </p>
      </div>

      <form
        method="get"
        action={contentBase}
        className="flex flex-wrap gap-3 mb-4 items-end"
      >
        <input type="hidden" name="sort" value={params.sort} />
        <input type="hidden" name="order" value={params.order} />
        <input type="hidden" name="limit" value={String(params.limit)} />
        <label className="text-xs text-slate-400 space-y-1">
          {t("filters.search")}
          <input
            type="text"
            name="q"
            defaultValue={params.q ?? ""}
            minLength={2}
            placeholder={t("filters.searchPlaceholder")}
            className="block glass rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 outline-none border border-white/5 focus:border-brand-500/50 bg-transparent w-56"
          />
        </label>
        <label className="text-xs text-slate-400 space-y-1">
          {t("filters.flagged")}
          <select
            name="flagged"
            defaultValue={flagged ?? ""}
            className="block glass rounded-lg px-2 py-2 text-sm text-slate-200 outline-none border border-white/5 bg-transparent"
          >
            <option value="">{t("filters.allOpt")}</option>
            <option value="true">{t("filters.flaggedOpt")}</option>
            <option value="false">{t("filters.unflaggedOpt")}</option>
          </select>
        </label>
        <label className="text-xs text-slate-400 space-y-1">
          {t("filters.verdict")}
          <select
            name="verdict"
            defaultValue={verdict ?? ""}
            className="block glass rounded-lg px-2 py-2 text-sm text-slate-200 outline-none border border-white/5 bg-transparent"
          >
            <option value="">{t("filters.anyVerdict")}</option>
            {VALID_VERDICTS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-400 space-y-1">
          {t("filters.confidence")}
          <select
            name="confidence"
            defaultValue={confidence ?? ""}
            className="block glass rounded-lg px-2 py-2 text-sm text-slate-200 outline-none border border-white/5 bg-transparent"
          >
            <option value="">{t("filters.anyConfidence")}</option>
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
          {tShared("actions.apply")}
        </button>
      </form>

      {focusId !== null && (
        <div className="glass rounded-2xl p-5 border border-white/10 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-slate-200">
              {details !== null ? details.startupName : t("detailFallback")}
            </h2>
            <Link
              href={pageBase}
              className="text-xs text-slate-500 hover:text-slate-300"
            >
              {tShared("actions.close")} ✕
            </Link>
          </div>
          {details === null ? (
            <p className="text-sm text-slate-500">
              {t("detailUnavailable")}
            </p>
          ) : (
            <div className="text-sm text-slate-300 space-y-3">
              <p className="text-xs text-slate-500">
                {t("detailCountsPattern", {
                  assumptions: details.assumptions,
                  traces: details.traces,
                })}
              </p>
              <div>
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                  {t("detailDecisions")}
                </p>
                {details.decisions.length === 0 ? (
                  <p className="text-xs text-slate-500">{t("noDecisions")}</p>
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
                  {t("detailEvidence")}
                </p>
                {details.evidence.length === 0 ? (
                  <p className="text-xs text-slate-500">{t("noEvidence")}</p>
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
            {loadError ?? t("loadFailed")}
          </p>
        </div>
      ) : (
        <>
          <div className="glass rounded-2xl border border-white/5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    <Link
                      href={sortHref(contentBase, current, extra, "name", params.sort, params.order)}
                      className="hover:text-brand-400 transition-colors"
                    >
                      {t("cols.startup")}
                      {params.sort === "name" &&
                        (params.order === "desc" ? " ▼" : " ▲")}
                    </Link>
                  </th>
                  <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    {t("cols.latestDecision")}
                  </th>
                  <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    {t("cols.evidence")}
                  </th>
                  <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    <Link
                      href={sortHref(contentBase, current, extra, "flagged", params.sort, params.order)}
                      className="hover:text-brand-400 transition-colors"
                    >
                      {t("cols.flag")}
                      {params.sort === "flagged" &&
                        (params.order === "desc" ? " ▼" : " ▲")}
                    </Link>
                  </th>
                  <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    {t("cols.actions")}
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
                      {t("emptyQueue")}
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
                          {s.name.length > 0 ? s.name : t("untitled")}
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
                            s.name.length > 0 ? s.name : t("untitledStartup")
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
                aria-label={tShared("misc.previousPage")}
              >
                <span className="inline-block rtl:scale-x-[-1]">←</span>
              </Link>
            ) : (
              <span className="w-9 h-9 rounded-xl flex items-center justify-center border border-white/5 text-slate-700 opacity-30">
                <span className="inline-block rtl:scale-x-[-1]">←</span>
              </span>
            )}
            <span className="text-xs text-slate-500">
              {tShared("pagination.pageXofY", { x: data.page, y: data.pages })} ·{" "}
              {tShared("pagination.totalOf", { total: data.total })}
            </span>
            {data.page < data.pages ? (
              <Link
                href={`${pageBase}&page=${data.page + 1}`}
                className="glass glass-hover w-9 h-9 rounded-xl flex items-center justify-center border border-white/5 text-slate-400"
                aria-label={tShared("misc.nextPage")}
              >
                <span className="inline-block rtl:scale-x-[-1]">→</span>
              </Link>
            ) : (
              <span className="w-9 h-9 rounded-xl flex items-center justify-center border border-white/5 text-slate-700 opacity-30">
                <span className="inline-block rtl:scale-x-[-1]">→</span>
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
