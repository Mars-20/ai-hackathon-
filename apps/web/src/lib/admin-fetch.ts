// ─────────────────────────────────────────────────────────────────────────────
// adminApiFetch — server-only fetch for /admin/* Server Components.
// Forwards the incoming request cookies (authoritative for
// requireAdminFromSupabase) plus the session Bearer token per the Supabase
// SSR best practice, so admin pages never read Supabase directly (spec §9
// non-goal). 401 (session expired) redirects to /login for UX; the API
// route's requireAdmin() remains the authoritative gate.
// ─────────────────────────────────────────────────────────────────────────────
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export class AdminApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function resolveBaseUrl(): Promise<string> {
  const configured = process.env["NEXT_PUBLIC_APP_URL"];
  if (typeof configured === "string" && configured.length > 0) {
    return configured.replace(/\/$/, "");
  }
  const headerList = await headers();
  const host =
    headerList.get("x-forwarded-host") ??
    headerList.get("host") ??
    "localhost:3000";
  const proto = headerList.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

export async function adminApiFetch(
  path: string,
  query?: string,
): Promise<unknown> {
  const base = await resolveBaseUrl();
  const cookieHeader = (await cookies()).toString();
  const supabase = await createServerSupabaseClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const res = await fetch(
    `${base}${path}${query !== undefined && query.length > 0 ? `?${query}` : ""}`,
    {
      headers: {
        cookie: cookieHeader,
        ...(session?.access_token !== undefined
          ? { authorization: `Bearer ${session.access_token}` }
          : {}),
      },
      cache: "no-store",
    },
  );

  // UX-only redirect; requireAdmin() in the route is authoritative.
  if (res.status === 401) redirect("/login");

  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      isRecord(body) && typeof body["error"] === "string"
        ? (body["error"] as string)
        : `Admin request failed (${res.status})`;
    const code =
      isRecord(body) && typeof body["code"] === "string"
        ? (body["code"] as string)
        : "REQUEST_FAILED";
    throw new AdminApiError(res.status, code, message);
  }
  return body;
}
