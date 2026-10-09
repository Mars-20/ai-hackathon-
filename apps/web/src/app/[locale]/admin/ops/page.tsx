// ─────────────────────────────────────────────────────────────────────────────
// /admin/ops — operations console (Server Component, spec §§2,5-7).
// Reads DIRECTLY via the admin DAL (runAdminQuery + queryOps* — same
// helpers the GET routes delegate to, so figures are identical).
// Nav entry is platform-only (§7 matrix), but the underlying reads are
// member+ (audit/limits/email/settings GETs), so a workspace-tier caller
// reaching this URL directly still gets a scoped, read-only view: audit +
// severity scoped to own workspaces, settings read-only (no v1 write
// path), email queue visible, resend + plan/status controls withheld.
// Sections: severity cards (GET /api/admin/ops/limits) incl. errors by
// actor; audit-log table (GET /api/admin/ops/audit, actor/action filters)
// with derived severity badges + run-detail links (target.startup_id →
// /admin/content?startup_id=, target.workspace_id → workspace detail);
// agent settings read view (GET /api/admin/agent, no secrets —
// key/value/updated_at only); platform-admin grants (GET/POST/DELETE
// /api/admin/ops/admins, platform-tier only — never rendered for the
// workspace tier); pending-invite queue (GET
// /api/admin/ops/email) with the platform-only EmailResendButton island.
// ─────────────────────────────────────────────────────────────────────────────
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import EmailResendButton from "@/components/admin/EmailResendButton";
import PlatformAdminGrantForm from "@/components/admin/PlatformAdminGrantForm";
import PlatformAdminRevokeButton from "@/components/admin/PlatformAdminRevokeButton";
import KpiCard from "@/components/admin/KpiCard";
import { getCachedAdminContext, runAdminQuery } from "@/lib/admin-dal";
import { withLocale, type AppLocale } from "@/lib/i18n-path";
import {
  queryAgentSettings,
  queryOpsAdmins,
  queryOpsAudit,
  queryOpsEmail,
  queryOpsLimits,
} from "@/lib/admin-queries/ops";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

type Severity = "error" | "warning" | "info";

function auditSeverity(action: string, result: string): Severity {
  const text = `${action} ${result}`.toLowerCase();
  if (
    text.includes("suspend") ||
    text.includes("revoke") ||
    text.includes("denied") ||
    text.includes("forbidden") ||
    text.includes("error") ||
    text.includes("fail")
  ) {
    return "error";
  }
  if (
    text.includes("flag") ||
    text.includes("screen") ||
    text.includes("resend") ||
    text.includes("warn")
  ) {
    return "warning";
  }
  return "info";
}

function severityBadge(sev: Severity): string {
  if (sev === "error")
    return "border-red-500/30 bg-red-500/10 text-red-400";
  if (sev === "warning")
    return "border-yellow-500/30 bg-yellow-500/10 text-yellow-400";
  return "border-sky-500/30 bg-sky-500/10 text-sky-400";
}

interface AuditEntry {
  id: string;
  actor: string | null;
  action: string;
  target: unknown;
  reason: string | null;
  result: string;
  workspace_id: string | null;
  created_at: string;
}

function asAuditEntries(value: unknown): AuditEntry[] {
  if (!Array.isArray(value)) return [];
  const out: AuditEntry[] = [];
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
      result: typeof result === "string" ? result : "",
      workspace_id: typeof ws === "string" ? ws : null,
      created_at: item["created_at"] as string,
    });
  }
  return out;
}

/** Run-detail link for an audit entry: startup → content detail panel. */
function runDetailHref(entry: AuditEntry, locale: AppLocale): string | null {
  if (isRecord(entry.target)) {
    const sid = entry.target["startup_id"];
    if (typeof sid === "string" && sid.length > 0) {
      return withLocale(`/admin/content?startup_id=${encodeURIComponent(sid)}`, locale);
    }
    const ws = entry.target["workspace_id"];
    if (typeof ws === "string" && ws.length > 0) {
      return withLocale(`/admin/workspaces/${encodeURIComponent(ws)}`, locale);
    }
  }
  if (entry.workspace_id !== null) {
    return withLocale(`/admin/workspaces/${encodeURIComponent(entry.workspace_id)}`, locale);
  }
  return null;
}

