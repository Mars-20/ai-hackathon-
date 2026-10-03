// ─────────────────────────────────────────────────────────────────────────────
// packages/admin/pagination.ts — shared page/limit/offset + search-query
// parsing for admin list endpoints (spec §3: defaults page 20 / max 100,
// `q` min 2 chars, sort-column allowlist per route).
// ─────────────────────────────────────────────────────────────────────────────

export const ADMIN_DEFAULT_PAGE = 1;
export const ADMIN_DEFAULT_LIMIT = 20;
export const ADMIN_MAX_LIMIT = 100;
export const ADMIN_MIN_QUERY_LENGTH = 2;

export interface Pagination {
  page: number;
  limit: number;
  offset: number;
}

/**
 * Accepts URLSearchParams (has `.get`), Next.js-style plain objects, or
 * Record maps — never throws on missing/invalid values, falls back to
 * defaults (page 1, limit 20, max 100).
 */
export type PaginationInput =
  | { get(name: string): string | null }
  | Record<string, string | number | string[] | null | undefined>;

function readParam(input: PaginationInput, name: string): string | null {
  const maybeGetter = (input as { get?: unknown }).get;
  if (typeof maybeGetter === "function") {
    const value = (input as { get(getName: string): string | null }).get(name);
    return value;
  }
  const raw: unknown = (input as Record<string, unknown>)[name];
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.length > 0 ? String(raw[0]) : null;
  return String(raw);
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

export function getPagination(searchParams: PaginationInput): Pagination {
  const page = parsePositiveInt(readParam(searchParams, "page"), ADMIN_DEFAULT_PAGE);
  const limit = Math.min(
    ADMIN_MAX_LIMIT,
    parsePositiveInt(readParam(searchParams, "limit"), ADMIN_DEFAULT_LIMIT),
  );
  return { page, limit, offset: (page - 1) * limit };
}

/**
 * Normalize a free-text query: trim, reject under-length input (default min
 * 2 chars per spec §3). Returns `null` when the query must not filter.
 */
export function parseSearchQuery(
  value: string | null | undefined,
  minLength: number = ADMIN_MIN_QUERY_LENGTH,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= minLength ? trimmed : null;
}
