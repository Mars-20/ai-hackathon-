// ─────────────────────────────────────────────────────────────────────────────
// apps/web/src/components/admin/table-helpers.ts — shared AdminTable query
// parsing (spec §3: defaults page 20 / max 100, `q` min 2 chars,
// sort-column allowlist per page). Pure + dependency-free so both Server
// Components and the node TDD-equivalent check can import it without
// pulling Supabase wiring.
// ─────────────────────────────────────────────────────────────────────────────

export const ADMIN_TABLE_DEFAULT_LIMIT = 20;
export const ADMIN_TABLE_MAX_LIMIT = 100;
export const ADMIN_TABLE_MIN_QUERY_LENGTH = 2;

export interface AdminTableParams {
  page: number;
  limit: number;
  offset: number;
  q: string | null;
  sort: string;
  order: "asc" | "desc";
}

export type TableParamInput =
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>;

function readParam(input: TableParamInput, name: string): string | null {
  const maybeGetter = (input as { get?: unknown }).get;
  if (typeof maybeGetter === "function") {
    return (input as { get(getName: string): string | null }).get(name);
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

/**
 * Parse list params from Next.js searchParams or URLSearchParams.
 * Never throws: invalid values fall back to page 1 / limit 20 (max 100),
 * under-length `q` (< 2 chars) is ignored, off-allowlist `sort` falls back
 * to `defaultSort`, and `order` is "asc" only on an exact match.
 */
export function parseAdminTableParams(
  input: TableParamInput,
  sortAllowlist: readonly string[],
  defaultSort: string,
): AdminTableParams {
  const page = parsePositiveInt(readParam(input, "page"), 1);
  const limit = Math.min(
    ADMIN_TABLE_MAX_LIMIT,
    parsePositiveInt(readParam(input, "limit"), ADMIN_TABLE_DEFAULT_LIMIT),
  );
  const rawQ = readParam(input, "q");
  const trimmed = rawQ === null ? "" : rawQ.trim();
  const q =
    trimmed.length >= ADMIN_TABLE_MIN_QUERY_LENGTH ? trimmed : null;
  const rawSort = readParam(input, "sort");
  const sort =
    rawSort !== null && sortAllowlist.includes(rawSort)
      ? rawSort
      : defaultSort;
  const order = readParam(input, "order") === "asc" ? "asc" : "desc";
  return { page, limit, offset: (page - 1) * limit, q, sort, order };
}

/** Serialize params back into a query string for /api/admin/* fetches. */
export function buildAdminTableQuery(params: AdminTableParams): string {
  const qs = new URLSearchParams();
  qs.set("page", String(params.page));
  qs.set("limit", String(params.limit));
  if (params.q !== null) qs.set("q", params.q);
  qs.set("sort", params.sort);
  qs.set("order", params.order);
  return qs.toString();
}