function shortId(id: string | null): string {
  if (id === null || id.length === 0) return "—";
  return `${id.slice(0, 8)}…`;
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

interface OpsSeverity {
  error: number;
  warning: number;
  info: number;
  rateLimited429: number;
  errorsByActor: { actor: string; count: number }[];
  configured: { label: string; value: string }[];
  truncated: boolean;
}

function narrowSeverity(body: unknown): OpsSeverity | null {
  if (!isRecord(body) || !isRecord(body["severity"])) return null;
  const sev = body["severity"] as Record<string, unknown>;
  const errorsByActor: { actor: string; count: number }[] = [];
  if (isRecord(body["errorsByActor"])) {
    for (const [actor, count] of Object.entries(body["errorsByActor"])) {
      if (typeof count === "number" && Number.isFinite(count)) {
        errorsByActor.push({ actor, count });
      }
    }
    errorsByActor.sort((a, b) => b.count - a.count);
  }
  const configured: { label: string; value: string }[] = [];
  if (isRecord(body["configured"])) {
    for (const [label, value] of Object.entries(body["configured"])) {
      configured.push({ label, value: String(value) });
    }
  }
  return {
    error: asNumber(sev["error"]),
    warning: asNumber(sev["warning"]),
    info: asNumber(sev["info"]),
    rateLimited429: asNumber(body["rateLimited429"]),
    errorsByActor: errorsByActor.slice(0, 10),
    configured,
    truncated: body["truncated"] === true,
  };
}

interface PendingInvite {
  id: string;
  workspace_id: string;
  email: string;
  role: string;
  status: string;
  expires_at: string | null;
}

function asPendingInvites(value: unknown): PendingInvite[] {
  if (!Array.isArray(value)) return [];
  const out: PendingInvite[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (
      typeof item["id"] !== "string" ||
      typeof item["workspace_id"] !== "string" ||
      typeof item["email"] !== "string"
    ) {
      continue;
    }
    const expires = item["expires_at"];
    out.push({
      id: item["id"] as string,
      workspace_id: item["workspace_id"] as string,
      email: item["email"] as string,
      role: typeof item["role"] === "string" ? (item["role"] as string) : "",
      status:
        typeof item["status"] === "string" ? (item["status"] as string) : "",
      expires_at: typeof expires === "string" ? expires : null,
    });
  }
  return out;
}

interface PlatformAdmin {
  user_id: string;
  email: string;
  granted_by: string | null;
  granted_at: string;
}

function asPlatformAdmins(value: unknown): PlatformAdmin[] {
  if (!Array.isArray(value)) return [];
  const out: PlatformAdmin[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item["user_id"] !== "string") continue;
    const grantedBy = item["granted_by"];
    const grantedAt = item["granted_at"];
    out.push({
      user_id: item["user_id"] as string,
      email: typeof item["email"] === "string" ? (item["email"] as string) : "",
      granted_by: typeof grantedBy === "string" ? grantedBy : null,
      granted_at: typeof grantedAt === "string" ? grantedAt : "",
    });
  }
  return out;
}

