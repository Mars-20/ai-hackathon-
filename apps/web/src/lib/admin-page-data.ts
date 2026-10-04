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
