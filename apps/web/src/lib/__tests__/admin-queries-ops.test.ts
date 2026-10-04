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

vi.mock("@/lib/admin-queries/ops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-queries/ops")>();
  return {
    ...actual,
    queryOpsLimits: vi.fn(actual.queryOpsLimits),
    queryOpsAudit: vi.fn(actual.queryOpsAudit),
    queryAgentSettings: vi.fn(actual.queryAgentSettings),
    queryOpsEmail: vi.fn(actual.queryOpsEmail),
    queryOpsAdmins: vi.fn(actual.queryOpsAdmins),
  };
});

import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";
import { requireAdminFromSupabase } from "@/lib/admin";
import type { RequireAdminResult } from "@/lib/admin";
import {
  queryOpsLimits,
  queryOpsAudit,
  queryAgentSettings,
  queryOpsEmail,
  queryOpsAdmins,
} from "@/lib/admin-queries/ops";
import type { AdminQueryDeps } from "@/lib/admin-queries/shared";
import { GET as limitsGET } from "@/app/api/admin/ops/limits/route";
import { GET as auditGET } from "@/app/api/admin/ops/audit/route";
import { GET as agentGET } from "@/app/api/admin/agent/route";
import {
  GET as emailGET,
  POST as emailPOST,
} from "@/app/api/admin/ops/email/route";
import {
  GET as adminsGET,
  POST as adminsPOST,
  DELETE as adminsDELETE,
} from "@/app/api/admin/ops/admins/route";
import { runAdminQuery } from "@/lib/admin-dal";
import { BUDGET } from "@/lib/utils";

const mockedClient = vi.mocked(createServerSupabaseClient);
const mockedServiceClient = vi.mocked(createServiceRoleClient);
const mockedGate = vi.mocked(requireAdminFromSupabase);
const limitsSpy = vi.mocked(queryOpsLimits);
const auditSpy = vi.mocked(queryOpsAudit);
const agentSpy = vi.mocked(queryAgentSettings);
const emailSpy = vi.mocked(queryOpsEmail);
const adminsSpy = vi.mocked(queryOpsAdmins);

