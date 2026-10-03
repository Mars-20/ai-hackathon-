// ─────────────────────────────────────────────────────────────────────────────
// ReportGenerator — client island for building admin report downloads.
// The experiments endpoint serves RFC-4180 CSV server-side
// (?format=csv); this island only composes the same-origin download URL
// from sort/order choices (no data fetching, no secrets). The anchor
// carries session cookies so requireAdmin() still gates the download.
// ─────────────────────────────────────────────────────────────────────────────
"use client";

import { useState } from "react";

const SORTS = ["name", "status", "sample_size"] as const;
const ORDERS = ["asc", "desc"] as const;

export default function ReportGenerator() {
  const [sort, setSort] =
    useState<(typeof SORTS)[number]>("name");
  const [order, setOrder] =
    useState<(typeof ORDERS)[number]>("asc");

  const csvUrl =
    `/api/admin/analytics/experiments?format=csv` +
    `&sort=${encodeURIComponent(sort)}&order=${encodeURIComponent(order)}`;

  return (
    <div className="glass rounded-2xl p-5 border border-white/5">
      <h2 className="text-sm font-bold text-slate-200 mb-1">
        Report generator
      </h2>
      <p className="text-xs text-slate-500 mb-3">
        Experiments table export (CSV, RFC 4180 quoting). Scoped to your
        tier by the API.
      </p>
      <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-end">
        <label className="text-xs text-slate-400 space-y-1">
          Sort by
          <select
            value={sort}
            onChange={(e) =>
              setSort(e.target.value as (typeof SORTS)[number])
            }
            className="block glass rounded-lg px-2 py-2 text-sm text-slate-200 outline-none border border-white/5 bg-transparent"
          >
            {SORTS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-400 space-y-1">
          Order
          <select
            value={order}
            onChange={(e) =>
              setOrder(e.target.value as (typeof ORDERS)[number])
            }
            className="block glass rounded-lg px-2 py-2 text-sm text-slate-200 outline-none border border-white/5 bg-transparent"
          >
            {ORDERS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <a
          href={csvUrl}
          download
          className="inline-flex items-center justify-center text-sm px-4 py-2 rounded-xl bg-brand-500/20 text-brand-300 border border-brand-500/30 hover:bg-brand-500/30 transition-colors"
        >
          Download CSV
        </a>
      </div>
    </div>
  );
}
