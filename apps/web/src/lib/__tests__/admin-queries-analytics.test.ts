import { describe, expect, test, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase/server", () => {
  const userClient = vi.fn();
  const serviceClient = vi.fn();
  return {
    createServerSupabaseClient: userClient,
    createServiceRoleClient: serviceClient,
    // Request-memoized getters resolve the same fakes (prod: React cache()).
    getRequestUserClient: userClient,
    getRequestServiceClient: serviceClient,
  };
});

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

// Spy-wrap the REAL helpers (delegation assertions must exercise the real
// unit under test — the spies call through).
vi.mock("@/lib/admin-queries/analytics", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/admin-queries/analytics")>();
  return {
    ...actual,
    queryAnalytics: vi.fn(actual.queryAnalytics),
    queryExperiments: vi.fn(actual.queryExperiments),
    queryExperimentViews: vi.fn(actual.queryExperimentViews),
  };
});

import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";
import { requireAdminFromSupabase } from "@/lib/admin";
import type { RequireAdminResult } from "@/lib/admin";
import {
  queryAnalytics,
  queryExperiments,
  queryExperimentViews,
} from "@/lib/admin-queries/analytics";
import type { AdminQueryDeps } from "@/lib/admin-queries/shared";
import { GET as analyticsGET } from "@/app/api/admin/analytics/route";
import { GET as experimentsGET } from "@/app/api/admin/analytics/experiments/route";
import { runAdminQuery } from "@/lib/admin-dal";

const mockedClient = vi.mocked(createServerSupabaseClient);
const mockedServiceClient = vi.mocked(createServiceRoleClient);
const mockedGate = vi.mocked(requireAdminFromSupabase);
const analyticsSpy = vi.mocked(queryAnalytics);
const experimentsSpy = vi.mocked(queryExperiments);
const viewsSpy = vi.mocked(queryExperimentViews);

interface FakeAnalyticsState {
  traces: Record<string, unknown>[];
  decisions: Record<string, unknown>[];
  profiles: Record<string, unknown>[];
  members: Record<string, unknown>[];
  experiments: Record<string, unknown>[];
  startups: Record<string, unknown>[];
}

const PLATFORM_ADMIN: RequireAdminResult = {
  user: { id: "admin-1" },
  tier: "platform",
  workspaceIds: [],
};

const WS_OWNER: RequireAdminResult = {
  user: { id: "admin-1" },
  tier: "workspace",
  workspaceIds: ["w1"],
};

// In-memory PostgREST fake: select/eq/in/not/gte/lte/order/limit/range +
// head-count + await with { data, error, count }.
function makeAnalyticsClient(state: FakeAnalyticsState) {
  const tables: Record<string, Record<string, unknown>[]> = {
    trace_events: state.traces,
    decisions: state.decisions,
    profiles: state.profiles,
    workspace_members: state.members,
    experiments: state.experiments,
    startups: state.startups,
  };
  const from = (table: string) => {
    const eqs: Array<{ col: string; val: unknown }> = [];
    const ins: Array<{ col: string; vals: unknown[] }> = [];
    const notNulls: string[] = [];
    const gtes: Array<{ col: string; val: string }> = [];
    const ltes: Array<{ col: string; val: string }> = [];
    let orderCol: string | null = null;
    let ascending = true;
    let limitN: number | null = null;
    let range: [number, number] | null = null;
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
      lte: (col: string, val: string) => {
        ltes.push({ col, val });
        return q;
      },
      limit: (n: number) => {
        limitN = n;
        return q;
      },
      range: (a: number, b: number) => {
        range = [a, b];
        return q;
      },
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
      for (const { col, val } of ltes) {
        rows = rows.filter((r) => String(r[col] ?? "") <= val);
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
      if (range !== null) rows = rows.slice(range[0], range[1] + 1);
      else if (limitN !== null) rows = rows.slice(0, limitN);
      if (head) return { data: [], error: null, count: total };
      return { data: rows, error: null, count: total };
    }
    return q;
  };
  return { from };
}

function setup(state: FakeAnalyticsState) {
  mockedClient.mockResolvedValue(
    makeAnalyticsClient(state) as unknown as Awaited<
      ReturnType<typeof createServerSupabaseClient>
    >,
  );
  mockedServiceClient.mockReturnValue(
    makeAnalyticsClient(state) as unknown as ReturnType<
      typeof createServiceRoleClient
    >,
  );
}

