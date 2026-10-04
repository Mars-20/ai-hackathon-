import { describe, expect, test, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin")>();
  return { ...actual, requireAdminFromSupabase: vi.fn() };
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const err = new Error("NEXT_REDIRECT") as Error & { digest: string };
    err.digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw err;
  },
}));

vi.mock("@/lib/admin-queries/overview", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/admin-queries/overview")>();
  return { ...actual, queryOverview: vi.fn(actual.queryOverview) };
});

import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";
import { requireAdminFromSupabase } from "@/lib/admin";
import type { RequireAdminResult } from "@/lib/admin";
import { queryOverview } from "@/lib/admin-queries/overview";
import type { AdminQueryDeps } from "@/lib/admin-queries/shared";
import { GET as overviewGET } from "@/app/api/admin/overview/route";
import { runAdminQuery } from "@/lib/admin-dal";

const mockedClient = vi.mocked(createServerSupabaseClient);
const mockedServiceClient = vi.mocked(createServiceRoleClient);
const mockedGate = vi.mocked(requireAdminFromSupabase);
const queryOverviewSpy = vi.mocked(queryOverview);

interface FakeOverviewState {
  profiles: Record<string, unknown>[];
  members: Record<string, unknown>[];
  startups: Record<string, unknown>[];
  traces: Record<string, unknown>[];
  decisions: Record<string, unknown>[];
}

const PLATFORM_ADMIN: RequireAdminResult = {
  user: { id: "admin-1" },
  tier: "platform",
  workspaceIds: [],
};

const WORKSPACE_ADMIN: RequireAdminResult = {
  user: { id: "admin-1" },
  tier: "workspace",
  workspaceIds: ["w1"],
};

// In-memory PostgREST fake: supports the exact chains the overview query
// uses (select/not/gte/order/limit/in + await with { data, error, count }).
function makeOverviewClient(state: FakeOverviewState) {
  const tables: Record<string, Record<string, unknown>[]> = {
    profiles: state.profiles,
    workspace_members: state.members,
    startups: state.startups,
    trace_events: state.traces,
    decisions: state.decisions,
  };
  const from = (table: string) => {
    const eqs: Array<{ col: string; val: unknown }> = [];
    const ins: Array<{ col: string; vals: unknown[] }> = [];
    const notNulls: string[] = [];
    const gtes: Array<{ col: string; val: string }> = [];
    let orderCol: string | null = null;
    let ascending = true;
    let limitN: number | null = null;
    let head = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.head === true) head = true;
        return q;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderCol = col;
        ascending = opts?.ascending ?? true;
        return q;
      },
      eq: (col: string, val: unknown) => {
        eqs.push({ col, val });
        return q;
      },
      in: (col: string, vals: unknown[]) => {
        ins.push({ col, vals });
        return q;
      },
      not: (col: string, op: string, val: unknown) => {
        if (op === "is" && val === null) notNulls.push(col);
        return q;
      },
      gte: (col: string, val: string) => {
        gtes.push({ col, val });
        return q;
      },
      limit: (n: number) => {
        limitN = n;
        return q;
      },
      // Thenable so `await q` resolves like a PostgREST filter builder.
      then: (resolve: (v: unknown) => void) => resolve(compute()),
    };
    function compute() {
      let rows = [...(tables[table] ?? [])];
      for (const { col, val } of eqs) {
        rows = rows.filter((r) => r[col] === val);
      }
      for (const { col, vals } of ins) {
        rows = rows.filter((r) => vals.includes(r[col]));
      }
      for (const col of notNulls) {
        rows = rows.filter((r) => r[col] !== null && r[col] !== undefined);
      }
      for (const { col, val } of gtes) {
        rows = rows.filter((r) => String(r[col] ?? "") >= val);
      }
      if (orderCol !== null) {
        const col = orderCol;
        rows = [...rows].sort((a, b) => {
          const av = String(a[col] ?? "");
          const bv = String(b[col] ?? "");
          if (av === bv) return 0;
          if (ascending) return av < bv ? -1 : 1;
          return av > bv ? -1 : 1;
        });
      }
      const total = rows.length;
      if (limitN !== null) rows = rows.slice(0, limitN);
      if (head) return { data: [], error: null, count: total };
      return { data: rows, error: null, count: total };
    }
    return q;
  };
  return { from };
}

function setup(state: FakeOverviewState) {
  mockedClient.mockResolvedValue(
    makeOverviewClient(state) as unknown as Awaited<
      ReturnType<typeof createServerSupabaseClient>
    >,
  );
  mockedServiceClient.mockReturnValue(
    makeOverviewClient(state) as unknown as ReturnType<
      typeof createServiceRoleClient
    >,
  );
}

