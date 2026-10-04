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

vi.mock("@/lib/admin-queries/users", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/admin-queries/users")>();
  return { ...actual, queryUsersList: vi.fn(actual.queryUsersList) };
});

import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";
import { requireAdminFromSupabase } from "@/lib/admin";
import type { RequireAdminResult } from "@/lib/admin";
import {
  queryUsersList,
  type UsersListInput,
} from "@/lib/admin-queries/users";
import type { AdminQueryDeps } from "@/lib/admin-queries/shared";
import { GET as usersGET } from "@/app/api/admin/users/route";
import { runAdminQuery } from "@/lib/admin-dal";

const mockedClient = vi.mocked(createServerSupabaseClient);
const mockedServiceClient = vi.mocked(createServiceRoleClient);
const mockedGate = vi.mocked(requireAdminFromSupabase);
const queryUsersSpy = vi.mocked(queryUsersList);

interface FakeProfile {
  user_id: string;
  email: string;
  created_at: string;
}

interface FakeMember {
  user_id: string;
  workspace_id: string;
  role: string;
}

interface FakeUsersState {
  profiles: FakeProfile[];
  members: FakeMember[];
  banned: string[];
}

const U1 = {
  user_id: "user-1",
  email: "alpha@example.com",
  created_at: "2024-01-01T00:00:00.000Z",
};
const U2 = {
  user_id: "user-2",
  email: "beta@example.com",
  created_at: "2025-06-01T00:00:00.000Z",
};
const OUTSIDER = {
  user_id: "user-9",
  email: "outsider@example.com",
  created_at: "2024-06-01T00:00:00.000Z",
};

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

