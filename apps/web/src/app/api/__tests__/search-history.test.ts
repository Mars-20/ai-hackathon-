import { describe, test, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Task 6 (TDD RED): search/history counts+order come from the DB ────────────
// Constraint: zod parse belongs to T1 — these tests only assert
// counts/order/pagination behaviour + workspace isolation, never schemas.
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(),
}));

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { GET as searchGET } from "@/app/api/search/route";
import { GET as historyGET } from "@/app/api/history/route";

const mockedClient = vi.mocked(createServerSupabaseClient);

type Row = Record<string, unknown>;
interface TableData { data: Row[]; count?: number }
interface Call { table: string; op: string; args: unknown[] }

// Chainable PostgREST mock: every filter returns the builder; `await` resolves
// the canned per-table payload. Calls are recorded for order/range/in asserts.
function mockSupabase(tables: Record<string, TableData>, calls: Call[]) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const op of ["select", "eq", "in", "or", "gte", "lte", "order", "range", "limit"]) {
    builder[op] = (...args: unknown[]) => {
      calls.push({ table: currentTable, op, args });
      return chain();
    };
  }
  let currentTable = "";
  builder.maybeSingle = async () => ({ data: tables[currentTable]?.data?.[0] ?? null, error: null });
  // Thenable so `await query` resolves like a PostgREST filter builder.
  builder.then = (resolve: (v: unknown) => void) =>
    resolve({ data: tables[currentTable]?.data ?? [], count: tables[currentTable]?.count, error: null });
  mockedClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (table: string) => {
      currentTable = table;
      return builder;
    },
  } as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("search: DB counts, chronological order, pagination (Task 6)", () => {
  test("RED: returns DB totals, not the sliced sum", async () => {
    const calls: Call[] = [];
    mockSupabase({
      workspace_members: { data: [{ workspace_id: "w1" }] },
      startups: { data: [{ id: "s1", name: "test one", created_at: "2026-01-02T00:00:00Z" }, { id: "s2", name: "test two", created_at: "2026-01-01T00:00:00Z" }], count: 10 },
      assumptions: { data: [{ id: "a1", statement: "test holds", created_at: "2026-01-03T00:00:00Z" }], count: 7 },
      evidence: { data: [], count: 3 },
    }, calls);
    const res = await searchGET(new NextRequest("http://x/api/search?q=test&type=all&limit=5"));
    const j = await res.json();
    expect(j.meta.total).toBe(20);
    expect(j.meta.total).toBeGreaterThanOrEqual(
      j.results.startups.length + j.results.assumptions.length + j.results.evidence.length,
    );
    expect(j.counts).toEqual({ startups: 10, assumptions: 7, evidence: 3 });
    expect(j.total_hits).toBe(20);
  });

  test("RED: paginates via rank-then-slice window (page 2 fetches from 0)", async () => {
    const calls: Call[] = [];
    mockSupabase({
      workspace_members: { data: [{ workspace_id: "w1" }] },
      startups: { data: [], count: 10 },
      assumptions: { data: [], count: 0 },
      evidence: { data: [], count: 0 },
    }, calls);
    await searchGET(new NextRequest("http://x/api/search?q=test&type=startups&limit=2&page=2"));
    const ranges = calls.filter((c) => c.op === "range");
    expect(ranges.length).toBeGreaterThan(0);
    // Rank-then-slice: fetch candidate window 0..offset+limit-1, rank globally,
    // then slice the page — never re-sort an already-paginated DB slice.
    expect(ranges[0].args).toEqual([0, 3]);
  });

  test("R1/5: pages is consistent with total, pages_per_type covers deepest feed", async () => {
    const calls: Call[] = [];
    mockSupabase({
      workspace_members: { data: [{ workspace_id: "w1" }] },
      startups: { data: [], count: 10 },
      assumptions: { data: [], count: 7 },
      evidence: { data: [], count: 3 },
    }, calls);
    const res = await searchGET(new NextRequest("http://x/api/search?q=test&type=all&limit=5"));
    const j = await res.json();
    // total = 10+7+3 = 20 → pages = ceil(20/5) = 4 (consistent with total);
    // pages_per_type = ceil(max(10,7,3)/5) = 2 (deepest single-type feed).
    expect(j.meta.total).toBe(20);
    expect(j.meta.pages).toBe(4);
    expect(j.meta.pages_per_type).toBe(2);
  });

  test("R1/5: rank-then-slice returns the globally-ranked page tail", async () => {
    const calls: Call[] = [];
    mockSupabase({
      workspace_members: { data: [{ workspace_id: "w1" }] },
      startups: {
        data: [
          { id: "oldest", name: "test", one_liner: "", domain: "", created_at: "2026-01-01T00:00:00Z" },
          { id: "newest", name: "test", one_liner: "", domain: "", created_at: "2026-04-01T00:00:00Z" },
          { id: "mid2", name: "test", one_liner: "", domain: "", created_at: "2026-03-01T00:00:00Z" },
          { id: "mid1", name: "test", one_liner: "", domain: "", created_at: "2026-02-01T00:00:00Z" },
        ],
        count: 4,
      },
      assumptions: { data: [], count: 0 },
      evidence: { data: [], count: 0 },
    }, calls);
    // All score equally (contain q) → global rank is newest-first;
    // page 2 (limit 2) must be the 3rd+4th newest, not a re-ranked DB slice.
    const res = await searchGET(new NextRequest("http://x/api/search?q=test&type=startups&limit=2&page=2"));
    const j = await res.json();
    expect(j.results.startups.map((s: Row) => s.id)).toEqual(["mid1", "oldest"]);
  });

  test("RED: orders chronologically in the DB query", async () => {
    const calls: Call[] = [];
    mockSupabase({
      workspace_members: { data: [{ workspace_id: "w1" }] },
      startups: { data: [], count: 0 },
      assumptions: { data: [], count: 0 },
      evidence: { data: [], count: 0 },
    }, calls);
    await searchGET(new NextRequest("http://x/api/search?q=test&type=all&limit=5"));
    const orders = calls.filter((c) => c.op === "order");
    expect(orders.length).toBeGreaterThan(0);
    expect(orders[0].args[0]).toMatch(/created_at|collected_at/);
    expect(orders[0].args[1]).toEqual({ ascending: false });
  });

  test("RED: equal-similarity ties break chronologically (newest first)", async () => {
    const calls: Call[] = [];
    mockSupabase({
      workspace_members: { data: [{ workspace_id: "w1" }] },
      startups: {
        data: [
          { id: "old", name: "test", one_liner: "", domain: "", created_at: "2026-01-01T00:00:00Z" },
          { id: "new", name: "test", one_liner: "", domain: "", created_at: "2026-06-01T00:00:00Z" },
        ],
        count: 2,
      },
      assumptions: { data: [], count: 0 },
      evidence: { data: [], count: 0 },
    }, calls);
    const res = await searchGET(new NextRequest("http://x/api/search?q=test&type=startups&limit=5"));
    const j = await res.json();
    expect(j.results.startups.map((s: Row) => s.id)).toEqual(["new", "old"]);
  });

  test("workspace isolation stays in the DB query", async () => {
    const calls: Call[] = [];
    mockSupabase({
      workspace_members: { data: [{ workspace_id: "w1" }] },
      startups: { data: [], count: 0 },
      assumptions: { data: [], count: 0 },
      evidence: { data: [], count: 0 },
    }, calls);
    await searchGET(new NextRequest("http://x/api/search?q=test&type=all&limit=5"));
    const scoped = calls.filter((c) => c.op === "in" && String(c.args[0]).includes("workspace"));
    expect(scoped.length).toBeGreaterThan(0);
    for (const c of scoped) expect(c.args[1]).toEqual(["w1"]);
  });
});

