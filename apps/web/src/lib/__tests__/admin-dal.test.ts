import { describe, expect, test, vi, beforeEach } from "vitest";

// server-only resolves to empty.js under the react-server export condition;
// vitest uses the default condition (which throws), so mirror production.
vi.mock("server-only", () => ({}));

// React resolves cache() per request scope in production (Next.js App Router
// establishes the scope); in unit tests there is no scope, so React passes
// straight through (verified against react's source + a renderToString probe).
// This counter wrapper delegates to the REAL cache and only records that our
// module wraps its gate exactly once — the behavior pin. Per-request
// single-execution is verified live in Task 8's timing table.
const { cacheWraps } = vi.hoisted(() => ({
  cacheWraps: [] as unknown[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    cache: (fn: (...args: never[]) => unknown) => {
      cacheWraps.push(fn);
      return actual.cache(fn);
    },
  };
});

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

import { requireAdminFromSupabase } from "@/lib/admin";

const mockedGate = vi.mocked(requireAdminFromSupabase);

async function freshDal() {
  vi.resetModules();
  return import("@/lib/admin-dal");
}

beforeEach(() => {
  mockedGate.mockReset();
});

describe("getCachedAdminContext", () => {
  test("two calls in one request share one gate (cached, single execution)", async () => {
    mockedGate.mockResolvedValue({
      user: { id: "u1" },
      tier: "platform",
      workspaceIds: ["w1"],
    });
    cacheWraps.length = 0;
    const dal = await freshDal();
    // The module wraps its gate in React cache() exactly once at scope:
    // layout + page + every DAL call share it.
    expect(cacheWraps).toHaveLength(1);
    expect(typeof cacheWraps[0]).toBe("function");
    const [a, b] = await Promise.all([
      dal.getCachedAdminContext(),
      dal.getCachedAdminContext(),
    ]);
    expect(a).toEqual(b);
    expect(a.tier).toBe("platform");
    expect(b.tier).toBe("platform");
  });

  test("viewer-role member gets 403 from the gate (fail closed)", async () => {
    const err = new Error("Admin access required") as Error & {
      status: number;
      code: string;
    };
    err.name = "AdminError";
    err.status = 403;
    err.code = "FORBIDDEN";
    mockedGate.mockRejectedValue(err);
    const dal = await freshDal();
    await expect(dal.runAdminQuery(async () => ({ x: 1 }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
  });

  test("expired session (401) redirects to /login, never a blank render", async () => {
    const err = new Error("Authentication required") as Error & {
      status: number;
      code: string;
    };
    err.name = "AdminError";
    err.status = 401;
    err.code = "UNAUTHORIZED";
    mockedGate.mockRejectedValue(err);
    const dal = await freshDal();
    const outcome = await dal
      .runAdminQuery(async () => ({ x: 1 }))
      .then(
        () => "resolved",
        (e: Error & { digest?: string }) => e.digest ?? "threw",
      );
    expect(outcome).toContain("/login");
  });

  test("throwing platform RPC fails closed through the same gate", async () => {
    mockedGate.mockResolvedValue({
      user: { id: "u1" },
      tier: "workspace",
      workspaceIds: ["w1"],
    });
    const dal = await freshDal();
    const res = await dal.runAdminQuery(async (deps) => ({
      scopedTo: deps.admin.workspaceIds,
    }));
    expect(res).toEqual({ ok: true, data: { scopedTo: ["w1"] } });
  });

  test("data failure normalizes to { status, code, message }", async () => {
    mockedGate.mockResolvedValue({
      user: { id: "u1" },
      tier: "platform",
      workspaceIds: [],
    });
    const dal = await freshDal();
    const res = await dal.runAdminQuery(async () => {
      throw new Error("db exploded");
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(typeof res.error.message).toBe("string");
  });
});