function depsFor(
  state: FakeAnalyticsState,
  admin: unknown,
): AdminQueryDeps {
  const client = makeAnalyticsClient(state);
  return {
    admin: admin as AdminQueryDeps["admin"],
    userClient: client as unknown as AdminQueryDeps["userClient"],
    service: client as unknown as AdminQueryDeps["service"],
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const isoAgo = (days: number) =>
  new Date(Date.now() - days * DAY_MS).toISOString();

function seedState(): FakeAnalyticsState {
  return {
    traces: [
      {
        workspace_id: "w1",
        cost_usd: 1.5,
        created_at: isoAgo(1),
        event_type: "verification",
        payload: { unsupported_count: 2 },
      },
      {
        workspace_id: "w1",
        cost_usd: "2.5",
        created_at: isoAgo(2),
        event_type: "verification",
        payload: { unsupported_claims: ["c1"] },
      },
      {
        workspace_id: "w1",
        cost_usd: null,
        created_at: isoAgo(1),
        event_type: "run",
        payload: null,
      },
      {
        workspace_id: "w9",
        cost_usd: 10,
        created_at: isoAgo(1),
        event_type: "verification",
        payload: {},
      },
      {
        workspace_id: null,
        cost_usd: 99,
        created_at: isoAgo(1),
        event_type: "run",
        payload: null,
      },
      {
        workspace_id: "w1",
        cost_usd: 7,
        created_at: isoAgo(30),
        event_type: "run",
        payload: null,
      },
    ],
    decisions: [
      { verdict: "go", created_at: isoAgo(1), workspace_id: "w1" },
      { verdict: "iterate", created_at: isoAgo(2), workspace_id: "w1" },
      { verdict: "stop", created_at: isoAgo(1), workspace_id: "w1" },
      { verdict: "test_more", created_at: isoAgo(1), workspace_id: "w9" },
      { verdict: "go", created_at: isoAgo(1), workspace_id: null },
      { verdict: "go", created_at: isoAgo(30), workspace_id: "w1" },
    ],
    profiles: [
      { user_id: "u1", created_at: isoAgo(1) },
      { user_id: "u2", created_at: isoAgo(2) },
      { user_id: "u3", created_at: isoAgo(30) },
    ],
    members: [
      { user_id: "m1", workspace_id: "w1", joined_at: isoAgo(1) },
      { user_id: "m2", workspace_id: "w1", joined_at: isoAgo(30) },
      { user_id: "m3", workspace_id: "w9", joined_at: isoAgo(1) },
    ],
    experiments: [
      {
        id: "e1",
        startup_id: "s1",
        workspace_id: "w1",
        status: "running",
        type: "ab",
        design: { title: "Shadowed", target_sample_size: 100 },
        created_at: "2026-09-01T00:00:00.000Z",
      },
      {
        id: "e2",
        startup_id: "s2",
        workspace_id: "w1",
        status: "draft",
        type: "ab",
        design: { title: "Design Two", target_sample_size: 50.5 },
        created_at: "2026-09-02T00:00:00.000Z",
      },
      {
        id: "e3",
        startup_id: "s3",
        workspace_id: "w9",
        status: "completed",
        type: "ab",
        design: { title: "Ignored", target_sample_size: 10 },
        created_at: "2026-09-03T00:00:00.000Z",
      },
      {
        id: "e4",
        startup_id: "s9",
        workspace_id: "w1",
        status: "paused",
        type: "ab",
        design: {},
        created_at: "2026-09-04T00:00:00.000Z",
      },
      {
        id: "e5",
        startup_id: "s1",
        workspace_id: null,
        status: "running",
        type: "ab",
        design: { title: "Legacy", target_sample_size: 5 },
        created_at: "2026-09-05T00:00:00.000Z",
      },
    ],
    startups: [
      { id: "s1", name: "Startup One", workspace_id: "w1" },
      { id: "s3", name: "Acme", workspace_id: "w9" },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("queryAnalytics helper", () => {
  test("window=999d throws the 400 envelope payload", async () => {
    const state = seedState();
    await expect(
      queryAnalytics(depsFor(state, PLATFORM_ADMIN), {
        window: "999d",
        from: null,
        to: null,
      }),
    ).rejects.toMatchObject({ status: 400, code: "BAD_REQUEST" });
  });

  test("custom span over 90d throws the 400 envelope payload", async () => {
    const state = seedState();
    await expect(
      queryAnalytics(depsFor(state, PLATFORM_ADMIN), {
        window: "custom",
        from: new Date(Date.now() - 91 * DAY_MS).toISOString(),
        to: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ status: 400, code: "BAD_REQUEST" });
  });

  test("snapshot shape matches the route JSON; NULL rows and old rows excluded", async () => {
    const state = seedState();
    const res = await queryAnalytics(depsFor(state, PLATFORM_ADMIN), {
      window: "7d",
      from: null,
      to: null,
    });
    expect(res.window.preset).toBe("7d");
    expect(res.window.days).toBe(7);
    expect(res.distribution).toEqual({
      go: 1,
      iterate: 1,
      stop: 1,
      test_more: 1,
      total: 4,
    });
    // Spend = 1.5 + 2.5 + 0 + 10 over 4 in-window platform traces.
    expect(res.costPerRun).toEqual({ value: 3.5, estimated: true });
    expect(res.signups).toBe(2);
    // 3 verification traces, 2 carrying unsupported signals.
    expect(res.unsupportedClaimRate).toBe(0.667);
    expect(res.truncated).toBe(false);
    // 7d window buckets from-day..to-day inclusive.
    expect(res.trends).toHaveLength(8);
    expect(res.trends.reduce((sum, t) => sum + t.runs, 0)).toBe(4);
    expect(JSON.stringify(res)).not.toContain("99");
  });

  test("malformed trace timestamps are skipped instead of failing the page", async () => {
    const state = seedState();
    // In-window lexicographically (passes gte/lte string bounds) but not a
    // real timestamp: invalid hour/minute/second.
    const inWindow = new Date(Date.now() - DAY_MS).toISOString();
    state.traces.push({
      workspace_id: "w1",
      cost_usd: 3,
      created_at: `${inWindow.slice(0, 11)}25:99:99.000Z`,
      event_type: "run",
      payload: null,
    });
    const res = await queryAnalytics(depsFor(state, PLATFORM_ADMIN), {
      window: "7d",
      from: null,
      to: null,
    });
    expect(res.trends.reduce((sum, t) => sum + t.runs, 0)).toBe(4);
  });

  test("cost figures carry the estimated label", async () => {
    const state = seedState();
    const res = await queryAnalytics(depsFor(state, PLATFORM_ADMIN), {
      window: "7d",
      from: null,
      to: null,
    });
    expect(res.costPerRun).not.toBeNull();
    expect(res.costPerRun).toMatchObject({ estimated: true });
    expect(typeof res.costPerRun?.value).toBe("number");
  });

  test("workspace tier sees only its own scope", async () => {
    const state = seedState();
    const res = await queryAnalytics(depsFor(state, WS_OWNER), {
      window: "7d",
      from: null,
      to: null,
    });
    expect(res.distribution).toEqual({
      go: 1,
      iterate: 1,
      stop: 1,
      test_more: 0,
      total: 3,
    });
    // w1 traces only: 1.5 + 2.5 + 0 over 3 runs, rounded to cents.
    expect(res.costPerRun).toEqual({ value: 1.33, estimated: true });
    expect(res.signups).toBe(1);
    expect(res.unsupportedClaimRate).toBe(1);
    expect(res.trends.reduce((sum, t) => sum + t.runs, 0)).toBe(3);
    expect(JSON.stringify(res)).not.toContain("w9");
  });
});

describe("queryExperiments helper", () => {
  test("invalid sort/order throw the exact 400 payloads", async () => {
    const state = seedState();
    await expect(
      queryExperiments(depsFor(state, PLATFORM_ADMIN), {
        sort: "bogus",
        order: "asc",
        page: "1",
        limit: "20",
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "BAD_REQUEST",
      message: "Invalid sort (expected name, status, sample_size)",
    });
    await expect(
      queryExperiments(depsFor(state, PLATFORM_ADMIN), {
        sort: "name",
        order: "sideways",
        page: "1",
        limit: "20",
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "BAD_REQUEST",
      message: "Invalid order (expected asc or desc)",
    });
  });

  test("pagination preserved with sort/order echo and name fallbacks", async () => {
    const state = seedState();
    const page1 = await queryExperiments(depsFor(state, PLATFORM_ADMIN), {
      sort: "name",
      order: "asc",
      page: "1",
      limit: "2",
    });
    // Startup name wins; missing startup falls back to design.title, then
    // "Untitled"; the NULL-workspace legacy row is excluded.
    expect(page1.experiments.map((e) => e.name)).toEqual([
      "Acme",
      "Design Two",
    ]);
    expect(page1.total).toBe(4);
    expect(page1.pages).toBe(2);
    expect(page1.page).toBe(1);
    expect(page1.limit).toBe(2);
    expect(page1.sort).toBe("name");
    expect(page1.order).toBe("asc");
    expect(page1.truncated).toBe(false);

    const page2 = await queryExperiments(depsFor(state, PLATFORM_ADMIN), {
      sort: "name",
      order: "asc",
      page: "2",
      limit: "2",
    });
    expect(page2.experiments.map((e) => e.name)).toEqual([
      "Startup One",
      "Untitled",
    ]);

    const desc = await queryExperiments(depsFor(state, PLATFORM_ADMIN), {
      sort: "name",
      order: "desc",
      page: "1",
      limit: "20",
    });
    expect(desc.experiments.map((e) => e.name)).toEqual([
      "Untitled",
      "Startup One",
      "Design Two",
      "Acme",
    ]);

    // design.target_sample_size floors to the recruitment-target integer.
    const byId = new Map(desc.experiments.map((e) => [e.id, e]));
    expect(byId.get("e1")?.sample_size).toBe(100);
    expect(byId.get("e2")?.sample_size).toBe(50);
    expect(byId.get("e4")?.sample_size).toBe(0);
  });

  test("workspace tier sees only its own experiments", async () => {
    const state = seedState();
    const res = await queryExperiments(depsFor(state, WS_OWNER), {
      sort: "name",
      order: "asc",
      page: "1",
      limit: "20",
    });
    expect(res.experiments.map((e) => e.name)).toEqual([
      "Design Two",
      "Startup One",
      "Untitled",
    ]);
    expect(res.total).toBe(3);
  });
});

describe("analytics route delegation", () => {
  test("snapshot GET delegates with raw window params", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });

    const res = await analyticsGET(
      new NextRequest("http://x/api/admin/analytics?window=7d"),
    );
    expect(res.status).toBe(200);
    expect(analyticsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ admin: PLATFORM_ADMIN }),
      { window: "7d", from: null, to: null },
    );
    const body = await res.json();
    expect(body.distribution).toEqual({
      go: 1,
      iterate: 1,
      stop: 1,
      test_more: 1,
      total: 4,
    });
    expect(body.costPerRun).toEqual({ value: 3.5, estimated: true });
  });

  test("snapshot GET maps window=999d to the 400 envelope", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });

    const res = await analyticsGET(
      new NextRequest("http://x/api/admin/analytics?window=999d"),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid window (expected 7d, 30d, 90d, or custom)",
      code: "BAD_REQUEST",
    });
  });

  test("experiments JSON GET delegates with raw params; pagination preserved", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });

    const res = await experimentsGET(
      new NextRequest(
        "http://x/api/admin/analytics/experiments?sort=name&order=asc&page=1&limit=2",
      ),
    );
    expect(res.status).toBe(200);
    expect(experimentsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ admin: PLATFORM_ADMIN }),
      { sort: "name", order: "asc", page: "1", limit: "2" },
    );
    const body = await res.json();
    expect(body.experiments.map((e: { name: string }) => e.name)).toEqual([
      "Acme",
      "Design Two",
    ]);
    expect(body.total).toBe(4);
    expect(body.pages).toBe(2);
  });

  test("experiments CSV branch calls the helper for rows, bytes unchanged", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });

    const res = await experimentsGET(
      new NextRequest(
        "http://x/api/admin/analytics/experiments?format=csv&sort=name&order=asc",
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(viewsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ admin: PLATFORM_ADMIN }),
      { sort: "name", order: "asc" },
    );
    const text = await res.text();
    expect(text).toBe(
      [
        "id,name,startup_id,status,type,sample_size,created_at",
        "e3,Acme,s3,completed,ab,10,2026-09-03T00:00:00.000Z",
        "e2,Design Two,s2,draft,ab,50,2026-09-02T00:00:00.000Z",
        "e1,Startup One,s1,running,ab,100,2026-09-01T00:00:00.000Z",
        "e4,Untitled,s9,paused,ab,0,2026-09-04T00:00:00.000Z",
        "",
      ].join("\n"),
    );
  });

  test("experiments GET maps invalid sort to the exact 400 envelope", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });

    const res = await experimentsGET(
      new NextRequest(
        "http://x/api/admin/analytics/experiments?sort=bogus",
      ),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid sort (expected name, status, sample_size)",
      code: "BAD_REQUEST",
    });
  });

  test("experiments GET rejects invalid format before any helper reads", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });

    const res = await experimentsGET(
      new NextRequest(
        "http://x/api/admin/analytics/experiments?format=bogus",
      ),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid format (expected json or csv)",
      code: "BAD_REQUEST",
    });
    // No wasted reads: neither the JSON nor the CSV helper may run once
    // the format is known-bad.
    expect(experimentsSpy).not.toHaveBeenCalled();
    expect(viewsSpy).not.toHaveBeenCalled();
  });

  test("experiments GET keeps sort→order→format precedence (no wasted reads)", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });

    const sortFirst = await experimentsGET(
      new NextRequest(
        "http://x/api/admin/analytics/experiments?sort=bogus&format=bogus",
      ),
    );
    expect(sortFirst.status).toBe(400);
    expect(await sortFirst.json()).toEqual({
      error: "Invalid sort (expected name, status, sample_size)",
      code: "BAD_REQUEST",
    });

    const orderFirst = await experimentsGET(
      new NextRequest(
        "http://x/api/admin/analytics/experiments?order=sideways&format=bogus",
      ),
    );
    expect(orderFirst.status).toBe(400);
    expect(await orderFirst.json()).toEqual({
      error: "Invalid order (expected asc or desc)",
      code: "BAD_REQUEST",
    });
    expect(experimentsSpy).not.toHaveBeenCalled();
    expect(viewsSpy).not.toHaveBeenCalled();
  });

  test("experiments CSV ignores bogus page/limit but still validates the path", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });

    const res = await experimentsGET(
      new NextRequest(
        "http://x/api/admin/analytics/experiments?format=csv&sort=name&order=asc&page=bogus&limit=bogus",
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    expect(text).toBe(
      [
        "id,name,startup_id,status,type,sample_size,created_at",
        "e3,Acme,s3,completed,ab,10,2026-09-03T00:00:00.000Z",
        "e2,Design Two,s2,draft,ab,50,2026-09-02T00:00:00.000Z",
        "e1,Startup One,s1,running,ab,100,2026-09-01T00:00:00.000Z",
        "e4,Untitled,s9,paused,ab,0,2026-09-04T00:00:00.000Z",
        "",
      ].join("\n"),
    );
  });
});

