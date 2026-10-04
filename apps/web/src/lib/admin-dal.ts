import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import {
  requireAdminFromSupabase,
  toEnvelope,
  type RequireAdminResult,
} from "@/lib/admin";
import {
  createQueryDeps,
  type AdminQueryDeps,
} from "@/lib/admin-queries/shared";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** One gate per request: layout + page + every DAL call share it. */
export const getCachedAdminContext = cache(
  async (): Promise<RequireAdminResult> => {
    return requireAdminFromSupabase();
  },
);

export interface DalError {
  status: number;
  code: string;
  message: string;
}

export type DalResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: DalError };

/**
 * Runs a query helper with the cached gate. Gate 401/403 → redirect
 * (layout parity: ANY gate failure redirects to /login). Data failures
 * normalize through toEnvelope, exactly like the routes.
 */
export async function runAdminQuery<T>(
  fn: (deps: AdminQueryDeps) => Promise<T>,
): Promise<DalResult<T>> {
  let admin: RequireAdminResult;
  try {
    admin = await getCachedAdminContext();
  } catch {
    redirect("/login");
  }
  try {
    const deps = await createQueryDeps(admin);
    return { ok: true, data: await fn(deps) };
  } catch (err: unknown) {
    if (isRedirectError(err)) throw err;
    const envelope = toEnvelope(err);
    const body: unknown = envelope.body;
    return {
      ok: false,
      error: {
        status: envelope.status,
        code:
          isRecord(body) && typeof body["code"] === "string"
            ? (body["code"] as string)
            : "REQUEST_FAILED",
        message:
          isRecord(body) && typeof body["error"] === "string"
            ? (body["error"] as string)
            : "Admin request failed",
      },
    };
  }
}
