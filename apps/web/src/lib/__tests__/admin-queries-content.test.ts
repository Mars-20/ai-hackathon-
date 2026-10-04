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

vi.mock("@/lib/admin-queries/content", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/admin-queries/content")>();
  return {
    ...actual,
    queryContentStartups: vi.fn(actual.queryContentStartups),
    queryContentDetails: vi.fn(actual.queryContentDetails),
  };
});

import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";
import { requireAdminFromSupabase } from "@/lib/admin";
import type { RequireAdminResult } from "@/lib/admin";
import {
  queryContentStartups,
  queryContentDetails,
  type ContentStartupsInput,
} from "@/lib/admin-queries/content";
import type { AdminQueryDeps } from "@/lib/admin-queries/shared";
import { GET as startupsGET } from "@/app/api/admin/content/startups/route";
import { GET as detailsGET } from "@/app/api/admin/content/details/route";
import { runAdminQuery } from "@/lib/admin-dal";

const mockedClient = vi.mocked(createServerSupabaseClient);
const mockedServiceClient = vi.mocked(createServiceRoleClient);
const mockedGate = vi.mocked(requireAdminFromSupabase);
const startupsSpy = vi.mocked(queryContentStartups);
const detailsSpy = vi.mocked(queryContentDetails);

interface FakeContentState {
  startups: Record<string, unknown>[];
  evidence: Record<string, unknown>[];
  assumptions: Record<string, unknown>[];
  decisions: Record<string, unknown>[];
  traces: Record<string, unknown>[];
  leads: Record<string, unknown>[];
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

const NO_SCOPE_ADMIN: RequireAdminResult = {
  user: { id: "admin-1" },
  tier: "workspace",
  workspaceIds: [],
};

function matchEq(rowVal: unknown, val: unknown): boolean {
  if (typeof rowVal === "boolean" && typeof val === "string") {
    if (val === "true") return rowVal === true;
    if (val === "false") return rowVal === false;
    return false;
  }
  return rowVal === val;
}

function ilikeMatch(value: unknown, pattern: string): boolean {
  const needle = pattern.replace(/^%/, "").replace(/%$/, "").replace(/\\/g, "");
  return String(value ?? "")
    .toLowerCase()
    .includes(needle.toLowerCase());
}

// In-memory PostgREST fake: supports the exact chains the content queries
// use (select/eq/in/not/ilike/or/order/limit/range/maybeSingle + await
// with { data, error, count }). `count` is the pre-range filtered total,
// like PostgREST count:"exact". `.or()` implements the startup-column ilike
// + id-set union the route builds (no commas inside test needles).
function makeContentClient(state: FakeContentState) {
  const tables: Record<string, Record<string, unknown>[]> = {
    startups: state.startups,
    evidence: state.evidence,
    assumptions: state.assumptions,
    decisions: state.decisions,
    trace_events: state.traces,
    leads: state.leads,
  };
  const from = (table: string) => {
    const eqs: Array<{ col: string; val: unknown }> = [];
    const ins: Array<{ col: string; vals: unknown[] }> = [];
    const notNulls: string[] = [];
    const ilikes: Array<{ col: string; pattern: string }> = [];
    let orFilter: string | null = null;
    const orders: Array<{ col: string; ascending: boolean }> = [];
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
        orders.push({ col, ascending: opts?.ascending ?? true });
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
      ilike: (col: string, pattern: string) => {
        ilikes.push({ col, pattern });
        return q;
      },
      or: (filters: string) => {
        orFilter = filters;
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
      maybeSingle: async () => {
        const rows = compute();
        return { data: rows.length > 0 ? rows[0] : null, error: null };
      },
      then: (resolve: (v: unknown) => void) => resolve(computeFull()),
    };
    function orMatches(row: Record<string, unknown>): boolean {
      if (orFilter === null) return true;
      const filter = orFilter as string;
      // The id-set part carries its own commas — extract it before
      // splitting the ilike fragments.
      const inPart = filter.match(/(\w+)\.in\.\(([^)]*)\)/);
      if (inPart !== null) {
        const ids = (inPart[2] ?? "").split(",").filter((s) => s.length > 0);
        if (ids.includes(String(row[inPart[1] as string] ?? ""))) return true;
      }
      const rest = filter.replace(/(\w+)\.in\.\(([^)]*)\)/g, "");
      for (const part of rest.split(",")) {
        if (part.length === 0) continue;
        const ilikePart = part.match(/^(\w+)\.ilike\.%([\s\S]*)%$/);
        if (ilikePart === null) continue;
        const needle = (ilikePart[2] ?? "").replace(/\\/g, "");
        if (
          String(row[ilikePart[1] as string] ?? "")
            .toLowerCase()
            .includes(needle.toLowerCase())
        ) {
          return true;
        }
      }
      return false;
    }
    function compute(): Record<string, unknown>[] {
      let rows = [...(tables[table] ?? [])];
      for (const { col, val } of eqs) {
        rows = rows.filter((r) => matchEq(r[col], val));
      }
      for (const { col, vals } of ins) {
        rows = rows.filter((r) => vals.includes(r[col]));
      }
      for (const col of notNulls) {
        rows = rows.filter((r) => r[col] !== null && r[col] !== undefined);
      }
      for (const { col, pattern } of ilikes) {
        rows = rows.filter((r) => ilikeMatch(r[col], pattern));
      }
      rows = rows.filter(orMatches);
      if (orders.length > 0) {
        rows = [...rows].sort((a, b) => {
          for (const { col, ascending } of orders) {
            const av = String(a[col] ?? "");
            const bv = String(b[col] ?? "");
            if (av === bv) continue;
            if (ascending) return av < bv ? -1 : 1;
            return av > bv ? -1 : 1;
          }
          return 0;
        });
      }
      return rows;
    }
    function computeFull() {
      const total = compute().length;
      let rows = compute();
      if (range !== null) rows = rows.slice(range[0], range[1] + 1);
      else if (limitN !== null) rows = rows.slice(0, limitN);
      if (head) return { data: [], error: null, count: total };
      return { data: rows, error: null, count: total };
    }
    return q;
  };
  return { from };
}

