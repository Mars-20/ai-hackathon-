import { describe, test, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── Task 8 (TDD RED): admin subscription-request queue ─────────────────────
// POST /api/admin/requests { request_id, action, plan? } → approve / reject /
// pause via the `admin_action` RPC ONLY (never direct user_entitlements
// writes); GET ?status=pending → queue newest-first with entitlement display
// context (display only, never trusted).
// Owner gate = repo PLATFORM_OWNER_EMAILS env (comma-separated emails,
// case-insensitive). Repo-wide search shows NO pre-existing
// PLATFORM_OWNER_EMAILS mechanism — route.ts defines it canonically and both
// the route and these tests reuse that exact env contract. The env is EMPTY
// pre-launch → every caller 403s; the UI renders the helpful empty-owner
// message instead of data (never a bare 403 dump, never rows).
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
}));

import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";
import {
  POST as adminRequestsPOST,
  GET as adminRequestsGET,
} from "@/app/api/admin/requests/route";

const mockedUserClient = vi.mocked(createServerSupabaseClient);
const mockedServiceClient = vi.mocked(createServiceRoleClient);

const OWNER_EMAIL = "owner@example.com";
const OWNER_ID = "owner-1111";
const USER_ID = "user-2222";
const REQ_ID = "11111111-1111-4111-8111-111111111111";
const UNKNOWN_ID = "22222222-2222-4222-8222-222222222222";

interface Canned {
  data: unknown;
  error: { message: string; code?: string } | null;
}

interface RpcCall {
  fn: string;
  args: unknown;
}

// Chainable PostgREST fake (mock style per subscription-requests.test.ts):
// select/eq/order/in return the builder; maybeSingle/single resolve the
// canned single payload; `await q` resolves the canned list payload.
// rpc() records calls and resolves the canned rpc payload.
function mockClients(opts: {
  user: { id: string; email?: string } | null;
  list?: Record<string, Canned>;
  single?: Record<string, Canned>;
  rpc?: Canned;
  rpcCalls?: RpcCall[];
  serviceFromCalls?: string[];
}) {
  const { user, list = {}, single = {}, rpcCalls = [], serviceFromCalls = [] } = opts;
  const rpcPayload: Canned = opts.rpc ?? { data: null, error: null };

  const makeBuilder = (table: string) => {
    const listPayload: Canned = list[table] ?? { data: [], error: null };
    const singlePayload: Canned =
      single[table] ??
      (Array.isArray(listPayload.data)
        ? {
            data: listPayload.data.length > 0 ? listPayload.data[0] : null,
            error: null,
          }
        : listPayload);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = {
      select: () => q,
      eq: () => q,
      order: () => q,
      in: () => q,
      limit: () => q,
      maybeSingle: async () => singlePayload,
      single: async () => singlePayload,
      then: (resolve: (v: unknown) => void) => resolve(listPayload),
    };
    return q;
  };

  const rpcFn = async (fn: string, args: unknown) => {
    rpcCalls.push({ fn, args });
    return rpcPayload;
  };

  mockedUserClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user } }) },
    rpc: rpcFn,
    from: (table: string) => makeBuilder(table),
  } as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>);
  mockedServiceClient.mockReturnValue({
    auth: { getUser: async () => ({ data: { user } }) },
    rpc: rpcFn,
    from: (table: string) => {
      serviceFromCalls.push(table);
      return makeBuilder(table);
    },
  } as unknown as ReturnType<typeof createServiceRoleClient>);
}