// In-memory PostgREST fake: supports the exact chains the users query uses
// (select/order/ilike/range/in + await with { data, error, count }).
// `count` is the pre-range filtered total, like PostgREST count:"exact".
function makeUsersClient(state: FakeUsersState) {
  const from = (table: string) => {
    const eqs: Array<{ col: string; val: unknown }> = [];
    const ins: Array<{ col: string; vals: unknown[] }> = [];
    let ilike: { col: string; pattern: string } | null = null;
    let orderCol: string | null = null;
    let ascending = true;
    let range: [number, number] | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = {
      select: () => q,
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderCol = col;
        ascending = opts?.ascending ?? true;
        return q;
      },
      ilike: (col: string, pattern: string) => {
        ilike = { col, pattern };
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
      range: (a: number, b: number) => {
        range = [a, b];
        return q;
      },
      // Thenable so `await q` resolves like a PostgREST filter builder.
      then: (resolve: (v: unknown) => void) => resolve(compute()),
    };
    function compute() {
      let rows: Record<string, unknown>[] =
        table === "profiles"
          ? (state.profiles as unknown as Record<string, unknown>[])
          : (state.members as unknown as Record<string, unknown>[]);
      for (const { col, val } of eqs) {
        rows = rows.filter((r) => r[col] === val);
      }
      for (const { col, vals } of ins) {
        rows = rows.filter((r) => vals.includes(r[col]));
      }
      if (ilike !== null) {
        const unescaped = ilike.pattern.replace(/\\/g, "");
        const prefix = unescaped.endsWith("%")
          ? unescaped.slice(0, -1)
          : unescaped;
        rows = rows.filter((r) =>
          String(r[ilike!.col])
            .toLowerCase()
            .startsWith(prefix.toLowerCase()),
        );
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
      return { data: rows, error: null, count: total };
    }
    return q;
  };
  return {
    auth: {
      admin: {
        getUserById: async (id: string) => ({
          data: {
            user: state.banned.includes(id)
              ? { banned_until: "2026-01-01T00:00:00.000Z" }
              : {},
          },
        }),
      },
    },
    from,
  };
}

function setup(state: FakeUsersState) {
  mockedClient.mockResolvedValue(
    makeUsersClient(state) as unknown as Awaited<
      ReturnType<typeof createServerSupabaseClient>
    >,
  );
  mockedServiceClient.mockReturnValue(
    makeUsersClient(state) as unknown as ReturnType<
      typeof createServiceRoleClient
    >,
  );
}

function depsFor(state: FakeUsersState, admin: unknown): AdminQueryDeps {
  const client = makeUsersClient(state);
  return {
    admin: admin as AdminQueryDeps["admin"],
    userClient: client as unknown as AdminQueryDeps["userClient"],
    service: client as unknown as AdminQueryDeps["service"],
  };
}

const BASE_INPUT: UsersListInput = {
  page: 1,
  limit: 20,
  sort: "created_at",
  order: "desc",
  q: null,
};

function seedState(): FakeUsersState {
  return {
    profiles: [U1, U2],
    members: [{ user_id: U1.user_id, workspace_id: "w1", role: "admin" }],
    banned: [U2.user_id],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("queryUsersList helper", () => {
  test("platform tier sees all rows with status and memberships", async () => {
    const state = seedState();
    const res = await queryUsersList(depsFor(state, PLATFORM_ADMIN), {
      ...BASE_INPUT,
    });
    expect(res.total).toBe(2);
    expect(res.pages).toBe(1);
    expect(res.page).toBe(1);
    expect(res.limit).toBe(20);
    // created_at desc: beta (2025) before alpha (2024).
    expect(res.users.map((u) => u.id)).toEqual([U2.user_id, U1.user_id]);
    const beta = res.users[0];
    expect(beta.email).toBe("beta@example.com");
    expect(beta.status).toBe("suspended");
    const alpha = res.users[1];
    expect(alpha.status).toBe("active");
    expect(alpha.workspaces).toEqual([
      { workspace_id: "w1", role: "admin" },
    ]);
  });

  test("workspace tier sees only in-scope emails (no PII leak)", async () => {
    const state = seedState();
    state.profiles.push(OUTSIDER);
    state.members.push({
      user_id: OUTSIDER.user_id,
      workspace_id: "w2",
      role: "member",
    });
    const res = await queryUsersList(depsFor(state, WORKSPACE_ADMIN), {
      ...BASE_INPUT,
    });
    expect(res.users.map((u) => u.id)).toEqual([U1.user_id]);
    expect(res.total).toBe(1);
    expect(JSON.stringify(res)).not.toContain("outsider@example.com");
  });

  test("limit=999999 is capped by getPagination", async () => {
    const state = seedState();
    const res = await queryUsersList(depsFor(state, PLATFORM_ADMIN), {
      ...BASE_INPUT,
      limit: 999999,
    });
    expect(res.limit).toBe(100);
    expect(res.users).toHaveLength(2);
  });

  test("off-allowlist sort falls back to created_at", async () => {
    const state = seedState();
    const res = await queryUsersList(depsFor(state, PLATFORM_ADMIN), {
      ...BASE_INPUT,
      sort: "password",
      order: "desc",
    });
    // created_at desc, not email order: beta (2025) first.
    expect(res.users.map((u) => u.id)).toEqual([U2.user_id, U1.user_id]);
    const byEmail = await queryUsersList(depsFor(state, PLATFORM_ADMIN), {
      ...BASE_INPUT,
      sort: "email",
      order: "asc",
    });
    expect(byEmail.users.map((u) => u.id)).toEqual([
      U1.user_id,
      U2.user_id,
    ]);
  });

  test("q prefix search filters; under-length q is ignored", async () => {
    const state = seedState();
    const filtered = await queryUsersList(depsFor(state, PLATFORM_ADMIN), {
      ...BASE_INPUT,
      q: "alp",
    });
    expect(filtered.users.map((u) => u.id)).toEqual([U1.user_id]);
    expect(filtered.total).toBe(1);
    const ignored = await queryUsersList(depsFor(state, PLATFORM_ADMIN), {
      ...BASE_INPUT,
      q: "a",
    });
    expect(ignored.total).toBe(2);
  });
});

describe("users route delegation", () => {
  test("route GET calls queryUsersList with the raw params", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });
    const res = await usersGET(
      new NextRequest(
        "http://x/api/admin/users?page=1&limit=20&sort=email&order=asc",
      ),
    );
    expect(res.status).toBe(200);
    expect(queryUsersSpy).toHaveBeenCalledTimes(1);
    expect(queryUsersSpy).toHaveBeenCalledWith(
      expect.objectContaining({ admin: PLATFORM_ADMIN }),
      { page: "1", limit: "20", sort: "email", order: "asc", q: null },
    );
    const body = await res.json();
    expect(body.users).toHaveLength(2);
    expect(body.total).toBe(2);
  });
});

describe("users DAL parity", () => {
  test("runAdminQuery returns the same DTO the route returns", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });
    const input: UsersListInput = {
      page: 1,
      limit: 20,
      sort: "email",
      order: "asc",
      q: null,
    };
    const dalRes = await runAdminQuery((deps) =>
      queryUsersList(deps, input),
    );
    const routeRes = await usersGET(
      new NextRequest(
        "http://x/api/admin/users?page=1&limit=20&sort=email&order=asc",
      ),
    );
    const routeBody = await routeRes.json();
    expect(dalRes).toEqual({ ok: true, data: routeBody });
  });
});
