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

vi.mock("@/lib/admin-queries/workspaces", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/admin-queries/workspaces")>();
  return {
    ...actual,
    queryWorkspacesList: vi.fn(actual.queryWorkspacesList),
    queryWorkspaceDetail: vi.fn(actual.queryWorkspaceDetail),
  };
});

import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";
import { requireAdminFromSupabase } from "@/lib/admin";
import type { RequireAdminResult } from "@/lib/admin";
import {
  queryWorkspacesList,
  queryWorkspaceDetail,
  type WorkspacesListInput,
} from "@/lib/admin-queries/workspaces";
import type { AdminQueryDeps } from "@/lib/admin-queries/shared";
import { GET as workspacesGET } from "@/app/api/admin/workspaces/route";
import {
  GET as workspaceDetailGET,
  PATCH as workspaceDetailPATCH,
} from "@/app/api/admin/workspaces/[id]/route";
import { runAdminQuery } from "@/lib/admin-dal";

const mockedClient = vi.mocked(createServerSupabaseClient);
const mockedServiceClient = vi.mocked(createServiceRoleClient);
const mockedGate = vi.mocked(requireAdminFromSupabase);
const queryListSpy = vi.mocked(queryWorkspacesList);
const queryDetailSpy = vi.mocked(queryWorkspaceDetail);

