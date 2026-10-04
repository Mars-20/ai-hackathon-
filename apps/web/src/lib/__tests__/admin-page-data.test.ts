// ─────────────────────────────────────────────────────────────────────────────
// admin-page-data.test.ts — concurrency contract for admin page data loaders.
// Pages must fire their independent adminApiFetch calls CONCURRENTLY, not in
// an await waterfall: each hop is a self-HTTP roundtrip plus a full
// requireAdmin gate (getUser + RPC + memberships), so sequential awaits
// multiply latency. The red/green discriminator: with deferred fetch
// promises, BOTH backend calls must start before EITHER resolves.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, expect, test, vi, beforeEach } from "vitest";
import { AdminApiError } from "@/lib/admin-fetch";
import {
  loadAnalyticsPageData,
  loadContentPageData,
  loadOpsAdmins,
  loadOpsPageData,
  loadUsersPageData,
  loadWorkspaceDetailPageData,
} from "@/lib/admin-page-data";

vi.mock("@/lib/admin-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-fetch")>();
  return { ...actual, adminApiFetch: vi.fn() };
});

import { adminApiFetch } from "@/lib/admin-fetch";

const mockedFetch = vi.mocked(adminApiFetch);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tick(): Promise<void> {
  return new Promise((res) => setTimeout(res, 0));
}

const USERS_BODY = {
  users: [
    {
      id: "u1",
      email: "a@example.com",
      created_at: new Date().toISOString(),
      status: "active",
      workspaces: [],
    },
  ],
  total: 1,
  pages: 1,
  page: 1,
  limit: 20,
};

const WS_BODY = {
  workspaces: [{ id: "w1", name: "Acme", slug: "acme" }],
};

beforeEach(() => {
  mockedFetch.mockReset();
});

describe("loadUsersPageData", () => {
  test("fires /api/admin/users and /api/admin/workspaces concurrently", async () => {
    const usersGate = deferred<unknown>();
    const wsGate = deferred<unknown>();
    mockedFetch.mockImplementation((path: string) => {
      if (path === "/api/admin/users") return usersGate.promise;
      return wsGate.promise;
    });

    const pending = loadUsersPageData("page=1");
    await tick();
    await tick();

    // RED discriminator: sequential awaits only start the second fetch
    // after the first resolves — so both must already be in flight here.
    expect(mockedFetch).toHaveBeenCalledTimes(2);

    wsGate.resolve(WS_BODY);
    usersGate.resolve(USERS_BODY);
    const data = await pending;
    expect(data.usersBody).toEqual(USERS_BODY);
    expect(data.usersError).toBeNull();
    expect(data.pickerWorkspaces).toEqual([
      { id: "w1", name: "Acme", slug: "acme" },
    ]);
  });

  test("users failure surfaces the AdminApiError message, workspaces still load", async () => {
    mockedFetch.mockImplementation((path: string) => {
      if (path === "/api/admin/users")
        return Promise.reject(new AdminApiError(500, "X", "boom-users"));
      return Promise.resolve(WS_BODY);
    });

    const data = await loadUsersPageData("page=1");
    expect(data.usersBody).toBeNull();
    expect(data.usersError).toBe("boom-users");
    expect(data.pickerWorkspaces).toEqual([
      { id: "w1", name: "Acme", slug: "acme" },
    ]);
  });

  test("workspaces failure degrades to an empty picker, users still load", async () => {
    mockedFetch.mockImplementation((path: string) => {
      if (path === "/api/admin/users") return Promise.resolve(USERS_BODY);
      return Promise.reject(new Error("ws down"));
    });

    const data = await loadUsersPageData("page=1");
    expect(data.usersBody).toEqual(USERS_BODY);
    expect(data.usersError).toBeNull();
    expect(data.pickerWorkspaces).toEqual([]);
  });

  test("Next.js redirect errors are rethrown, never swallowed", async () => {
    const redirectErr = new Error("NEXT_REDIRECT") as Error & {
      digest: string;
    };
    redirectErr.digest = "NEXT_REDIRECT;replace;/login;307;";
    mockedFetch.mockRejectedValue(redirectErr);

    await expect(loadUsersPageData("page=1")).rejects.toBe(redirectErr);
  });
});

