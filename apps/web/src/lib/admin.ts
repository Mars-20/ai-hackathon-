// ─────────────────────────────────────────────────────────────────────────────
// apps/web/src/lib/admin.ts — Task 3 routed-in fix (ledger
// .superpowers/sdd/admin-dashboard/progress.md): FIRST create this file with
// requireAdminFromSupabase() zero-arg wrapper building the 3-closure deps
// from createServerSupabaseClient() (keeps packages/admin decoupled).
//
// All Task 3 routes use this wrapper; the adapter below is never repeated.
// Errors normalize via toEnvelope()/isAdminErrorLike() — structural guards only.
// Service-role key never leaves the server (this module is server-only).
// ─────────────────────────────────────────────────────────────────────────────
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { requireAdmin } from "../../../../packages/admin/requireAdmin";
import type {
  RequireAdminDeps,
  RequireAdminResult,
} from "../../../../packages/admin/requireAdmin";
import { isMembershipRow } from "../../../../packages/admin/requireAdmin";
import {
  isAdminErrorLike,
  toEnvelope,
} from "../../../../packages/admin/errors";
import { escapePostgrest } from "../../../../packages/admin/escape";
import {
  getPagination,
  parseSearchQuery,
} from "../../../../packages/admin/pagination";
import { scopedQuery } from "../../../../packages/admin/scopedQuery";
import { audit } from "../../../../packages/admin/audit";

export type { RequireAdminResult };
export {
  audit,
  escapePostgrest,
  getPagination,
  isAdminErrorLike,
  isMembershipRow,
  parseSearchQuery,
  scopedQuery,
  toEnvelope,
};
export type { RequireAdminDeps };

/**
 * Zero-arg admin gate for /api/admin/* routes.
 * Builds the three narrow RequireAdminDeps closures from the request-scoped
 * user client so packages/admin never imports apps/web Supabase wiring.
 */
export async function requireAdminFromSupabase(): Promise<RequireAdminResult> {
  const supabase = await createServerSupabaseClient();
  return requireAdmin({
    getUser: () => {
      return supabase.auth.getUser().then(({ data }) => ({
        data: {
          user:
            data.user !== null
              ? {
                  id: data.user.id,
                  email:
                    typeof data.user.email === "string"
                      ? data.user.email
                      : undefined,
                }
              : null,
        },
      }));
    },
    checkPlatformAdmin: (userId: string) => {
      return supabase
        .rpc("is_platform_admin", { p_user: userId })
        .then(({ data, error }: { data: unknown; error: unknown }) => {
          if (error) return false;
          return data === true;
        });
    },
    listMemberships: (userId: string) => {
      return supabase
        .from("workspace_members")
        .select("workspace_id,role")
        .eq("user_id", userId)
        .then(({ data, error }: { data: unknown; error: unknown }) => {
          if (error) {
            const err = new Error("Failed to load memberships");
            err.name = "AdminError";
            const withProps = err as Error & { status: number; code: string };
            withProps.status = 500;
            withProps.code = "QUERY_FAILED";
            throw withProps;
          }
          const rows: unknown = data ?? [];
          if (!Array.isArray(rows)) return [];
          return rows.filter(isMembershipRow);
        });
    },
  });
}

/**
 * Shallow structural query-builder surface for workspace-scoped reads.
 * The real PostgREST builder is used at runtime (cast through unknown);
 * declaring this minimal surface keeps generic inference shallow and
 * avoids TS2589 when calling scopedQuery with the real Supabase client.
 */
export interface AdminQueryBuilder {
  select(
    columns: string,
    options?: Record<string, string | boolean>,
  ): AdminQueryBuilder;
  eq(column: string, value: string): AdminQueryBuilder;
  gte(column: string, value: string): AdminQueryBuilder;
  lte(column: string, value: string): AdminQueryBuilder;
  not(column: string, operator: string, value: string | null): AdminQueryBuilder;
  order(column: string, options?: Record<string, boolean>): AdminQueryBuilder;
  limit(count: number): AdminQueryBuilder;
  range(from: number, to: number): AdminQueryBuilder;
  ilike(column: string, pattern: string): AdminQueryBuilder;
  in(
    column: string,
    values: string[],
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

/**
 * Workspace-scoped read through the user client (RLS) with the scoping
 * predicate `.in('workspace_id', workspaceIds)` appended inside scopedQuery
 * (single DB round-trip; NULL workspace_id rows never match the IN list).
 */
export function scopedAdminQuery(
  client: unknown,
  table: string,
  workspaceIds: string[],
  build: (base: AdminQueryBuilder) => AdminQueryBuilder,
): Promise<unknown> {
  const adapter = client as { from(table: string): AdminQueryBuilder };
  return scopedQuery<AdminQueryBuilder, unknown>(
    adapter,
    table,
    workspaceIds,
    build,
  );
}

/** Preset analytics windows (trailing days). Custom spans cap at 90d. */
export const ADMIN_WINDOW_PRESETS: Record<string, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};
export const ADMIN_WINDOW_MAX_DAYS = 90;

export type AdminWindowPreset = "7d" | "30d" | "90d" | "custom";

export interface AdminWindow {
  preset: AdminWindowPreset;
  from: string;
  to: string;
  days: number;
}

function windowBadRequest(message: string): never {
  const err = new Error(message);
  err.name = "AdminError";
  const withProps = err as Error & { status: number; code: string };
  withProps.status = 400;
  withProps.code = "BAD_REQUEST";
  throw withProps;
}

/**
 * Parse `?window=7d|30d|90d` (default `7d`) or
 * `?window=custom&from=ISO&to=ISO` (span capped at 90 days).
 * Invalid input throws a structural AdminError(400, BAD_REQUEST) which
 * routes normalize through toEnvelope() into the admin-only envelope.
 */
export function parseAdminWindow(searchParams: {
  get(name: string): string | null;
}): AdminWindow {
  const raw = (searchParams.get("window") ?? "7d").trim().toLowerCase();
  if (raw === "custom") {
    const fromRaw = searchParams.get("from");
    const toRaw = searchParams.get("to");
    if (!fromRaw || !toRaw) {
      windowBadRequest("Custom window requires both from and to");
    }
    const fromMs = Date.parse(fromRaw as string);
    const toMs = Date.parse(toRaw as string);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      windowBadRequest("Custom window from/to must be ISO dates");
    }
    if ((fromMs as number) >= (toMs as number)) {
      windowBadRequest("Custom window from must be before to");
    }
    const spanDays =
      ((toMs as number) - (fromMs as number)) / (24 * 60 * 60 * 1000);
    if (spanDays > ADMIN_WINDOW_MAX_DAYS) {
      windowBadRequest("Custom window span must not exceed 90 days");
    }
    return {
      preset: "custom",
      from: new Date(fromMs as number).toISOString(),
      to: new Date(toMs as number).toISOString(),
      days: spanDays,
    };
  }
  const days = ADMIN_WINDOW_PRESETS[raw];
  if (!days) {
    windowBadRequest("Invalid window (expected 7d, 30d, 90d, or custom)");
  }
  const to = new Date();
  const from = new Date(to.getTime() - (days as number) * 24 * 60 * 60 * 1000);
  return {
    preset: raw as AdminWindowPreset,
    from: from.toISOString(),
    to: to.toISOString(),
    days: days as number,
  };
}