interface FakeOpsState {
  traces: Record<string, unknown>[];
  audit: Record<string, unknown>[];
  settings: Record<string, unknown>[];
  invites: Record<string, unknown>[];
  platformAdmins: Record<string, unknown>[];
  profiles: Record<string, unknown>[];
  members: Record<string, unknown>[];
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

const WS_MEMBER: RequireAdminResult = {
  user: { id: "admin-1" },
  tier: "workspace",
  workspaceIds: ["w1"],
};

// In-memory PostgREST fake: select/eq/in/gte/lte/not/order/limit/range +
// head-count + root rpc (audit trail) + await with { data, error, count }.
function makeOpsClient(state: FakeOpsState, rpcSpy?: (action: string) => void) {
  const tables: Record<string, Record<string, unknown>[]> = {
    trace_events: state.traces,
    audit_log: state.audit,
    admin_settings: state.settings,
    workspace_invites: state.invites,
    platform_admins: state.platformAdmins,
    profiles: state.profiles,
    workspace_members: state.members,
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
  return {
    from,
    rpc: async (action: string) => {
      rpcSpy?.(action);
      return { data: { ok: false, error: "forbidden" }, error: null };
    },
  };
}

function setup(state: FakeOpsState, rpcSpy?: (action: string) => void) {
  mockedClient.mockResolvedValue(
    makeOpsClient(state, rpcSpy) as unknown as Awaited<
      ReturnType<typeof createServerSupabaseClient>
    >,
  );
  mockedServiceClient.mockReturnValue(
    makeOpsClient(state, rpcSpy) as unknown as ReturnType<
      typeof createServiceRoleClient
    >,
  );
}

function depsFor(
  state: FakeOpsState,
  admin: unknown,
  rpcSpy?: (action: string) => void,
): AdminQueryDeps {
  const client = makeOpsClient(state, rpcSpy);
  return {
    admin: admin as AdminQueryDeps["admin"],
    userClient: client as unknown as AdminQueryDeps["userClient"],
    service: client as unknown as AdminQueryDeps["service"],
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const isoAgo = (days: number) =>
  new Date(Date.now() - days * DAY_MS).toISOString();

function seedState(): FakeOpsState {
  return {
    traces: [
      {
        actor: "a1",
        event_type: "error",
        payload: { msg: "boom 429 rate limited" },
        workspace_id: "w1",
        created_at: isoAgo(1),
      },
      {
        actor: "a2",
        event_type: "verification",
        payload: { warning: "low confidence" },
        workspace_id: "w1",
        created_at: isoAgo(2),
      },
      {
        actor: "a2",
        event_type: "verification",
        payload: { unsupported_count: 2 },
        workspace_id: "w1",
        created_at: isoAgo(2),
      },
      {
        actor: "a3",
        event_type: "run",
        payload: null,
        workspace_id: "w9",
        created_at: isoAgo(1),
      },
      {
        actor: "x",
        event_type: "error",
        payload: null,
        workspace_id: null,
        created_at: isoAgo(1),
      },
      {
        actor: "old",
        event_type: "error",
        payload: null,
        workspace_id: "w1",
        created_at: isoAgo(30),
      },
    ],
    audit: [
      {
        id: "e1",
        actor: "a1",
        action: "suspend_user",
        target: null,
        reason: "spam",
        diff: null,
        workspace_id: "w1",
        result: "ok",
        created_at: isoAgo(3),
      },
      {
        id: "e2",
        actor: "a2",
        action: "flag_startup",
        target: { startup_id: "s1" },
        reason: null,
        diff: null,
        workspace_id: "w1",
        result: "ok",
        created_at: isoAgo(2),
      },
      {
        id: "e3",
        actor: "a1",
        action: "flag_startup",
        target: null,
        reason: null,
        diff: null,
        workspace_id: "w9",
        result: "denied",
        created_at: isoAgo(1),
      },
      {
        id: "e4",
        actor: "a3",
        action: "email_resend",
        target: null,
        reason: null,
        diff: null,
        workspace_id: null,
        result: "ok",
        created_at: isoAgo(0.5),
      },
    ],
    settings: [
      { key: "b-knob", value: 2, updated_at: isoAgo(1) },
      {
        key: "a-knob",
        value: "x",
        updated_at: isoAgo(1),
        secret: "must-never-leak",
      },
    ],
    invites: [
      {
        id: "i1",
        workspace_id: "w1",
        email: "n1@x.com",
        role: "member",
        status: "pending",
        expires_at: null,
        invited_by: "admin-1",
        created_at: isoAgo(1),
        token: "credential-equivalent",
      },
      {
        id: "i2",
        workspace_id: "w9",
        email: "n2@x.com",
        role: "member",
        status: "accepted",
        expires_at: null,
        invited_by: "admin-1",
        created_at: isoAgo(1),
        token: "credential-equivalent",
      },
    ],
    platformAdmins: [
      {
        user_id: "pa2",
        granted_by: "root",
        granted_at: isoAgo(5),
      },
      {
        user_id: "pa1",
        granted_by: "root",
        granted_at: isoAgo(6),
      },
    ],
    profiles: [{ user_id: "pa1", email: "pa1@x.com" }],
    members: [
      { user_id: "admin-1", workspace_id: "w1", role: "owner" },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("queryOpsLimits helper", () => {
  test("severity shape matches the route JSON; NULL rows and old rows excluded", async () => {
    const state = seedState();
    const res = await queryOpsLimits(depsFor(state, PLATFORM_ADMIN), "7d");
    expect(res.window.preset).toBe("7d");
    expect(res.severity).toEqual({ error: 1, warning: 2, info: 1 });
    expect(res.errorsByActor).toEqual({ a1: 1 });
    expect(res.rateLimited429).toBe(1);
    expect(res.configured.maxCostUsd).toBe(BUDGET.MAX_COST_USD);
    expect(res.truncated).toBe(false);
  });

  test("incidental 429 substrings do not count as rate limits", async () => {
    const state = seedState();
    state.traces.push({
      actor: "a1",
      event_type: "error",
      payload: { msg: "order 14290 confirmed" },
      workspace_id: "w1",
      created_at: isoAgo(1),
    });
    state.traces.push({
      actor: "a1",
      event_type: "error",
      payload: { rate_limited: true, key: "k", route: "/api/agent" },
      workspace_id: "w1",
      created_at: isoAgo(1),
    });
    const res = await queryOpsLimits(depsFor(state, PLATFORM_ADMIN), "7d");
    // Genuine "boom 429 rate limited" + structured rate_limited: true = 2.
    // The digit-glued "14290" must not count.
    expect(res.rateLimited429).toBe(2);
  });

  test("workspace tier sees only its own traces", async () => {
    const state = seedState();
    const res = await queryOpsLimits(depsFor(state, WS_OWNER), "7d");
    expect(res.severity).toEqual({ error: 1, warning: 2, info: 0 });
    expect(JSON.stringify(res)).not.toContain("a3");
  });

  test("invalid window throws the 400 envelope payload", async () => {
    const state = seedState();
    await expect(
      queryOpsLimits(depsFor(state, PLATFORM_ADMIN), "13d"),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("queryOpsAudit helper", () => {
  test("platform paginates newest-first with actor/action filters", async () => {
    const state = seedState();
    const page1 = await queryOpsAudit(depsFor(state, PLATFORM_ADMIN), {
      page: 1,
      limit: 2,
      actor: null,
      action: null,
    });
    expect(page1.entries.map((e) => e.id)).toEqual(["e4", "e3"]);
    expect(page1.total).toBe(4);
    expect(page1.pages).toBe(2);

    const byActor = await queryOpsAudit(depsFor(state, PLATFORM_ADMIN), {
      page: 1,
      limit: 20,
      actor: "a1",
      action: null,
    });
    expect(byActor.entries.map((e) => e.id).sort()).toEqual(["e1", "e3"]);

    const byAction = await queryOpsAudit(depsFor(state, PLATFORM_ADMIN), {
      page: 1,
      limit: 20,
      actor: null,
      action: "flag_startup",
    });
    expect(byAction.entries.map((e) => e.id).sort()).toEqual(["e2", "e3"]);
  });

  test("workspace member (rank < admin) gets 403; owner reads scoped rows", async () => {
    const state = seedState();
    state.members = [
      { user_id: "admin-1", workspace_id: "w1", role: "member" },
    ];
    await expect(
      queryOpsAudit(depsFor(state, WS_MEMBER), {
        page: 1,
        limit: 20,
        actor: null,
        action: null,
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "Audit log requires an admin role or higher",
    });

    // Restore the owner membership: the member case above overwrote the
    // seeded owner row, and the guard reads live ranks (same as the route).
    state.members = [
      { user_id: "admin-1", workspace_id: "w1", role: "owner" },
    ];
    const ownerRes = await queryOpsAudit(depsFor(state, WS_OWNER), {
      page: 1,
      limit: 20,
      actor: null,
      action: null,
    });
    expect(ownerRes.entries.map((e) => e.id).sort()).toEqual(["e1", "e2"]);
    expect(ownerRes.total).toBe(2);
  });
});

describe("queryAgentSettings helper", () => {
  test("DTO exposes key/value/updated_at only — no secret fields", async () => {
    const state = seedState();
    const res = await queryAgentSettings(depsFor(state, PLATFORM_ADMIN));
    expect(Object.keys(res.settings)).toEqual(["a-knob", "b-knob"]);
    expect(res.settings["a-knob"]).toEqual({
      value: "x",
      updated_at: expect.any(String),
    });
    expect(JSON.stringify(res)).not.toContain("must-never-leak");
    expect(JSON.stringify(res)).not.toContain("secret");
    expect(res.meta.source).toBe("admin_settings");
    expect(res.meta.readOnly).toBe(true);
    expect(res.truncated).toBe(false);
  });
});

describe("queryOpsEmail helper", () => {
  test("pending-only queue scoped per tier; tokens never selected", async () => {
    const state = seedState();
    const platform = await queryOpsEmail(depsFor(state, PLATFORM_ADMIN));
    expect(platform.pending.map((p) => p.id)).toEqual(["i1"]);
    expect(platform.total).toBe(1);
    expect(JSON.stringify(platform)).not.toContain("credential-equivalent");

    const scoped = await queryOpsEmail(depsFor(state, WS_OWNER));
    expect(scoped.pending.map((p) => p.id)).toEqual(["i1"]);
  });
});

describe("queryOpsAdmins helper", () => {
  test("platform list joins emails; workspace tier throws 403 after the trail RPC", async () => {
    const state = seedState();
    const res = await queryOpsAdmins(depsFor(state, PLATFORM_ADMIN));
    expect(res.admins).toEqual([
      {
        user_id: "pa1",
        email: "pa1@x.com",
        granted_by: "root",
        granted_at: expect.any(String),
      },
      {
        user_id: "pa2",
        email: "",
        granted_by: "root",
        granted_at: expect.any(String),
      },
    ]);
    expect(res.total).toBe(2);

    const rpcActions: string[] = [];
    await expect(
      queryOpsAdmins(depsFor(state, WS_OWNER, (a) => rpcActions.push(a))),
    ).rejects.toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      message: "Platform admins are platform-managed",
    });
    expect(rpcActions).toEqual(["admin_action"]);
  });
});

describe("ops route delegation", () => {
  test("all five GETs delegate with raw params; mutations stay inline", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });

    const limits = await limitsGET(
      new NextRequest("http://x/api/admin/ops/limits?window=7d"),
    );
    expect(limits.status).toBe(200);
    expect(limitsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ admin: PLATFORM_ADMIN }),
      "7d",
    );
    expect((await limits.json()).severity).toEqual({
      error: 1,
      warning: 2,
      info: 1,
    });

    const audit = await auditGET(
      new NextRequest(
        "http://x/api/admin/ops/audit?page=1&limit=20&actor=a1&action=flag_startup",
      ),
    );
    expect(audit.status).toBe(200);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ admin: PLATFORM_ADMIN }),
      { page: "1", limit: "20", actor: "a1", action: "flag_startup" },
    );
    expect((await audit.json()).total).toBe(1);

    const agent = await agentGET();
    expect(agent.status).toBe(200);
    expect(agentSpy).toHaveBeenCalledTimes(1);
    expect(Object.keys((await agent.json()).settings)).toEqual([
      "a-knob",
      "b-knob",
    ]);

    const email = await emailGET();
    expect(email.status).toBe(200);
    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect((await email.json()).total).toBe(1);

    const admins = await adminsGET();
    expect(admins.status).toBe(200);
    expect(adminsSpy).toHaveBeenCalledTimes(1);
    expect((await admins.json()).total).toBe(2);

    expect(typeof emailPOST).toBe("function");
    expect(typeof adminsPOST).toBe("function");
    expect(typeof adminsDELETE).toBe("function");
  });

  test("admins route maps workspace tier to the exact 403 envelope", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...WS_OWNER });
    const res = await adminsGET();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Platform admins are platform-managed",
      code: "FORBIDDEN",
    });
  });
});

