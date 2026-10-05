import { describe, test, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Task 6 (TDD RED): subscription requests API + entitlement readout ──────
// Covers: zod schema cases (valid passes; plan gold fails; 1-char name fails;
// 5-char phone fails; 1001-char notes fail) + handler tests with mocked
// supabase (mock style per invite.test.ts / search-history.test.ts):
// 401 anon; 400 zod; 429 rate-limit; 409 on 23505 (verbatim Arabic error);
// 201 happy path with alert insert attempted; GET me shape incl. frozen ids.
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, checkRateLimit: vi.fn() };
});

import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { subscriptionRequestSchema, fpSignalsSchema } from "@/lib/validation";
import { POST as subreqPOST, GET as subreqGET } from "@/app/api/subscription-requests/route";
import { GET as entitlementsGET } from "@/app/api/entitlements/me/route";

const mockedClient = vi.mocked(createServerSupabaseClient);
const mockedServiceClient = vi.mocked(createServiceRoleClient);
const mockedRateLimit = vi.mocked(checkRateLimit);

const USER_ID = "user-1111";

interface QueryResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

// Chainable PostgREST fake: select/eq/order return the builder; single/
// maybeSingle resolve the canned per-table payload; `await q` resolves it too.
// insert() returns a builder whose single()/await resolve the insert payload.
function mockClients(opts: {
  user: { id: string } | null;
  tables?: Record<string, QueryResult>;
  inserts?: Record<string, QueryResult>;
  serviceInserts?: Record<string, QueryResult>;
  serviceCalls?: Array<{ table: string; row: unknown }>;
}) {
  const { user, tables = {}, inserts = {}, serviceInserts = {}, serviceCalls = [] } = opts;

  const makeBuilder = (table: string, isService: boolean) => {
    const payload: QueryResult = isService
      ? (serviceInserts[table] ?? tables[table] ?? { data: null, error: null })
      : (tables[table] ?? { data: [], error: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = {
      select: () => q,
      eq: () => q,
      order: () => q,
      single: async () => payload,
      maybeSingle: async () => payload,
      insert: (row: unknown) => {
        if (isService) serviceCalls.push({ table, row });
        const insPayload: QueryResult = isService
          ? (serviceInserts[table] ?? { data: null, error: null })
          : (inserts[table] ?? { data: null, error: null });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const iq: any = {
          select: () => iq,
          single: async () => insPayload,
          maybeSingle: async () => insPayload,
          then: (resolve: (v: unknown) => void) => resolve(insPayload),
        };
        return iq;
      },
      then: (resolve: (v: unknown) => void) => resolve(payload),
    };
    return q;
  };

  mockedClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user } }) },
    from: (table: string) => makeBuilder(table, false),
  } as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>);
  mockedServiceClient.mockReturnValue({
    auth: { getUser: async () => ({ data: { user } }) },
    from: (table: string) => makeBuilder(table, true),
  } as unknown as ReturnType<typeof createServiceRoleClient>);
}

function postReq(body: unknown) {
  return new NextRequest("http://x/api/subscription-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  plan: "pro",
  full_name: "Sara Ahmed",
  phone: "+966500000000",
  company: "Acme",
  notes: "Please approve",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedRateLimit.mockResolvedValue({ limited: false, retryAfter: 0 });
});

describe("subscriptionRequestSchema (Task 6)", () => {
  test("valid body passes", () => {
    expect(subscriptionRequestSchema.safeParse(VALID_BODY).success).toBe(true);
  });

  test("plan gold fails", () => {
    expect(
      subscriptionRequestSchema.safeParse({ ...VALID_BODY, plan: "gold" }).success,
    ).toBe(false);
  });

  test("1-char name fails", () => {
    expect(
      subscriptionRequestSchema.safeParse({ ...VALID_BODY, full_name: "A" }).success,
    ).toBe(false);
  });

  test("5-char phone fails", () => {
    expect(
      subscriptionRequestSchema.safeParse({ ...VALID_BODY, phone: "12345" }).success,
    ).toBe(false);
  });

  test("1001-char notes fail", () => {
    expect(
      subscriptionRequestSchema.safeParse({ ...VALID_BODY, notes: "n".repeat(1001) }).success,
    ).toBe(false);
  });

  test("fpSignalsSchema defaults to empty strings", () => {
    const parsed = fpSignalsSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({ ua: "", screen: "", tz: "", lang: "" });
    }
  });
});