function setup(state: FakeContentState) {
  mockedClient.mockResolvedValue(
    makeContentClient(state) as unknown as Awaited<
      ReturnType<typeof createServerSupabaseClient>
    >,
  );
  mockedServiceClient.mockReturnValue(
    makeContentClient(state) as unknown as ReturnType<
      typeof createServiceRoleClient
    >,
  );
}

function depsFor(state: FakeContentState, admin: unknown): AdminQueryDeps {
  const client = makeContentClient(state);
  return {
    admin: admin as AdminQueryDeps["admin"],
    userClient: client as unknown as AdminQueryDeps["userClient"],
    service: client as unknown as AdminQueryDeps["service"],
  };
}

const BASE_INPUT: ContentStartupsInput = {
  page: 1,
  limit: 20,
  sort: "created_at",
  order: "desc",
  q: null,
  flagged: null,
  verdict: null,
  confidence: null,
};

function seedState(): FakeContentState {
  return {
    startups: [
      {
        id: "s1",
        workspace_id: "w1",
        name: "Alpha",
        one_liner: "Alpha one liner",
        domain: "alpha.com",
        stage: "mvp",
        flagged: true,
        created_at: "2024-01-03T00:00:00.000Z",
      },
      {
        id: "s2",
        workspace_id: "w1",
        name: "Beta",
        one_liner: "Beta one liner",
        domain: "beta.com",
        stage: "idea",
        flagged: false,
        created_at: "2024-01-02T00:00:00.000Z",
      },
      {
        id: "s3",
        workspace_id: "w9",
        name: "Gamma",
        one_liner: "Gamma one liner",
        domain: "gamma.com",
        stage: "mvp",
        flagged: true,
        created_at: "2024-01-01T00:00:00.000Z",
      },
      {
        id: "s0",
        workspace_id: null,
        name: "Legacy",
        one_liner: "Legacy one liner",
        domain: "legacy.com",
        stage: "mvp",
        flagged: false,
        created_at: "2023-01-01T00:00:00.000Z",
      },
    ],
    evidence: [
      {
        startup_id: "s1",
        workspace_id: "w1",
        claim: "Alpha claim about pricing",
        collected_at: "2024-01-04T00:00:00.000Z",
      },
      {
        startup_id: "s2",
        workspace_id: "w1",
        claim: "Beta claim",
        collected_at: "2024-01-04T00:00:00.000Z",
      },
      {
        startup_id: "s3",
        workspace_id: "w9",
        claim: "Gamma secret claim",
        collected_at: "2024-01-04T00:00:00.000Z",
      },
    ],
    assumptions: [
      {
        startup_id: "s1",
        workspace_id: "w1",
        created_at: "2024-01-04T00:00:00.000Z",
      },
    ],
    decisions: [
      {
        startup_id: "s1",
        workspace_id: "w1",
        verdict: "go",
        confidence: "high",
        created_at: "2024-02-01T00:00:00.000Z",
      },
      {
        startup_id: "s2",
        workspace_id: "w1",
        verdict: "stop",
        confidence: "low",
        created_at: "2024-02-02T00:00:00.000Z",
      },
      {
        startup_id: "s3",
        workspace_id: "w9",
        verdict: "go",
        confidence: "high",
        created_at: "2024-02-03T00:00:00.000Z",
      },
    ],
    traces: [
      {
        startup_id: "s1",
        workspace_id: "w1",
        created_at: "2024-01-05T00:00:00.000Z",
      },
    ],
    leads: [
      { startup_id: "s1", email: "founder@alpha.com" },
      { startup_id: "s3", email: "boss@gamma.com" },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("queryContentStartups helper", () => {
  test("invalid verdict returns 400 (not 500)", async () => {
    const state = seedState();
    await expect(
      queryContentStartups(depsFor(state, PLATFORM_ADMIN), {
        ...BASE_INPUT,
        verdict: "bogus",
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "BAD_REQUEST",
      message: "Invalid verdict filter",
    });
  });

  test("invalid confidence and flagged filters return 400", async () => {
    const state = seedState();
    await expect(
      queryContentStartups(depsFor(state, PLATFORM_ADMIN), {
        ...BASE_INPUT,
        confidence: "ultra",
      }),
    ).rejects.toMatchObject({ status: 400, code: "BAD_REQUEST" });
    await expect(
      queryContentStartups(depsFor(state, PLATFORM_ADMIN), {
        ...BASE_INPUT,
        flagged: "yes",
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "BAD_REQUEST",
      message: "Invalid flagged filter",
    });
  });

  test("empty-result shape is preserved", async () => {
    const state = seedState();
    const res = await queryContentStartups(depsFor(state, NO_SCOPE_ADMIN), {
      ...BASE_INPUT,
    });
    expect(res).toEqual({
      startups: [],
      total: 0,
      pages: 0,
      page: 1,
      limit: 20,
    });
  });

  test("platform list excludes NULL-workspace rows, flagged-first ordering", async () => {
    const state = seedState();
    const res = await queryContentStartups(depsFor(state, PLATFORM_ADMIN), {
      ...BASE_INPUT,
    });
    expect(res.startups.map((s) => s.id)).toEqual(["s1", "s3", "s2"]);
    expect(res.total).toBe(3);
    expect(res.pages).toBe(1);
    expect(JSON.stringify(res)).not.toContain("Legacy");
    const s1 = res.startups[0];
    expect(s1?.latestDecision).toEqual({
      verdict: "go",
      confidence: "high",
      created_at: "2024-02-01T00:00:00.000Z",
    });
    expect(s1?.evidenceCount).toBe(1);
  });

  test("workspace tier sees only in-scope rows (no leak)", async () => {
    const state = seedState();
    const res = await queryContentStartups(depsFor(state, WORKSPACE_ADMIN), {
      ...BASE_INPUT,
    });
    expect(res.startups.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(res.total).toBe(2);
    expect(JSON.stringify(res)).not.toContain("Gamma");
    expect(JSON.stringify(res)).not.toContain("Legacy");
  });

  test("verdict filter matches ANY decision; q AND verdict intersect", async () => {
    const state = seedState();
    const verdictOnly = await queryContentStartups(
      depsFor(state, PLATFORM_ADMIN),
      { ...BASE_INPUT, verdict: "go" },
    );
    expect(verdictOnly.startups.map((s) => s.id).sort()).toEqual(["s1", "s3"]);

    const both = await queryContentStartups(depsFor(state, PLATFORM_ADMIN), {
      ...BASE_INPUT,
      verdict: "go",
      q: "alpha",
    });
    expect(both.startups.map((s) => s.id)).toEqual(["s1"]);

    const textOnly = await queryContentStartups(depsFor(state, PLATFORM_ADMIN), {
      ...BASE_INPUT,
      q: "alpha",
    });
    expect(textOnly.startups.map((s) => s.id)).toEqual(["s1"]);
  });
});

describe("queryContentDetails helper", () => {
  test("missing id throws 400", async () => {
    const state = seedState();
    await expect(
      queryContentDetails(depsFor(state, PLATFORM_ADMIN), null),
    ).rejects.toMatchObject({
      status: 400,
      code: "BAD_REQUEST",
      message: "startup_id is required",
    });
    await expect(
      queryContentDetails(depsFor(state, PLATFORM_ADMIN), ""),
    ).rejects.toMatchObject({ status: 400, code: "BAD_REQUEST" });
  });

  test("out-of-scope startup returns 404 with no rows leaked", async () => {
    const state = seedState();
    const err = await queryContentDetails(
      depsFor(state, WORKSPACE_ADMIN),
      "s3",
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      message: "Startup not found",
    });
    expect(JSON.stringify(err)).not.toContain("Gamma");
    expect(JSON.stringify(err)).not.toContain("secret claim");
  });

  test("platform detail returns the full graph", async () => {
    const state = seedState();
    const res = await queryContentDetails(depsFor(state, PLATFORM_ADMIN), "s1");
    expect((res.startup as Record<string, unknown>)["id"]).toBe("s1");
    expect(res.assumptions).toHaveLength(1);
    expect(res.evidence).toHaveLength(1);
    expect(res.decisions).toHaveLength(1);
    expect(res.traces).toHaveLength(1);
  });

  test("workspace detail returns in-scope startup", async () => {
    const state = seedState();
    const res = await queryContentDetails(depsFor(state, WORKSPACE_ADMIN), "s1");
    expect((res.startup as Record<string, unknown>)["id"]).toBe("s1");
    expect(res.decisions).toHaveLength(1);
  });
});

describe("content route delegation", () => {
  test("startups GET delegates with raw params; mutations untouched", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });
    const res = await startupsGET(
      new NextRequest(
        "http://x/api/admin/content/startups?page=1&limit=20&sort=created_at&order=desc",
      ),
    );
    expect(res.status).toBe(200);
    expect(startupsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ admin: PLATFORM_ADMIN }),
      {
        page: "1",
        limit: "20",
        sort: "created_at",
        order: "desc",
        q: null,
        flagged: null,
        verdict: null,
        confidence: null,
      },
    );
    const body = await res.json();
    expect(body.total).toBe(3);
    expect(body.startups.map((s: { id: string }) => s.id)).toEqual([
      "s1",
      "s3",
      "s2",
    ]);
  });

  test("startups GET maps an invalid verdict to the exact 400 envelope", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });
    const res = await startupsGET(
      new NextRequest("http://x/api/admin/content/startups?verdict=bogus"),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid verdict filter",
      code: "BAD_REQUEST",
    });
  });

  test("details GET delegates; missing id is 400, out-of-scope is 404", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });
    const ok = await detailsGET(
      new NextRequest("http://x/api/admin/content/details?startup_id=s1"),
    );
    expect(ok.status).toBe(200);
    expect(detailsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ admin: PLATFORM_ADMIN }),
      "s1",
    );
    expect((await ok.json()).startup.id).toBe("s1");

    const missing = await detailsGET(
      new NextRequest("http://x/api/admin/content/details"),
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: "startup_id is required",
      code: "BAD_REQUEST",
    });

    mockedGate.mockResolvedValue({ ...WORKSPACE_ADMIN });
    const oos = await detailsGET(
      new NextRequest("http://x/api/admin/content/details?startup_id=s3"),
    );
    expect(oos.status).toBe(404);
    expect(await oos.json()).toEqual({
      error: "Startup not found",
      code: "NOT_FOUND",
    });
  });
});

describe("content DAL parity", () => {
  test("runAdminQuery returns the same startups DTO the route returns", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });
    const dalRes = await runAdminQuery((deps) =>
      queryContentStartups(deps, { ...BASE_INPUT }),
    );
    const routeRes = await startupsGET(
      new NextRequest(
        "http://x/api/admin/content/startups?page=1&limit=20&sort=created_at&order=desc",
      ),
    );
    const routeBody = await routeRes.json();
    expect(dalRes).toEqual({ ok: true, data: routeBody });
  });

  test("runAdminQuery returns the same details DTO the route returns", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });
    const dalRes = await runAdminQuery((deps) =>
      queryContentDetails(deps, "s1"),
    );
    const routeRes = await detailsGET(
      new NextRequest("http://x/api/admin/content/details?startup_id=s1"),
    );
    const routeBody = await routeRes.json();
    expect(dalRes).toEqual({ ok: true, data: routeBody });
  });
});
