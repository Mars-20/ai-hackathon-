// ─────────────────────────────────────────────────────────────────────────────
// AdminTable — server-rendered sort/paginate/search table (spec §3).
// No client JS: sorting and pagination are Links, search is a GET form, so
// a Server Component suffices. Pages parse params with
// parseAdminTableParams (page 20/max 100, q min 2, allowlisted sort) and
// pass the narrowed values in; this component only renders navigation.
// ─────────────────────────────────────────────────────────────────────────────
import Link from "next/link";
import type { ReactNode } from "react";

export interface AdminTableColumn {
  key: string;
  label: string;
  sortable: boolean;
}

export interface AdminTableRow {
  key: string;
  cells: Record<string, ReactNode>;
}

interface AdminTableProps {
  basePath: string;
  columns: AdminTableColumn[];
  rows: AdminTableRow[];
  page: number;
  limit: number;
  total: number;
  pages: number;
  q: string | null;
  sort: string;
  order: "asc" | "desc";
  searchPlaceholder?: string;
}

function buildHref(
  basePath: string,
  current: { q: string | null; sort: string; order: string; limit: number },
  overrides: Record<string, string | null>,
): string {
  const qs = new URLSearchParams();
  const merged: Record<string, string | null> = {
    q: current.q,
    sort: current.sort,
    order: current.order,
    limit: String(current.limit),
    ...overrides,
  };
  for (const [key, value] of Object.entries(merged)) {
    if (value !== null && value !== "") qs.set(key, value);
  }
  const query = qs.toString();
  return query.length > 0 ? `${basePath}?${query}` : basePath;
}

export default function AdminTable({
  basePath,
  columns,
  rows,
  page,
  limit,
  total,
  pages,
  q,
  sort,
  order,
  searchPlaceholder,
}: AdminTableProps) {
  const current = { q, sort, order, limit };
  return (
    <div>
      <form
        method="get"
        action={basePath}
        className="flex flex-col sm:flex-row gap-3 mb-4"
      >
        <input
          type="text"
          name="q"
          defaultValue={q ?? ""}
          minLength={2}
          placeholder={searchPlaceholder ?? "Search (min 2 chars)..."}
          className="flex-1 glass rounded-xl px-4 py-2.5 text-sm text-slate-200 placeholder:text-slate-500 outline-none border border-white/5 focus:border-brand-500/50 transition-all"
          id="admin-table-search"
        />
        <input type="hidden" name="sort" value={sort} />
        <input type="hidden" name="order" value={order} />
        <input type="hidden" name="limit" value={String(limit)} />
        <button
          type="submit"
          className="glass glass-hover px-4 py-2.5 rounded-xl text-sm border border-white/5 text-slate-300"
        >
          Search
        </button>
      </form>

      <div className="glass rounded-2xl border border-white/5 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/5">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className="text-left px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap"
                >
                  {col.sortable ? (
                    <Link
                      href={buildHref(basePath, current, {
                        sort: col.key,
                        order:
                          sort === col.key && order === "desc" ? "asc" : "desc",
                        page: "1",
                      })}
                      className="hover:text-brand-400 transition-colors"
                    >
                      {col.label}
                      {sort === col.key &&
                        (order === "desc" ? " ▼" : " ▲")}
                    </Link>
                  ) : (
                    col.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-4 py-10 text-center text-sm text-slate-500"
                >
                  No rows found.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.key}
                  className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]"
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className="px-4 py-3 text-slate-300 align-top"
                    >
                      {row.cells[col.key] ?? "—"}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-center gap-3 mt-6">
        {page > 1 ? (
          <Link
            href={buildHref(basePath, current, {
              page: String(page - 1),
            })}
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
          Page {page} of {pages} · {total} total
        </span>
        {page < pages ? (
          <Link
            href={buildHref(basePath, current, { page: String(page + 1) })}
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
    </div>
  );
}