function redirectError(): Error {
  const err = new Error("NEXT_REDIRECT") as Error & { digest: string };
  err.digest = "NEXT_REDIRECT;replace;/login;307;";
  return err;
}

describe("loadOpsPageData", () => {
  test("fires all five ops reads concurrently", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<unknown>>>();
    mockedFetch.mockImplementation((path: string) => {
      const gate = deferred<unknown>();
      gates.set(path, gate);
      return gate.promise;
    });

    const pending = loadOpsPageData("page=1&limit=20");
    await tick();
    await tick();

    expect(mockedFetch).toHaveBeenCalledTimes(5);

    for (const gate of gates.values()) gate.resolve({});
    const data = await pending;
    // {} has no tier field → workspace tier, same rule as the page.
    expect(data.tier).toBe("workspace");
  });

  test("platform tier is derived from /api/admin/me", async () => {
    mockedFetch.mockImplementation((path: string) => {
      if (path === "/api/admin/me") return Promise.resolve({ tier: "platform" });
      return Promise.resolve({});
    });

    const data = await loadOpsPageData("page=1&limit=20");
    expect(data.tier).toBe("platform");
    expect(mockedFetch).toHaveBeenCalledTimes(5);
  });

  test("one failing section does not fail the others; redirect rethrows", async () => {
    mockedFetch.mockImplementation((path: string) => {
      if (path === "/api/admin/ops/limits")
        return Promise.reject(new AdminApiError(500, "X", "limits down"));
      return Promise.resolve({});
    });

    const data = await loadOpsPageData("page=1&limit=20");
    expect(data.limits.body).toBeNull();
    expect(data.audit.body).toEqual({});

    mockedFetch.mockRejectedValue(redirectError());
    await expect(loadOpsPageData("page=1")).rejects.toThrow("NEXT_REDIRECT");
  });
});

describe("loadOpsAdmins", () => {
  test("fetches the platform admins list", async () => {
    mockedFetch.mockResolvedValue({ admins: [] });
    const settled = await loadOpsAdmins();
    expect(settled.body).toEqual({ admins: [] });
    expect(mockedFetch).toHaveBeenCalledWith("/api/admin/ops/admins", undefined);
  });
});

describe("loadContentPageData", () => {
  test("fires list and details concurrently when a focus id is open", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<unknown>>>();
    mockedFetch.mockImplementation((path: string) => {
      const gate = deferred<unknown>();
      gates.set(path, gate);
      return gate.promise;
    });

    const pending = loadContentPageData("page=1", "startup-1");
    await tick();
    await tick();

    expect(mockedFetch).toHaveBeenCalledTimes(2);

    for (const gate of gates.values()) gate.resolve({});
    const data = await pending;
    expect(data.startups.body).toEqual({});
    expect(data.details?.body).toEqual({});
  });

  test("no details fetch without a focus id", async () => {
    mockedFetch.mockResolvedValue({ startups: [] });

    const data = await loadContentPageData("page=1", null);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(data.details).toBeNull();
  });
});

describe("loadAnalyticsPageData", () => {
  test("fires snapshot and experiments concurrently", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<unknown>>>();
    mockedFetch.mockImplementation((path: string) => {
      const gate = deferred<unknown>();
      gates.set(path, gate);
      return gate.promise;
    });

    const pending = loadAnalyticsPageData("7d");
    await tick();
    await tick();

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(mockedFetch).toHaveBeenCalledWith(
      "/api/admin/analytics",
      "window=7d",
    );

    for (const gate of gates.values()) gate.resolve({});
    const data = await pending;
    expect(data.analytics.body).toEqual({});
    expect(data.experiments.body).toEqual({});
  });
});

describe("loadWorkspaceDetailPageData", () => {
  test("fires detail and siblings concurrently", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<unknown>>>();
    mockedFetch.mockImplementation((path: string) => {
      const gate = deferred<unknown>();
      gates.set(path, gate);
      return gate.promise;
    });

    const pending = loadWorkspaceDetailPageData("ws-1");
    await tick();
    await tick();

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(mockedFetch).toHaveBeenCalledWith("/api/admin/workspaces/ws-1", undefined);

    for (const gate of gates.values()) gate.resolve({});
    const data = await pending;
    expect(data.detail.body).toEqual({});
    expect(data.siblings.body).toEqual({});
  });
});