function formatDateTime(iso: string, locale: AppLocale): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString(locale === "ar" ? "ar-EG-u-nu-latn" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function AdminOpsPage({
  searchParams,
  params,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const appLocale = locale as AppLocale;
  const opsBase = withLocale("/admin/ops", appLocale);
  const t = await getTranslations("admin.ops");
  const tShared = await getTranslations("shared");
  const raw = await searchParams;
  const actorFilter = readSingle(raw, "actor");
  const actionFilter = readSingle(raw, "action");
  const auditPageRaw = readSingle(raw, "page");
  const auditPage =
    auditPageRaw !== null &&
    Number.isFinite(Number.parseInt(auditPageRaw, 10)) &&
    Number.parseInt(auditPageRaw, 10) >= 1
      ? Number.parseInt(auditPageRaw, 10)
      : 1;

  // The five ops reads are independent — one concurrent DAL round (same
  // helpers the GET routes delegate to, so figures are identical). The
  // platform-only admins read joins the same round (workspace tier passes
  // null so the section below can never render for them). Gate
  // failures (401 → /login) throw redirect errors that propagate uncaught;
  // data failures arrive as values and each section renders its own
  // "unavailable" state, exactly like the loader's settled pattern.
  const admin = await getCachedAdminContext();
  const tier = admin.tier;
  const [limitsResult, auditResult, agentResult, emailResult, adminsResult] =
    await Promise.all([
      runAdminQuery((deps) => queryOpsLimits(deps, "7d")),
      runAdminQuery((deps) =>
        queryOpsAudit(deps, {
          page: auditPageRaw,
          limit: "20",
          actor: actorFilter,
          action: actionFilter,
        }),
      ),
      runAdminQuery((deps) => queryAgentSettings(deps)),
      runAdminQuery((deps) => queryOpsEmail(deps)),
      tier === "platform"
        ? runAdminQuery((deps) => queryOpsAdmins(deps))
        : Promise.resolve(null),
    ]);

  const severity =
    limitsResult.ok === true ? narrowSeverity(limitsResult.data) : null;

  let entries: AuditEntry[] = [];
  let auditTotal = 0;
  let auditPages = 0;
  const auditError =
    auditResult.ok === true
      ? null
      : (auditResult.error.message ?? t("auditLoadFailed"));
  if (auditResult.ok === true) {
    entries = asAuditEntries(auditResult.data.entries);
    auditTotal = auditResult.data.total;
    auditPages = auditResult.data.pages;
  }

  const settings: { key: string; value: string; updated_at: string | null }[] =
    [];
  if (agentResult.ok === true) {
    for (const [key, entry] of Object.entries(agentResult.data.settings)) {
      settings.push({
        key,
        value: JSON.stringify(entry.value ?? null),
        updated_at: entry.updated_at,
      });
    }
    settings.sort((a, b) => a.key.localeCompare(b.key));
  }

  let pending: PendingInvite[] = [];
  if (emailResult.ok === true)
    pending = asPendingInvites(emailResult.data.pending);

  // Platform-admin grants (platform tier only — adminsResult is null for
  // the workspace tier, so the section below can never render for them).
  let platformAdmins: PlatformAdmin[] = [];
  if (adminsResult !== null && adminsResult.ok === true)
    platformAdmins = asPlatformAdmins(adminsResult.data.admins);

  const auditBase =
    `${opsBase}?` +
    `${actorFilter !== null ? `actor=${encodeURIComponent(actorFilter)}&` : ""}` +
    `${actionFilter !== null ? `action=${encodeURIComponent(actionFilter)}&` : ""}`;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-black mb-1">
          {t("titlePrefix")} <span className="gradient-text">{t("titleAccent")}</span>
        </h1>
        <p className="text-slate-400 text-sm">
          {tier === "platform" ? t("subPlatform") : t("subWorkspace")}
        </p>
      </div>

      <h2 className="text-lg font-bold text-slate-200 mb-3">
        {t("severityTitle")}
      </h2>
      {severity === null ? (
        <div className="glass rounded-2xl p-6 text-center border border-white/5 mb-8">
          <p className="text-slate-500 text-sm">{t("severityUnavailable")}</p>
        </div>
      ) : (
        <>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <KpiCard label={t("kpi.errors")} value={String(severity.error)} />
            <KpiCard label={t("kpi.warnings")} value={String(severity.warning)} />
            <KpiCard label={t("kpi.info")} value={String(severity.info)} />
            <KpiCard
              label={t("kpi.rateLimited")}
              value={String(severity.rateLimited429)}
              hint={t("hints.rateLimited")}
            />
          </div>
          {severity.truncated && (
            <p className="text-xs text-yellow-400 border border-yellow-500/30 bg-yellow-500/10 rounded-xl px-4 py-2 mb-4">
              {tShared("misc.truncatedNote")}
            </p>
          )}
          <div className="grid lg:grid-cols-2 gap-4 mb-8">
            <div className="glass rounded-2xl p-5 border border-white/5">
              <h3 className="text-sm font-bold text-slate-200 mb-3">
                {t("topActors")}
              </h3>
              {severity.errorsByActor.length === 0 ? (
                <p className="text-sm text-slate-500">{t("noErrors")}</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {severity.errorsByActor.map((row) => (
                      <tr
                        key={row.actor}
                        className="border-b border-white/5 last:border-0"
                      >
                        <td className="py-1.5 text-slate-300 font-mono text-xs">
                          {shortId(row.actor)}
                        </td>
                        <td className="py-1.5 text-end text-slate-300">
                          {row.count}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="glass rounded-2xl p-5 border border-white/5">
              <h3 className="text-sm font-bold text-slate-200 mb-3">
                {t("capsTitle")}
              </h3>
              {severity.configured.length === 0 ? (
                <p className="text-sm text-slate-500">{t("noCaps")}</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {severity.configured.map((row) => (
                      <tr
                        key={row.label}
                        className="border-b border-white/5 last:border-0"
                      >
                        <td className="py-1.5 text-slate-400 text-xs">
                          {row.label}
                        </td>
                        <td className="py-1.5 text-end text-slate-300">
                          {row.value}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}

      <h2 className="text-lg font-bold text-slate-200 mb-3">{t("auditTitle")}</h2>
      <form
        method="get"
        action={opsBase}
        className="flex flex-wrap gap-3 mb-4 items-end"
      >
        <label className="text-xs text-slate-400 space-y-1">
          {t("filters.actorLabel")}
          <input
            type="text"
            name="actor"
            defaultValue={actorFilter ?? ""}
            placeholder={t("filters.actorPlaceholder")}
            className="block glass rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 outline-none border border-white/5 focus:border-brand-500/50 bg-transparent w-56"
          />
        </label>
        <label className="text-xs text-slate-400 space-y-1">
          {t("filters.actionLabel")}
          <input
            type="text"
            name="action"
            defaultValue={actionFilter ?? ""}
            placeholder={t("filters.actionPlaceholder")}
            className="block glass rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 outline-none border border-white/5 focus:border-brand-500/50 bg-transparent w-56"
          />
        </label>
        <button
          type="submit"
          className="glass glass-hover px-4 py-2 rounded-xl text-sm border border-white/5 text-slate-300"
        >
          {tShared("actions.apply")}
        </button>
        {(actorFilter !== null || actionFilter !== null) && (
          <Link
            href={opsBase}
            className="text-sm text-slate-500 hover:text-slate-300 px-2 py-2"
          >
            {tShared("actions.clear")}
          </Link>
        )}
      </form>

      {auditError !== null ? (
        <div className="glass rounded-2xl p-10 text-center border border-red-500/20 mb-8">
          <p className="text-red-300 text-sm">{auditError}</p>
        </div>
      ) : (
        <>
          <div className="glass rounded-2xl border border-white/5 overflow-x-auto mb-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    {t("auditCols.time")}
                  </th>
                  <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    {t("auditCols.severity")}
                  </th>
                  <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    {t("auditCols.action")}
                  </th>
                  <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    {t("auditCols.actor")}
                  </th>
                  <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    {t("auditCols.result")}
                  </th>
                  <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    {t("auditCols.runDetail")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-10 text-center text-sm text-slate-500"
                    >
                      {t("emptyAudit")}
                    </td>
                  </tr>
                ) : (
                  entries.map((entry) => {
                    const sev = auditSeverity(entry.action, entry.result);
                    const href = runDetailHref(entry, appLocale);
                    return (
                      <tr
                        key={entry.id}
                        className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]"
                      >
                        <td className="px-4 py-2.5 text-slate-400 text-xs whitespace-nowrap">
                          {formatDateTime(entry.created_at, appLocale)}
                        </td>
                        <td className="px-4 py-2.5">
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full border ${severityBadge(sev)}`}
                          >
                            {sev}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-slate-300 font-mono text-xs">
                          {entry.action}
                        </td>
                        <td className="px-4 py-2.5 text-slate-500 font-mono text-xs">
                          {shortId(entry.actor)}
                        </td>
                        <td className="px-4 py-2.5 text-slate-300 text-xs">
                          {entry.result.length > 0 ? entry.result : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-xs">
                          {href !== null ? (
                            <Link
                              href={href}
                              className="text-brand-400 hover:text-brand-300"
                            >
                              {t("viewLink")} <span className="inline-block rtl:scale-x-[-1]">→</span>
                            </Link>
                          ) : (
                            <span className="text-slate-600">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-center gap-3 mt-2 mb-8">
            {auditPage > 1 ? (
              <Link
                href={`${auditBase}page=${auditPage - 1}`}
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
              {auditPages > 0
                ? tShared("pagination.pageXofY", { x: auditPage, y: auditPages })
                : t("auditPageOnly", { x: auditPage })}{" "}
              · {tShared("pagination.totalOf", { total: auditTotal })}
            </span>
            {auditPages === 0 || auditPage < auditPages ? (
              <Link
                href={`${auditBase}page=${auditPage + 1}`}
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

      <h2 className="text-lg font-bold text-slate-200 mb-3">
        {t("settingsTitle")}{" "}
        <span className="text-xs font-normal text-slate-500">
          {t("settingsNote")}
        </span>
      </h2>
      <div className="glass rounded-2xl border border-white/5 overflow-x-auto mb-8">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/5">
              <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                {t("settingsCols.key")}
              </th>
              <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                {t("settingsCols.value")}
              </th>
              <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                {t("settingsCols.updated")}
              </th>
            </tr>
          </thead>
          <tbody>
            {settings.length === 0 ? (
              <tr>
                <td
                  colSpan={3}
                  className="px-4 py-10 text-center text-sm text-slate-500"
                >
                  {t("emptySettings")}
                </td>
              </tr>
            ) : (
              settings.map((s) => (
                <tr
                  key={s.key}
                  className="border-b border-white/5 last:border-0"
                >
                  <td className="px-4 py-2.5 text-slate-300 font-mono text-xs">
                    {s.key}
                  </td>
                  <td className="px-4 py-2.5 text-slate-400 font-mono text-xs break-all">
                    {s.value}
                  </td>
                  <td className="px-4 py-2.5 text-slate-500 text-xs whitespace-nowrap">
                    {s.updated_at !== null
                      ? formatDateTime(s.updated_at, appLocale)
                      : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {tier === "platform" && (
        <>
          <h2 className="text-lg font-bold text-slate-200 mb-3">
            {t("platformAdminsPattern", { count: platformAdmins.length })}
          </h2>
          <PlatformAdminGrantForm />
          <div className="glass rounded-2xl border border-white/5 overflow-x-auto mb-8">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    {t("adminCols.email")}
                  </th>
                  <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    {t("adminCols.userId")}
                  </th>
                  <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    {t("adminCols.granted")}
                  </th>
                  <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    {t("adminCols.actions")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {platformAdmins.length === 0 ? (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-4 py-10 text-center text-sm text-slate-500"
                    >
                      {t("emptyAdmins")}
                    </td>
                  </tr>
                ) : (
                  platformAdmins.map((entry) => (
                    <tr
                      key={entry.user_id}
                      className="border-b border-white/5 last:border-0"
                    >
                      <td className="px-4 py-2.5 text-slate-300">
                        {entry.email.length > 0 ? entry.email : "—"}
                      </td>
                      <td className="px-4 py-2.5 text-slate-500 font-mono text-xs">
                        {shortId(entry.user_id)}
                      </td>
                      <td className="px-4 py-2.5 text-slate-500 text-xs">
                        {entry.granted_at.length > 0
                          ? formatDateTime(entry.granted_at, appLocale)
                          : "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        <PlatformAdminRevokeButton
                          userId={entry.user_id}
                          userEmail={entry.email}
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2 className="text-lg font-bold text-slate-200 mb-3">
        {t("pendingInvitesPattern", { count: pending.length })}
      </h2>
      <div className="glass rounded-2xl border border-white/5 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/5">
              <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                {t("inviteCols.email")}
              </th>
              <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                {t("inviteCols.role")}
              </th>
              <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                {t("inviteCols.expires")}
              </th>
              {tier === "platform" && (
                <th className="text-start px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  {t("inviteCols.actions")}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {pending.length === 0 ? (
              <tr>
                <td
                  colSpan={tier === "platform" ? 4 : 3}
                  className="px-4 py-10 text-center text-sm text-slate-500"
                >
                  {t("emptyInvites")}
                </td>
              </tr>
            ) : (
              pending.map((invite) => (
                <tr
                  key={invite.id}
                  className="border-b border-white/5 last:border-0"
                >
                  <td className="px-4 py-2.5 text-slate-300">
                    {invite.email}
                  </td>
                  <td className="px-4 py-2.5 text-slate-300">{invite.role}</td>
                  <td className="px-4 py-2.5 text-slate-500 text-xs">
                    {invite.expires_at !== null
                      ? formatDateTime(invite.expires_at, appLocale)
                      : "—"}
                  </td>
                  {tier === "platform" && (
                    <td className="px-4 py-2.5">
                      <EmailResendButton
                        inviteId={invite.id}
                        inviteEmail={invite.email}
                      />
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {tier !== "platform" && (
        <p className="text-xs text-slate-500 mt-2">
          {t("resendNote")}
        </p>
      )}
    </div>
  );
}