function postReq(body: unknown) {
  return new NextRequest("http://x/api/admin/requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getReq(query = "?status=pending") {
  return new NextRequest(`http://x/api/admin/requests${query}`);
}

const PENDING_ROWS = [
  {
    id: REQ_ID,
    user_id: USER_ID,
    plan: "pro",
    full_name: "Sara Ahmed",
    phone: "+966500000001",
    company: "Acme",
    status: "pending",
    created_at: "2026-10-02T10:00:00.000Z",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    user_id: "user-3333",
    plan: "team",
    full_name: "Omar Khalid",
    phone: "+966500000002",
    company: null,
    status: "pending",
    created_at: "2026-10-01T10:00:00.000Z",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PLATFORM_OWNER_EMAILS = OWNER_EMAIL;
});

describe("POST /api/admin/requests (Task 8)", () => {
  test("403 non-owner (verbatim FORBIDDEN envelope)", async () => {
    const rpcCalls: RpcCall[] = [];
    const serviceFromCalls: string[] = [];
    mockClients({
      user: { id: USER_ID, email: "user@example.com" },
      rpcCalls,
      serviceFromCalls,
    });
    const res = await adminRequestsPOST(
      postReq({ request_id: REQ_ID, action: "approve" }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "محظور", code: "FORBIDDEN" });
    expect(rpcCalls).toHaveLength(0);
    expect(serviceFromCalls).toHaveLength(0);
  });

  test("400 bad action", async () => {
    mockClients({ user: { id: OWNER_ID, email: OWNER_EMAIL } });
    const res = await adminRequestsPOST(
      postReq({ request_id: REQ_ID, action: "freeze" }),
    );
    expect(res.status).toBe(400);
  });

  test("400 bad uuid", async () => {
    mockClients({ user: { id: OWNER_ID, email: OWNER_EMAIL } });
    const res = await adminRequestsPOST(
      postReq({ request_id: "not-a-uuid", action: "approve" }),
    );
    expect(res.status).toBe(400);
  });

  test("404 unknown id (rpc error P0001 → NOT_FOUND)", async () => {
    mockClients({
      user: { id: OWNER_ID, email: OWNER_EMAIL },
      list: {
        subscription_requests: {
          data: [{ id: UNKNOWN_ID, user_id: USER_ID, plan: "pro", status: "pending" }],
          error: null,
        },
      },
    });
    mockedUserClient.mockResolvedValue({
      auth: {
        getUser: async () => ({
          data: { user: { id: OWNER_ID, email: OWNER_EMAIL } },
        }),
      },
      rpc: async () => ({
        data: null,
        error: { message: "request not found", code: "P0001" },
      }),
      from: (table: string) => {
        if (table === "subscription_requests") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: {
                    id: UNKNOWN_ID,
                    user_id: USER_ID,
                    plan: "pro",
                    status: "pending",
                  },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        };
      },
    } as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>);
    const res = await adminRequestsPOST(
      postReq({ request_id: UNKNOWN_ID, action: "approve" }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "الطلب غير موجود",
      code: "NOT_FOUND",
    });
  });

  test("200 approve path returns request shape + calls admin_action RPC", async () => {
    const rpcCalls: RpcCall[] = [];
    mockClients({
      user: { id: OWNER_ID, email: OWNER_EMAIL },
      list: {
        subscription_requests: {
          data: [
            { id: REQ_ID, user_id: USER_ID, plan: "pro", status: "pending" },
          ],
          error: null,
        },
      },
      rpc: {
        data: { ok: true, action: "approve_subscription" },
        error: null,
      },
      rpcCalls,
    });
    const res = await adminRequestsPOST(
      postReq({ request_id: REQ_ID, action: "approve", plan: "pro" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      request: { id: REQ_ID, status: "approved", plan: "pro" },
    });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("admin_action");
    expect(rpcCalls[0].args).toMatchObject({
      action: "approve_subscription",
      target: { user_id: USER_ID },
    });
  });

  test("200 reject + pause paths return request shape", async () => {
    mockClients({
      user: { id: OWNER_ID, email: OWNER_EMAIL },
      list: {
        subscription_requests: {
          data: [
            { id: REQ_ID, user_id: USER_ID, plan: "team", status: "pending" },
          ],
          error: null,
        },
      },
      rpc: { data: { ok: true }, error: null },
    });
    const rejectRes = await adminRequestsPOST(
      postReq({ request_id: REQ_ID, action: "reject" }),
    );
    expect(rejectRes.status).toBe(200);
    expect(await rejectRes.json()).toEqual({
      request: { id: REQ_ID, status: "rejected", plan: "team" },
    });

    const pauseRes = await adminRequestsPOST(
      postReq({ request_id: REQ_ID, action: "pause" }),
    );
    expect(pauseRes.status).toBe(200);
    expect(await pauseRes.json()).toEqual({
      request: { id: REQ_ID, status: "paused", plan: "team" },
    });
  });

  test("RPC ok:false forbidden surfaces as 403 (pause deny trail)", async () => {
    mockClients({
      user: { id: OWNER_ID, email: OWNER_EMAIL },
      list: {
        subscription_requests: {
          data: [
            { id: REQ_ID, user_id: USER_ID, plan: "pro", status: "pending" },
          ],
          error: null,
        },
      },
      rpc: { data: { ok: false, error: "forbidden" }, error: null },
    });
    const res = await adminRequestsPOST(
      postReq({ request_id: REQ_ID, action: "pause" }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "محظور", code: "FORBIDDEN" });
  });
});

describe("GET /api/admin/requests (Task 8)", () => {
  test("403 non-owner (verbatim FORBIDDEN envelope, never rows)", async () => {
    const rpcCalls: RpcCall[] = [];
    const serviceFromCalls: string[] = [];
    mockClients({
      user: { id: USER_ID, email: "user@example.com" },
      rpcCalls,
      serviceFromCalls,
    });
    const res = await adminRequestsGET(getReq());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "محظور", code: "FORBIDDEN" });
    expect(rpcCalls).toHaveLength(0);
    expect(serviceFromCalls).toHaveLength(0);
  });

  test("200 owner sees pending queue with entitlement context", async () => {
    mockClients({
      user: { id: OWNER_ID, email: OWNER_EMAIL },
      list: {
        subscription_requests: { data: PENDING_ROWS, error: null },
        user_entitlements: {
          data: [
            { user_id: USER_ID, status: "trial_consumed", plan: "free" },
            { user_id: "user-3333", status: "trial_active", plan: "free" },
          ],
          error: null,
        },
      },
    });
    const res = await adminRequestsGET(getReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requests: Array<Record<string, unknown>> };
    expect(body.requests).toHaveLength(2);
    // Newest-first passthrough of the created_at-desc service query.
    expect(body.requests[0]["id"]).toBe(REQ_ID);
    expect(body.requests[0]["full_name"]).toBe("Sara Ahmed");
    expect(body.requests[0]).toMatchObject({
      entitlement: { status: "trial_consumed", plan: "free" },
    });
  });
});

