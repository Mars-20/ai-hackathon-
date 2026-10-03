// ─────────────────────────────────────────────────────────────────────────────
// /admin/ops — operations console (Server Component, spec §§2,5-7).
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
import EmailResendButton from "@/components/admin/EmailResendButton";
import PlatformAdminGrantForm from "@/components/admin/PlatformAdminGrantForm";
import PlatformAdminRevokeButton from "@/components/admin/PlatformAdminRevokeButton";
import KpiCard from "@/components/admin/KpiCard";
import { adminApiFetch, AdminApiError } from "@/lib/admin-fetch";
import { isRedirectError } from "next/dist/client/components/redirect-error";

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
function runDetailHref(entry: AuditEntry): string | null {
  if (isRecord(entry.target)) {
    const sid = entry.target["startup_id"];
    if (typeof sid === "string" && sid.length > 0) {
      return `/admin/content?startup_id=${encodeURIComponent(sid)}`;
    }
    const ws = entry.target["workspace_id"];
    if (typeof ws === "string" && ws.length > 0) {
      return `/admin/workspaces/${encodeURIComponent(ws)}`;
    }
  }
  if (entry.workspace_id !== null) {
    return `/admin/workspaces/${encodeURIComponent(entry.workspace_id)}`;
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

function formatDateTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function AdminOpsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
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

  let tier: "platform" | "workspace" = "workspace";
  try {
    const meBody: unknown = await adminApiFetch("/api/admin/me");
    if (isRecord(meBody) && meBody["tier"] === "platform") tier = "platform";
  } catch (err: unknown) {
    if (isRedirectError(err)) throw err;
    tier = "workspace";
  }

  let severity: OpsSeverity | null = null;
  try {
    const sevBody: unknown = await adminApiFetch(
      "/api/admin/ops/limits",
      "window=7d",
    );
    severity = sevBody !== null ? narrowSeverity(sevBody) : null;
  } catch (err: unknown) {
    if (isRedirectError(err)) throw err;
    severity = null;
  }

  let entries: AuditEntry[] = [];
  let auditTotal = 0;
  let auditPages = 0;
  let auditError: string | null = null;
  try {
    const auditQs = new URLSearchParams();
    auditQs.set("page", String(auditPage));
    auditQs.set("limit", "20");
    if (actorFilter !== null) auditQs.set("actor", actorFilter);
    if (actionFilter !== null) auditQs.set("action", actionFilter);
    const auditBody: unknown = await adminApiFetch(
      "/api/admin/ops/audit",
      auditQs.toString(),
    );
    if (isRecord(auditBody)) {
      entries = asAuditEntries(auditBody["entries"]);
      auditTotal = asNumber(auditBody["total"]);
      auditPages = asNumber(auditBody["pages"]);
    }
  } catch (err: unknown) {
    if (isRedirectError(err)) throw err;
    auditError =
      err instanceof AdminApiError ? err.message : "Failed to load audit log";
  }

  let settings: { key: string; value: string; updated_at: string | null }[] =
    [];
  try {
    const settingsBody: unknown = await adminApiFetch("/api/admin/agent");
    if (isRecord(settingsBody) && isRecord(settingsBody["settings"])) {
      for (const [key, entry] of Object.entries(settingsBody["settings"])) {
        if (!isRecord(entry)) continue;
        const updated = entry["updated_at"];
        settings.push({
          key,
          value: JSON.stringify(entry["value"] ?? null),
          updated_at: typeof updated === "string" ? updated : null,
        });
      }
      settings.sort((a, b) => a.key.localeCompare(b.key));
    }
  } catch (err: unknown) {
    if (isRedirectError(err)) throw err;
    settings = [];
  }

  let pending: PendingInvite[] = [];
  try {
    const emailBody: unknown = await adminApiFetch("/api/admin/ops/email");
    if (isRecord(emailBody)) pending = asPendingInvites(emailBody["pending"]);
  } catch (err: unknown) {
    if (isRedirectError(err)) throw err;
    pending = [];
  }

  // Platform-admin grants (platform tier only — never fetched for the
  // workspace tier, so the section below can never render for them).
  let platformAdmins: PlatformAdmin[] = [];
  if (tier === "platform") {
    try {
      const adminsBody: unknown = await adminApiFetch(
        "/api/admin/ops/admins",
      );
      if (isRecord(adminsBody))
        platformAdmins = asPlatformAdmins(adminsBody["admins"]);
    } catch (err: unknown) {
      if (isRedirectError(err)) throw err;
      platformAdmins = [];
    }
  }

  const auditBase =
    `/admin/ops?` +
    `${actorFilter !== null ? `actor=${encodeURIComponent(actorFilter)}&` : ""}` +
    `${actionFilter !== null ? `action=${encodeURIComponent(actionFilter)}&` : ""}`;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-black mb-1">
          Admin <span className="gradient-text">Ops</span>
        </h1>
        <p className="text-slate-400 text-sm">
          {tier === "platform"
            ? "Severity, audit log, settings (read-only in v1), platform grants, invite queue"
            : "Scoped read-only view for your tier — audit and severity cover your workspaces only"}
        </p>
      </div>

      <h2 className="text-lg font-bold text-slate-200 mb-3">
        Severity (7d)
      </h2>
      {severity === null ? (
        <div className="glass rounded-2xl p-6 text-center border border-white/5 mb-8">
          <p className="text-slate-500 text-sm">Severity unavailable.</p>
        </div>
      ) : (
        <>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <KpiCard label="Errors" value={String(severity.error)} />
            <KpiCard label="Warnings" value={String(severity.warning)} />
            <KpiCard label="Info" value={String(severity.info)} />
            <KpiCard
              label="Rate-limited (429)"
              value={String(severity.rateLimited429)}
              hint="Heuristic — surfaced 429/rate-limit signals only"
            />
          </div>
          {severity.truncated && (
            <p className="text-xs text-yellow-400 border border-yellow-500/30 bg-yellow-500/10 rounded-xl px-4 py-2 mb-4">
              Server caps bound this window — figures may be truncated.
            </p>
          )}
          <div className="grid lg:grid-cols-2 gap-4 mb-8">
            <div className="glass rounded-2xl p-5 border border-white/5">
              <h3 className="text-sm font-bold text-slate-200 mb-3">
                Top error actors
              </h3>
              {severity.errorsByActor.length === 0 ? (
                <p className="text-sm text-slate-500">No errors recorded.</p>
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
                        <td className="py-1.5 text-right text-slate-300">
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
                Configured caps (read-only reference)
              </h3>
              {severity.configured.length === 0 ? (
                <p className="text-sm text-slate-500">No caps reported.</p>
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
                        <td className="py-1.5 text-right text-slate-300">
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

      <h2 className="text-lg font-bold text-slate-200 mb-3">Audit log</h2>
      <form
        method="get"
        action="/admin/ops"
        className="flex flex-wrap gap-3 mb-4 items-end"
      >
        <label className="text-xs text-slate-400 space-y-1">
          Actor (UUID)
          <input
            type="text"
            name="actor"
            defaultValue={actorFilter ?? ""}
            placeholder="Exact actor UUID"
            className="block glass rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 outline-none border border-white/5 focus:border-brand-500/50 bg-transparent w-56"
          />
        </label>
        <label className="text-xs text-slate-400 space-y-1">
          Action
          <input
            type="text"
            name="action"
            defaultValue={actionFilter ?? ""}
            placeholder="Exact action name"
            className="block glass rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 outline-none border border-white/5 focus:border-brand-500/50 bg-transparent w-56"
          />
        </label>
        <button
          type="submit"
          className="glass glass-hover px-4 py-2 rounded-xl text-sm border border-white/5 text-slate-300"
        >
          Apply
        </button>
        {(actorFilter !== null || actionFilter !== null) && (
          <Link
            href="/admin/ops"
            className="text-sm text-slate-500 hover:text-slate-300 px-2 py-2"
          >
            Clear
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
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Time
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Severity
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Action
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Actor
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Result
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Run detail
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
                      No audit entries found.
                    </td>
                  </tr>
                ) : (
                  entries.map((entry) => {
                    const sev = auditSeverity(entry.action, entry.result);
                    const href = runDetailHref(entry);
                    return (
                      <tr
                        key={entry.id}
                        className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]"
                      >
                        <td className="px-4 py-2.5 text-slate-400 text-xs whitespace-nowrap">
                          {formatDateTime(entry.created_at)}
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
                              View →
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
              Page {auditPage}
              {auditPages > 0 ? ` of ${auditPages}` : ""} · {auditTotal} total
            </span>
            {auditPages === 0 || auditPage < auditPages ? (
              <Link
                href={`${auditBase}page=${auditPage + 1}`}
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

      <h2 className="text-lg font-bold text-slate-200 mb-3">
        Agent settings{" "}
        <span className="text-xs font-normal text-slate-500">
          (read-only in v1 — no write path)
        </span>
      </h2>
      <div className="glass rounded-2xl border border-white/5 overflow-x-auto mb-8">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/5">
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Key
              </th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Value
              </th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Updated
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
                  No settings found.
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
                      ? formatDateTime(s.updated_at)
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
            Platform admins ({platformAdmins.length})
          </h2>
          <PlatformAdminGrantForm />
          <div className="glass rounded-2xl border border-white/5 overflow-x-auto mb-8">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Email
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    User ID
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Granted
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Actions
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
                      No platform admins found.
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
                          ? formatDateTime(entry.granted_at)
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
        Pending invites ({pending.length})
      </h2>
      <div className="glass rounded-2xl border border-white/5 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/5">
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Email
              </th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Role
              </th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Expires
              </th>
              {tier === "platform" && (
                <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  Actions
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
                  No pending invites.
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
                      ? formatDateTime(invite.expires_at)
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
          Invite resend is platform-managed — read-only for your tier.
        </p>
      )}
    </div>
  );
}