describe("history: DB count drives total/pages, deterministic order (Task 6)", () => {
  test("uses DB count (not page length) for total/pages", async () => {
    const calls: Call[] = [];
    mockSupabase({
      workspace_members: { data: [{ workspace_id: "w1" }] },
      startups: {
        data: [{ id: "s1", name: "A", decisions: [], experiments: [], assumptions: [] }],
        count: 45,
      },
    }, calls);
    const res = await historyGET(new NextRequest("http://x/api/history?page=1&limit=20"));
    const j = await res.json();
    expect(j.meta.total).toBe(45);
    expect(j.meta.pages).toBe(3);
  });

  test("RED: deterministic tie-break order after the primary sort", async () => {
    const calls: Call[] = [];
    mockSupabase({
      workspace_members: { data: [{ workspace_id: "w1" }] },
      startups: { data: [], count: 0 },
    }, calls);
    await historyGET(new NextRequest("http://x/api/history?sort=created_at&order=desc&page=1&limit=20"));
    const orders = calls.filter((c) => c.table === "startups" && c.op === "order");
    expect(orders.length).toBeGreaterThanOrEqual(2);
    expect(orders[0].args[0]).toBe("created_at");
  });

  test("R1/5: history order uses an explicit ascending boolean (asc/desc)", async () => {
    for (const [orderParam, expected] of [["asc", true], ["desc", false]] as const) {
      const calls: Call[] = [];
      mockSupabase({
        workspace_members: { data: [{ workspace_id: "w1" }] },
        startups: { data: [], count: 0 },
      }, calls);
      await historyGET(new NextRequest(`http://x/api/history?sort=created_at&order=${orderParam}&page=1&limit=20`));
      const orders = calls.filter((c) => c.table === "startups" && c.op === "order");
      expect(orders.length).toBeGreaterThanOrEqual(2);
      // Primary sort + id tie-break both carry the explicit boolean —
      // no string/bool confusion.
      for (const o of orders) expect(o.args[1]).toEqual({ ascending: expected });
    }
  });

  test("workspace isolation stays in the DB query", async () => {
    const calls: Call[] = [];
    mockSupabase({
      workspace_members: { data: [{ workspace_id: "w1" }] },
      startups: { data: [], count: 0 },
    }, calls);
    await historyGET(new NextRequest("http://x/api/history?page=1&limit=20"));
    const scoped = calls.filter((c) => c.table === "startups" && c.op === "in" && c.args[0] === "workspace_id");
    expect(scoped.length).toBe(1);
    expect(scoped[0].args[1]).toEqual(["w1"]);
  });
});