describe("ops DAL parity", () => {
  test("runAdminQuery returns the same limits DTO the route returns", async () => {
    const state = seedState();
    setup(state);
    mockedGate.mockResolvedValue({ ...PLATFORM_ADMIN });
    const dalRes = await runAdminQuery((deps) =>
      queryOpsLimits(deps, "7d"),
    );
    const routeRes = await limitsGET(
      new NextRequest("http://x/api/admin/ops/limits?window=7d"),
    );
    const routeBody = await routeRes.json();
    expect(dalRes.ok).toBe(true);
    if (dalRes.ok) {
      // Volatile fields (clock reads per call) are stripped on both sides:
      // parity means identical structure + identical data, not identical
      // timestamps.
      const dalMeta: Record<string, unknown> = { ...dalRes.data.meta };
      delete dalMeta["fetched_at"];
      const routeMeta: Record<string, unknown> = { ...routeBody.meta };
      delete routeMeta["fetched_at"];
      const dalWindow: Record<string, unknown> = { ...dalRes.data.window };
      delete dalWindow["from"];
      delete dalWindow["to"];
      const routeWindow: Record<string, unknown> = { ...routeBody.window };
      delete routeWindow["from"];
      delete routeWindow["to"];
      expect({ ...dalRes.data, meta: dalMeta, window: dalWindow }).toEqual({
        ...routeBody,
        meta: routeMeta,
        window: routeWindow,
      });
      expect(dalRes.data.window.preset).toBe(routeBody.window.preset);
    }
  });
});