describe("POST /api/subscription-requests (Task 6)", () => {
  test("401 anon", async () => {
    mockClients({ user: null });
    const res = await subreqPOST(postReq(VALID_BODY));
    expect(res.status).toBe(401);
  });

  test("400 on zod violation", async () => {
    mockClients({ user: { id: USER_ID } });
    const res = await subreqPOST(postReq({ ...VALID_BODY, plan: "gold" }));
    expect(res.status).toBe(400);
  });

  test("429 when rate-limited (key subreq:<userId>, 5/hour)", async () => {
    mockClients({ user: { id: USER_ID } });
    mockedRateLimit.mockResolvedValue({ limited: true, retryAfter: 42 });
    const res = await subreqPOST(postReq(VALID_BODY));
    expect(res.status).toBe(429);
    expect(mockedRateLimit).toHaveBeenCalledWith({
      key: `subreq:${USER_ID}`,
      limit: 5,
      windowMs: 60 * 60 * 1000,
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["retryAfter"]).toBe(42);
  });

  test("409 on unique violation 23505 (verbatim Arabic error)", async () => {
    mockClients({
      user: { id: USER_ID },
      inserts: {
        subscription_requests: { data: null, error: { message: "duplicate", code: "23505" } },
      },
    });
    const res = await subreqPOST(postReq(VALID_BODY));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "لديك طلب قيد المراجعة",
      code: "DUPLICATE_PENDING",
    });
  });

  test("201 happy path with owner_alert attempted", async () => {
    const serviceCalls: Array<{ table: string; row: unknown }> = [];
    mockClients({
      user: { id: USER_ID },
      inserts: {
        subscription_requests: {
          data: { id: "req-1", plan: "pro", status: "pending" },
          error: null,
        },
      },
      serviceCalls,
    });
    const res = await subreqPOST(postReq(VALID_BODY));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      request: { id: "req-1", plan: "pro", status: "pending" },
    });
    expect(serviceCalls).toHaveLength(1);
    expect(serviceCalls[0].table).toBe("owner_alerts");
    expect(serviceCalls[0].row).toEqual({
      kind: "subscription_request",
      ref_id: "req-1",
    });
  });

  test("201 even when the owner_alert insert fails (warn, still 201)", async () => {
    mockClients({
      user: { id: USER_ID },
      inserts: {
        subscription_requests: {
          data: { id: "req-2", plan: "team", status: "pending" },
          error: null,
        },
      },
      serviceInserts: {
        owner_alerts: { data: null, error: { message: "boom" } },
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await subreqPOST(postReq(VALID_BODY));
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        request: { id: "req-2", plan: "team", status: "pending" },
      });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("GET /api/subscription-requests (Task 6)", () => {
  test("401 anon", async () => {
    mockClients({ user: null });
    const res = await subreqGET(new NextRequest("http://x/api/subscription-requests"));
    expect(res.status).toBe(401);
  });

  test("200 returns own rows", async () => {
    mockClients({
      user: { id: USER_ID },
      tables: {
        subscription_requests: {
          data: [{ id: "req-1", plan: "pro", status: "pending" }],
          error: null,
        },
      },
    });
    const res = await subreqGET(new NextRequest("http://x/api/subscription-requests"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requests: unknown[] };
    expect(body.requests).toHaveLength(1);
  });
});

describe("GET /api/entitlements/me (Task 6)", () => {
  test("401 anon", async () => {
    mockClients({ user: null });
    const res = await entitlementsGET(new NextRequest("http://x/api/entitlements/me"));
    expect(res.status).toBe(401);
  });

  test("200 shape incl. frozen ids", async () => {
    mockClients({
      user: { id: USER_ID },
      tables: {
        user_entitlements: {
          data: { status: "trial_consumed", plan: "free", trial_startup_id: "s-trial" },
          error: null,
        },
        startups: {
          data: [{ id: "s-frozen-1" }, { id: "s-frozen-2" }],
          error: null,
        },
      },
    });
    const res = await entitlementsGET(new NextRequest("http://x/api/entitlements/me"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "trial_consumed",
      plan: "free",
      trial_startup_id: "s-trial",
      frozen_startup_ids: ["s-frozen-1", "s-frozen-2"],
    });
  });

  test("missing entitlement → legacy defensive default", async () => {
    mockClients({
      user: { id: USER_ID },
      tables: {
        user_entitlements: { data: null, error: null },
        startups: { data: [], error: null },
      },
    });
    const res = await entitlementsGET(new NextRequest("http://x/api/entitlements/me"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "legacy",
      plan: "free",
      trial_startup_id: null,
      frozen_startup_ids: [],
    });
  });
});