describe("analytics DAL parity", () => {
  test("runAdminQuery returns the same snapshot DTO the route returns", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });
    const dalRes = await runAdminQuery((deps) =>
      queryAnalytics(deps, { window: "7d", from: null, to: null }),
    );
    const routeRes = await analyticsGET(
      new NextRequest("http://x/api/admin/analytics?window=7d"),
    );
    const routeBody = await routeRes.json();
    expect(dalRes.ok).toBe(true);
    if (dalRes.ok) {
      // Volatile fields (clock reads per call) are stripped on both sides:
      // parity means identical structure + identical data, not identical
      // timestamps.
      const dalWindow: Record<string, unknown> = { ...dalRes.data.window };
      delete dalWindow["from"];
      delete dalWindow["to"];
      const routeWindow: Record<string, unknown> = { ...routeBody.window };
      delete routeWindow["from"];
      delete routeWindow["to"];
      expect({ ...dalRes.data, window: dalWindow }).toEqual({
        ...routeBody,
        window: routeWindow,
      });
      expect(dalRes.data.window.preset).toBe(routeBody.window.preset);
    }
  });

  test("runAdminQuery returns the same experiments DTO the route returns", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });
    const dalRes = await runAdminQuery((deps) =>
      queryExperiments(deps, {
        sort: "name",
        order: "asc",
        page: "1",
        limit: "20",
      }),
    );
    const routeRes = await experimentsGET(
      new NextRequest(
        "http://x/api/admin/analytics/experiments?sort=name&order=asc&page=1&limit=20",
      ),
    );
    const routeBody = await routeRes.json();
    expect(dalRes.ok).toBe(true);
    if (dalRes.ok) {
      expect(dalRes.data).toEqual(routeBody);
    }
  });
});
