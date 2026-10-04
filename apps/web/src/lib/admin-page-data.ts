// ─────────────────────────────────────────────────────────────────────────────
// admin-page-data.ts — data loaders for /admin/* Server Components.
// Independent adminApiFetch calls MUST fire concurrently: every call is a
// self-HTTP roundtrip carrying a full requireAdmin gate (getUser + platform
// RPC + memberships), so sequential awaits multiply page latency.
// ─────────────────────────────────────────────────────────────────────────────
import { adminApiFetch, AdminApiError } from "@/lib/admin-fetch";
import { isRedirectError } from "next/dist/client/components/redirect-error";

export interface PickerWorkspace {
  id: string;
  name: string;
  slug: string;
}

export interface UsersPageData {
  usersBody: unknown | null;
  usersError: string | null;
  pickerWorkspaces: PickerWorkspace[];
}

/**
 * One settled backend call: redirect errors are NOT swallowed here — the
 * caller rethrows them via rethrowRedirects so 401 → /login keeps working.
 */
export interface SettledFetch {
  body: unknown;
  error: unknown;
}

async function fetchSettled(
  path: string,
  query?: string,
): Promise<SettledFetch> {
  try {
    return { body: await adminApiFetch(path, query), error: null };
  } catch (error: unknown) {
    return { body: null, error };
  }
}

function rethrowRedirects(results: SettledFetch[]): void {
  for (const r of results) {
    if (isRedirectError(r.error)) throw r.error;
  }
}

/** Same message semantics the pages had with inline try/catch. */
export function settledErrorMessage(
  error: unknown,
  fallback: string,
): string | null {
  if (error === null) return null;
  return error instanceof AdminApiError ? error.message : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function narrowPickerWorkspaces(wsBody: unknown): PickerWorkspace[] {
  const out: PickerWorkspace[] = [];
  if (isRecord(wsBody) && Array.isArray(wsBody["workspaces"])) {
    for (const item of wsBody["workspaces"] as unknown[]) {
      if (!isRecord(item) || typeof item["id"] !== "string") continue;
      out.push({
        id: item["id"] as string,
        name: typeof item["name"] === "string" ? (item["name"] as string) : "",
        slug: typeof item["slug"] === "string" ? (item["slug"] as string) : "",
      });
    }
  }
  return out;
}

/**
 * Both backend calls are independent, so they fire CONCURRENTLY via a
 * single Promise.allSettled: each hop is a self-HTTP roundtrip carrying a
 * full requireAdmin gate, and sequential awaits multiply page latency.
 * Error semantics match the old sequential code exactly: Next.js redirect
 * errors (401 → /login) are rethrown, never swallowed; a users failure
 * surfaces its message; a workspaces failure degrades to an empty picker.
 */
export async function loadUsersPageData(
  usersQuery: string,
): Promise<UsersPageData> {
  const [usersResult, wsResult] = await Promise.allSettled([
    adminApiFetch("/api/admin/users", usersQuery),
    adminApiFetch(
      "/api/admin/workspaces",
      "page=1&limit=100&sort=name&order=asc",
    ),
  ]);

  for (const result of [usersResult, wsResult]) {
    if (result.status === "rejected" && isRedirectError(result.reason)) {
      throw result.reason;
    }
  }

  let usersBody: unknown | null = null;
  let usersError: string | null = null;
  if (usersResult.status === "fulfilled") {
    usersBody = usersResult.value;
  } else {
    const err: unknown = usersResult.reason;
    usersError =
      err instanceof AdminApiError ? err.message : "Failed to load users";
  }

  const pickerWorkspaces =
    wsResult.status === "fulfilled"
      ? narrowPickerWorkspaces(wsResult.value)
      : [];

  return { usersBody, usersError, pickerWorkspaces };
}

export type AdminTier = "platform" | "workspace";

export interface OpsPageData {
  tier: AdminTier;
  me: SettledFetch;
  limits: SettledFetch;
  audit: SettledFetch;
  agent: SettledFetch;
  email: SettledFetch;
}

/**
 * The five ops reads are independent, so they fire CONCURRENTLY. Tier is
 * derived from the /api/admin/me result (same rule the page used inline:
 * platform string match, anything else → workspace).
 */
export async function loadOpsPageData(
  auditQuery: string,
): Promise<OpsPageData> {
  const [me, limits, audit, agent, email] = await Promise.all([
    fetchSettled("/api/admin/me"),
    fetchSettled("/api/admin/ops/limits", "window=7d"),
    fetchSettled("/api/admin/ops/audit", auditQuery),
    fetchSettled("/api/admin/agent"),
    fetchSettled("/api/admin/ops/email"),
  ]);
  rethrowRedirects([me, limits, audit, agent, email]);

  let tier: AdminTier = "workspace";
  if (isRecord(me.body) && me.body["tier"] === "platform") tier = "platform";
  return { tier, me, limits, audit, agent, email };
}

/**
 * Second-round fetch for the platform tier only. The admins list is never
 * requested for the workspace tier (same guarantee as the old inline code).
 */
export async function loadOpsAdmins(): Promise<SettledFetch> {
  const result = await fetchSettled("/api/admin/ops/admins");
  rethrowRedirects([result]);
  return result;
}

export interface ContentPageData {
  startups: SettledFetch;
  /** Null when no ?startup_id= focus is open. */
  details: SettledFetch | null;
}

/**
 * Queue list and evidence panel are independent (focus id is known before
 * any fetch), so they fire CONCURRENTLY when a detail panel is open.
 */
export async function loadContentPageData(
  startupsQuery: string,
  focusId: string | null,
): Promise<ContentPageData> {
  const [startups, details] = await Promise.all([
    fetchSettled("/api/admin/content/startups", startupsQuery),
    focusId !== null
      ? fetchSettled(
          "/api/admin/content/details",
          `startup_id=${encodeURIComponent(focusId)}`,
        )
      : Promise.resolve(null),
  ]);
  rethrowRedirects(
    details !== null ? [startups, details] : [startups],
  );
  return { startups, details };
}

export interface AnalyticsPageData {
  analytics: SettledFetch;
  experiments: SettledFetch;
}

/** Snapshot and experiments table are independent — fired CONCURRENTLY. */
export async function loadAnalyticsPageData(
  window: string,
): Promise<AnalyticsPageData> {
  const [analytics, experiments] = await Promise.all([
    fetchSettled(
      "/api/admin/analytics",
      `window=${encodeURIComponent(window)}`,
    ),
    fetchSettled(
      "/api/admin/analytics/experiments",
      "sort=name&order=asc&page=1&limit=20",
    ),
  ]);
  rethrowRedirects([analytics, experiments]);
  return { analytics, experiments };
}

export interface WorkspaceDetailPageData {
  detail: SettledFetch;
  siblings: SettledFetch;
}

/**
 * Detail and sibling switcher list are independent — fired CONCURRENTLY.
 * The siblings list stays auxiliary: its failure never fails the page.
 */
export async function loadWorkspaceDetailPageData(
  id: string,
): Promise<WorkspaceDetailPageData> {
  const [detail, siblings] = await Promise.all([
    fetchSettled(`/api/admin/workspaces/${encodeURIComponent(id)}`),
    fetchSettled(
      "/api/admin/workspaces",
      "page=1&limit=100&sort=name&order=asc",
    ),
  ]);
  rethrowRedirects([detail, siblings]);
  return { detail, siblings };
}