function depsFor(state: FakeOverviewState, admin: unknown): AdminQueryDeps {
  const client = makeOverviewClient(state);
  return {
    admin: admin as AdminQueryDeps["admin"],
    userClient: client as unknown as AdminQueryDeps["userClient"],
    service: client as unknown as AdminQueryDeps["service"],
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const isoAgo = (days: number) =>
  new Date(Date.now() - days * DAY_MS).toISOString();

function seedState(): FakeOverviewState {
  return {
    profiles: [
      { user_id: "p1" },
      { user_id: "p2" },
      { user_id: "p3" },
      { user_id: "p4" },
      { user_id: "p5" },
    ],
    members: [
      { user_id: "u1", workspace_id: "w1" },
      { user_id: "u1", workspace_id: "w1" },
      { user_id: "u2", workspace_id: "w1" },
      { user_id: "u3", workspace_id: "w9" },
    ],
    startups: [
      { id: "s1", workspace_id: "w1" },
      { id: "s2", workspace_id: "w9" },
      { id: "s3", workspace_id: null },
    ],
    traces: [
      { workspace_id: "w1", cost_usd: 1, created_at: isoAgo(1) },
      { workspace_id: "w1", cost_usd: "2.5", created_at: isoAgo(2) },
      { workspace_id: "w1", cost_usd: 0.5, created_at: new Date().toISOString() },
      { workspace_id: "w9", cost_usd: 10, created_at: isoAgo(1) },
      { workspace_id: null, cost_usd: 100, created_at: isoAgo(1) },
      { workspace_id: "w1", cost_usd: 5, created_at: isoAgo(30) },
    ],
    decisions: [
      { workspace_id: "w1", verdict: "stop", created_at: isoAgo(1) },
      { workspace_id: "w1", verdict: "go", created_at: isoAgo(1) },
      { workspace_id: "w1", verdict: "stop", created_at: isoAgo(2) },
      { workspace_id: "w9", verdict: "go", created_at: isoAgo(1) },
      { workspace_id: null, verdict: "stop", created_at: isoAgo(1) },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("queryOverview helper", () => {
  test("platform KPIs exclude NULL-workspace rows and the 30d-old trace", async () => {
    const state = seedState();
    const res = await queryOverview(depsFor(state, PLATFORM_ADMIN), 7);
    expect(res.kpis.users).toBe(5);
    expect(res.kpis.startups).toBe(2);
    expect(res.kpis.activeWorkspaces).toBe(2);
    expect(res.kpis.runs7d).toBe(4);
    expect(res.kpis.rejectRate).toBe(0.5);
    // 1 + 2.5 + 0.5 + 10 — the NULL 100-cost row is excluded.
    expect(res.kpis.spend).toEqual({ value: 14, estimated: true });
    const totalRuns = res.trends.reduce((n, p) => n + p.runs, 0);
    expect(totalRuns).toBe(4);
    for (const p of res.trends) {
      expect(p.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test("workspace tier aggregates only its own workspaces", async () => {
    const state = seedState();
    const res = await queryOverview(depsFor(state, WORKSPACE_ADMIN), 7);
    // Distinct members of w1 only (u1 counted once despite the dup row).
    expect(res.kpis.users).toBe(2);
    expect(res.kpis.startups).toBe(1);
    expect(res.kpis.activeWorkspaces).toBe(1);
    expect(res.kpis.runs7d).toBe(3);
    expect(res.kpis.rejectRate).toBe(0.667);
    expect(res.kpis.spend).toEqual({ value: 4, estimated: true });
    expect(JSON.stringify(res)).not.toContain("w9");
  });

  test("days=999 clamps to 90; NaN falls back to 7", async () => {
    const state = seedState();
    const deps = depsFor(state, PLATFORM_ADMIN);
    const clamped = await queryOverview(deps, 999);
    const ninety = await queryOverview(deps, 90);
    expect(clamped.kpis).toEqual(ninety.kpis);
    expect(clamped.trends.length).toBe(ninety.trends.length);
    // 90d window pulls in the 30d-old trace: 5 runs, spend 19.
    expect(ninety.kpis.runs7d).toBe(5);
    expect(ninety.kpis.spend).toEqual({ value: 19, estimated: true });
    const fallback = await queryOverview(deps, Number.NaN);
    const seven = await queryOverview(deps, 7);
    expect(fallback.kpis).toEqual(seven.kpis);
  });

  test("zero decisions yield a null reject rate", async () => {
    const state = seedState();
    state.decisions = [];
    const res = await queryOverview(depsFor(state, PLATFORM_ADMIN), 7);
    expect(res.kpis.rejectRate).toBeNull();
  });
});

describe("overview route delegation", () => {
  test("route GET passes the parsed days and returns the helper DTO", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });
    const res = await overviewGET(
      new NextRequest("http://x/api/admin/overview?days=30"),
    );
    expect(res.status).toBe(200);
    expect(queryOverviewSpy).toHaveBeenCalledTimes(1);
    expect(queryOverviewSpy).toHaveBeenCalledWith(
      expect.objectContaining({ admin: PLATFORM_ADMIN }),
      30,
    );
    const body = await res.json();
    expect(body.kpis.users).toBe(5);

    const def = await overviewGET(new NextRequest("http://x/api/admin/overview"));
    expect(queryOverviewSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ admin: PLATFORM_ADMIN }),
      7,
    );
    expect(def.status).toBe(200);
  });
});

describe("overview DAL parity", () => {
  test("runAdminQuery returns the same DTO the route returns", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });
    const dalRes = await runAdminQuery((deps) => queryOverview(deps, 7));
    const routeRes = await overviewGET(
      new NextRequest("http://x/api/admin/overview"),
    );
    const routeBody = await routeRes.json();
    expect(dalRes).toEqual({ ok: true, data: routeBody });
  });
});