interface FakeWsState {
  workspaces: Record<string, unknown>[];
  members: Record<string, unknown>[];
  profiles: Record<string, unknown>[];
  startups: Record<string, unknown>[];
  evidence: Record<string, unknown>[];
  traces: Record<string, unknown>[];
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

const STALE_ADMIN: RequireAdminResult = {
  user: { id: "admin-1" },
  tier: "workspace",
  workspaceIds: ["w-stale"],
};

function matchOr(row: Record<string, unknown>, expr: string): boolean {
  return expr.split(",").some((seg) => {
    const m = seg.match(/^(name|slug)\.ilike\.(.*)$/);
    if (!m) return false;
    const raw = m[2]
      .replace(/^%/, "")
      .replace(/%$/, "")
      .replace(/\\/g, "");
    return String(row[m[1]] ?? "")
      .toLowerCase()
      .includes(raw.toLowerCase());
  });
}

// In-memory PostgREST fake: supports the exact chains the workspaces
// queries use (select/order/eq/in/or/range/limit/maybeSingle/head-count +
// await with { data, error, count }). `count` is the pre-range filtered
// total, like PostgREST count:"exact".
function makeWorkspacesClient(state: FakeWsState) {
  const tables: Record<string, Record<string, unknown>[]> = {
    workspaces: state.workspaces,
    workspace_members: state.members,
    profiles: state.profiles,
    startups: state.startups,
    evidence: state.evidence,
    trace_events: state.traces,
  };
  const from = (table: string) => {
    const eqs: Array<{ col: string; val: unknown }> = [];
    const ins: Array<{ col: string; vals: unknown[] }> = [];
    let orExpr: string | null = null;
    let orderCol: string | null = null;
    let ascending = true;
    let range: [number, number] | null = null;
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
      or: (expr: string) => {
        orExpr = expr;
        return q;
      },
      range: (a: number, b: number) => {
        range = [a, b];
        return q;
      },
      limit: (n: number) => {
        limitN = n;
        return q;
      },
      maybeSingle: () =>
        Promise.resolve({ data: filtered()[0] ?? null, error: null }),
      // Thenable so `await q` resolves like a PostgREST filter builder.
      then: (resolve: (v: unknown) => void) => resolve(compute()),
    };
    function filtered(): Record<string, unknown>[] {
      let rows = [...(tables[table] ?? [])];
      for (const { col, val } of eqs) {
        rows = rows.filter((r) => r[col] === val);
      }
      for (const { col, vals } of ins) {
        rows = rows.filter((r) => vals.includes(r[col]));
      }
      if (orExpr !== null) {
        const expr = orExpr;
        rows = rows.filter((r) => matchOr(r, expr));
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
      return rows;
    }
    function compute() {
      const total = filtered().length;
      let rows = filtered();
      if (range !== null) rows = rows.slice(range[0], range[1] + 1);
      else if (limitN !== null) rows = rows.slice(0, limitN);
      if (head) return { data: [], error: null, count: total };
      return { data: rows, error: null, count: total };
    }
    return q;
  };
  return { from };
}

function setup(state: FakeWsState) {
  mockedClient.mockResolvedValue(
    makeWorkspacesClient(state) as unknown as Awaited<
      ReturnType<typeof createServerSupabaseClient>
    >,
  );
  mockedServiceClient.mockReturnValue(
    makeWorkspacesClient(state) as unknown as ReturnType<
      typeof createServiceRoleClient
    >,
  );
}

function depsFor(state: FakeWsState, admin: unknown): AdminQueryDeps {
  const client = makeWorkspacesClient(state);
  return {
    admin: admin as AdminQueryDeps["admin"],
    userClient: client as unknown as AdminQueryDeps["userClient"],
    service: client as unknown as AdminQueryDeps["service"],
  };
}

const BASE_INPUT: WorkspacesListInput = {
  page: 1,
  limit: 20,
  sort: "created_at",
  order: "desc",
  q: null,
  plan: null,
  status: null,
};

function seedState(): FakeWsState {
  return {
    workspaces: [
      {
        id: "w1",
        name: "Alpha",
        slug: "alpha",
        plan: "pro",
        status: "active",
        created_at: "2024-01-01T00:00:00.000Z",
      },
      {
        id: "w2",
        name: "Beta",
        slug: "beta",
        plan: "free",
        status: "suspended",
        created_at: "2025-06-01T00:00:00.000Z",
      },
      {
        id: "w9",
        name: "Outsider",
        slug: "outsider",
        plan: "team",
        status: "active",
        created_at: "2024-06-01T00:00:00.000Z",
      },
    ],
    members: [
      {
        user_id: "u1",
        workspace_id: "w1",
        role: "admin",
        joined_at: "2024-01-02T00:00:00.000Z",
      },
      { user_id: "u2", workspace_id: "w1", role: "member" },
      { user_id: "u3", workspace_id: "w1", role: "member" },
    ],
    profiles: [
      { user_id: "u1", email: "a@example.com" },
      { user_id: "u2", email: "b@example.com" },
    ],
    startups: [
      { workspace_id: "w1" },
      { workspace_id: "w1" },
      { workspace_id: "w9" },
    ],
    evidence: [{ workspace_id: "w1" }],
    traces: [
      { workspace_id: "w1", cost_usd: 0.1 },
      { workspace_id: "w1", cost_usd: 0.2 },
      { workspace_id: "w1", cost_usd: "4.5" },
      { workspace_id: "w9", cost_usd: 7 },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("queryWorkspacesList helper", () => {
  test("platform tier aggregates usage with rounded estimated spend", async () => {
    const state = seedState();
    const res = await queryWorkspacesList(depsFor(state, PLATFORM_ADMIN), {
      ...BASE_INPUT,
    });
    expect(res.total).toBe(3);
    expect(res.pages).toBe(1);
    expect(res.page).toBe(1);
    expect(res.limit).toBe(20);
    // created_at desc default: Beta (2025), Outsider (2024-06), Alpha (2024-01).
    expect(res.workspaces.map((w) => w.id)).toEqual(["w2", "w9", "w1"]);
    const alpha = res.workspaces[2];
    expect(alpha.memberCount).toBe(3);
    expect(alpha.startupCount).toBe(2);
    expect(alpha.evidenceCount).toBe(1);
    expect(alpha.runs).toBe(3);
    // 0.1 + 0.2 + 4.5 rounded with the EPSILON guard: 4.8, labeled estimated.
    expect(alpha.spend).toEqual({ value: 4.8, estimated: true });
    const outsider = res.workspaces[1];
    expect(outsider.spend).toEqual({ value: 7, estimated: true });
    const beta = res.workspaces[0];
    expect(beta.memberCount).toBe(0);
    expect(beta.spend).toEqual({ value: 0, estimated: true });
  });

  test("workspace tier sees only in-scope workspaces (no cross-rows)", async () => {
    const state = seedState();
    const res = await queryWorkspacesList(depsFor(state, WORKSPACE_ADMIN), {
      ...BASE_INPUT,
    });
    expect(res.workspaces.map((w) => w.id)).toEqual(["w1"]);
    expect(res.total).toBe(1);
    expect(JSON.stringify(res)).not.toContain("Outsider");
    expect(JSON.stringify(res)).not.toContain("outsider");
  });

  test("stale scope returns the empty list, not an error", async () => {
    const state = seedState();
    const res = await queryWorkspacesList(depsFor(state, STALE_ADMIN), {
      ...BASE_INPUT,
    });
    expect(res).toEqual({
      workspaces: [],
      total: 0,
      pages: 0,
      page: 1,
      limit: 20,
    });
  });

  test("limit=999999 is capped by getPagination", async () => {
    const state = seedState();
    const res = await queryWorkspacesList(depsFor(state, PLATFORM_ADMIN), {
      ...BASE_INPUT,
      limit: 999999,
    });
    expect(res.limit).toBe(100);
    expect(res.workspaces).toHaveLength(3);
  });

  test("off-allowlist sort falls back to created_at", async () => {
    const state = seedState();
    const res = await queryWorkspacesList(depsFor(state, PLATFORM_ADMIN), {
      ...BASE_INPUT,
      sort: "password",
      order: "desc",
    });
    expect(res.workspaces.map((w) => w.id)).toEqual(["w2", "w9", "w1"]);
    const byName = await queryWorkspacesList(depsFor(state, PLATFORM_ADMIN), {
      ...BASE_INPUT,
      sort: "name",
      order: "asc",
    });
    expect(byName.workspaces.map((w) => w.id)).toEqual(["w1", "w2", "w9"]);
  });

  test("junk plan/status throw 400; empty string means no filter", async () => {
    const state = seedState();
    await expect(
      queryWorkspacesList(depsFor(state, PLATFORM_ADMIN), {
        ...BASE_INPUT,
        plan: "gold",
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "BAD_REQUEST",
    });
    await expect(
      queryWorkspacesList(depsFor(state, PLATFORM_ADMIN), {
        ...BASE_INPUT,
        status: "archived",
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "BAD_REQUEST",
    });
    const unfiltered = await queryWorkspacesList(
      depsFor(state, PLATFORM_ADMIN),
      { ...BASE_INPUT, plan: "", status: "" },
    );
    expect(unfiltered.total).toBe(3);
  });

  test("q contains-matches name/slug; under-length q is ignored", async () => {
    const state = seedState();
    const filtered = await queryWorkspacesList(depsFor(state, PLATFORM_ADMIN), {
      ...BASE_INPUT,
      q: "eta",
    });
    expect(filtered.workspaces.map((w) => w.id)).toEqual(["w2"]);
    expect(filtered.total).toBe(1);
    const ignored = await queryWorkspacesList(depsFor(state, PLATFORM_ADMIN), {
      ...BASE_INPUT,
      q: "a",
    });
    expect(ignored.total).toBe(3);
  });

  test("picker params return rows projecting to id/name/slug", async () => {
    const state = seedState();
    const res = await queryWorkspacesList(depsFor(state, PLATFORM_ADMIN), {
      page: 1,
      limit: 100,
      sort: "name",
      order: "asc",
      q: null,
      plan: null,
      status: null,
    });
    expect(
      res.workspaces.map((w) => ({ id: w.id, name: w.name, slug: w.slug })),
    ).toEqual([
      { id: "w1", name: "Alpha", slug: "alpha" },
      { id: "w2", name: "Beta", slug: "beta" },
      { id: "w9", name: "Outsider", slug: "outsider" },
    ]);
  });
});

describe("queryWorkspaceDetail helper", () => {
  test("detail aggregates members with emails plus metrics", async () => {
    const state = seedState();
    const res = await queryWorkspaceDetail(depsFor(state, PLATFORM_ADMIN), "w1");
    expect(res.workspace).toEqual({
      id: "w1",
      name: "Alpha",
      slug: "alpha",
      plan: "pro",
      status: "active",
      created_at: "2024-01-01T00:00:00.000Z",
    });
    expect(res.members).toEqual([
      {
        user_id: "u1",
        role: "admin",
        joined_at: "2024-01-02T00:00:00.000Z",
        email: "a@example.com",
      },
      {
        user_id: "u2",
        role: "member",
        joined_at: null,
        email: "b@example.com",
      },
      { user_id: "u3", role: "member", joined_at: null, email: "" },
    ]);
    expect(res.metrics).toEqual({
      members: 3,
      startups: 2,
      evidence: 1,
      runs: 3,
      spend: { value: 4.8, estimated: true },
    });
  });

  test("unknown id throws 404 NOT_FOUND", async () => {
    const state = seedState();
    await expect(
      queryWorkspaceDetail(depsFor(state, PLATFORM_ADMIN), "nope"),
    ).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      message: "Workspace not found",
    });
  });

  test("workspace tier cannot read an out-of-scope workspace (403, no data)", async () => {
    const state = seedState();
    const err = await queryWorkspaceDetail(
      depsFor(state, WORKSPACE_ADMIN),
      "w9",
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "Workspace out of scope",
    });
    expect(JSON.stringify(err)).not.toContain("Outsider");
  });
});

describe("workspaces route delegation", () => {
  test("list route GET calls queryWorkspacesList with the raw params", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });
    const res = await workspacesGET(
      new NextRequest(
        "http://x/api/admin/workspaces?page=1&limit=20&sort=name&order=asc&plan=pro",
      ),
    );
    expect(res.status).toBe(200);
    expect(queryListSpy).toHaveBeenCalledTimes(1);
    expect(queryListSpy).toHaveBeenCalledWith(
      expect.objectContaining({ admin: PLATFORM_ADMIN }),
      {
        page: "1",
        limit: "20",
        sort: "name",
        order: "asc",
        q: null,
        plan: "pro",
        status: null,
      },
    );
    const body = await res.json();
    expect(body.workspaces.map((w: { id: string }) => w.id)).toEqual(["w1"]);
    expect(body.total).toBe(1);
  });

  test("list route GET maps junk plan to the exact 400 envelope", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });
    const res = await workspacesGET(
      new NextRequest("http://x/api/admin/workspaces?plan=gold"),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Invalid plan filter",
      code: "BAD_REQUEST",
    });
  });

  test("detail route GET delegates; unknown id maps to 404; PATCH stays", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });
    const res = await workspaceDetailGET(new NextRequest("http://x/id"), {
      params: Promise.resolve({ id: "w1" }),
    });
    expect(res.status).toBe(200);
    expect(queryDetailSpy).toHaveBeenCalledTimes(1);
    expect(queryDetailSpy).toHaveBeenCalledWith(
      expect.objectContaining({ admin: PLATFORM_ADMIN }),
      "w1",
    );
    const body = await res.json();
    expect(body.workspace.id).toBe("w1");
    expect(body.metrics.members).toBe(3);

    const missing = await workspaceDetailGET(new NextRequest("http://x/id"), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: "Workspace not found",
      code: "NOT_FOUND",
    });
    expect(typeof workspaceDetailPATCH).toBe("function");
  });
});

describe("workspaces DAL parity", () => {
  test("runAdminQuery returns the same DTO the route returns", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });
    const input: WorkspacesListInput = {
      page: 1,
      limit: 20,
      sort: "name",
      order: "asc",
      q: null,
      plan: null,
      status: null,
    };
    const dalRes = await runAdminQuery((deps) =>
      queryWorkspacesList(deps, input),
    );
    const routeRes = await workspacesGET(
      new NextRequest(
        "http://x/api/admin/workspaces?page=1&limit=20&sort=name&order=asc",
      ),
    );
    const routeBody = await routeRes.json();
    expect(dalRes).toEqual({ ok: true, data: routeBody });
  });
});