describe("task 8 static contract (RPC-only money-adjacent writes)", () => {
  const routeSrc = readFileSync(
    join(__dirname, "..", "admin", "requests", "route.ts"),
    "utf8",
  );
  const pageSrc = readFileSync(
    join(__dirname, "..", "..", "admin", "requests", "page.tsx"),
    "utf8",
  );

  test("state changes go through the admin_action RPC", () => {
    expect(routeSrc).toMatch(/rpc\(\s*"admin_action"/);
  });

  test("no direct user_entitlements writes in the admin route", () => {
    expect(routeSrc).not.toMatch(/\.(update|upsert|insert|delete)\s*\(/);
  });

  test("owner gate reuses the PLATFORM_OWNER_EMAILS env contract", () => {
    expect(routeSrc).toMatch(/PLATFORM_OWNER_EMAILS/);
  });

  test("queue reads newest-first", () => {
    expect(routeSrc).toMatch(/order\(\s*"created_at"/);
  });

  test("admin UI is RTL with the empty-owner message and never alerts", () => {
    expect(pageSrc).toMatch(/dir="rtl"/);
    expect(pageSrc).toMatch(/القائمة مقيدة — لم يتم تعيين مالك المنصة بعد/);
    expect(pageSrc).not.toMatch(/alert\(/);
  });
});
