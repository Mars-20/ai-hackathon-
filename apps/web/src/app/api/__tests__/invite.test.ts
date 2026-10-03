import { describe, test, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";

// ── Task 8 (TDD RED): full invite lifecycle + hashed tokens + expiry ─────────
// Covers: duplicate guard, expired re-invite, role hierarchy, list isolation
// (no token leak), accept/decline/resend/revoke with gates, expiry enforced.
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(),
}));

import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  GET as inviteGET,
  POST as invitePOST,
  PATCH as invitePATCH,
  DELETE as inviteDELETE,
} from "@/app/api/workspace/invite/route";

const mockedClient = vi.mocked(createServerSupabaseClient);

interface FakeUser {
  id: string;
  email: string;
}
interface FakeMembership {
  workspace_id: string;
  user_id: string;
  role: string;
}
interface FakeInvite {
  id: string;
  workspace_id: string;
  email: string;
  role: string;
  token: string;
  token_hash?: string;
  status: string;
  expires_at: string;
  invited_by: string;
  created_at: string;
}
interface FakeState {
  user: FakeUser | null;
  memberships: FakeMembership[];
  invites: FakeInvite[];
}

const WS = "11111111-1111-4111-8111-111111111111";
const ADMIN: FakeUser = { id: "admin-1", email: "admin@example.com" };
const MEMBER: FakeUser = { id: "member-1", email: "member@example.com" };
const NEWBIE: FakeUser = { id: "newbie-1", email: "newbie@example.com" };

const future = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const past = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

function seedInvite(over: Partial<FakeInvite> = {}): FakeInvite {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    workspace_id: WS,
    email: NEWBIE.email,
    role: "member",
    token: "raw-token-uuid",
    token_hash: createHash("sha256").update("raw-token-uuid").digest("hex"),
    status: "pending",
    expires_at: future(),
    invited_by: ADMIN.id,
    created_at: new Date().toISOString(),
    ...over,
  };
}

// In-memory PostgREST fake: supports the exact chains the route uses
// (select/eq/order/limit + maybeSingle/single/insert/update/delete + await).
function makeClient(state: FakeState) {
  const rowsOf = (table: string, filters: Array<{ col: string; val: unknown }>) => {
    const rows: Record<string, unknown>[] =
      table === "workspace_members"
        ? (state.memberships as unknown as Record<string, unknown>[])
        : (state.invites as unknown as Record<string, unknown>[]);
    return rows.filter((r) => filters.every((f) => r[f.col] === f.val));
  };
  const from = (table: string) => {
    const filters: Array<{ col: string; val: unknown }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = {
      select: () => q,
      order: () => q,
      limit: () => q,
      eq: (col: string, val: unknown) => {
        filters.push({ col, val });
        return q;
      },
      maybeSingle: async () => ({ data: rowsOf(table, filters)[0] ?? null, error: null }),
      single: async () => {
        const row = rowsOf(table, filters)[0];
        return row ? { data: row, error: null } : { data: null, error: { message: "none" } };
      },
      insert: async (vals: Record<string, unknown>) => {
        if (table === "workspace_members") state.memberships.push(vals as unknown as FakeMembership);
        else state.invites.push(vals as unknown as FakeInvite);
        return { data: null, error: null };
      },
      update: (vals: Record<string, unknown>) => ({
        eq: async (col: string, val: unknown) => {
          for (const r of rowsOf(table, [...filters, { col, val }])) Object.assign(r, vals);
          return { data: null, error: null };
        },
      }),
      delete: () => ({
        eq: async (col: string, val: unknown) => {
          const keep = (state.invites as unknown as Record<string, unknown>[]).filter(
            (r) => !(filters.every((f) => r[f.col] === f.val) && r[col] === val),
          );
          state.invites.length = 0;
          state.invites.push(...(keep as unknown as FakeInvite[]));
          return { data: null, error: null };
        },
      }),
      // Thenable so `await q` resolves like a PostgREST filter builder.
      then: (resolve: (v: unknown) => void) =>
        resolve({ data: rowsOf(table, filters), error: null }),
    };
    return q;
  };
  return {
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from,
  } as unknown as Awaited<ReturnType<typeof createServerSupabaseClient>>;
}

function setup(state: FakeState) {
  mockedClient.mockResolvedValue(makeClient(state));
}

function postReq(body: unknown) {
  return new NextRequest("http://x/api/workspace/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function patchReq(body: unknown) {
  return new NextRequest("http://x/api/workspace/invite", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("invite POST (Task 8)", () => {
  test("RED: duplicate pending invite → 409", async () => {
    const state: FakeState = {
      user: ADMIN,
      memberships: [{ workspace_id: WS, user_id: ADMIN.id, role: "admin" }],
      invites: [seedInvite()],
    };
    setup(state);
    const res = await invitePOST(postReq({ workspace_id: WS, email: NEWBIE.email, role: "member" }));
    expect(res.status).toBe(409);
  });

  test("RED: expired invite does NOT block a fresh re-invite", async () => {
    const state: FakeState = {
      user: ADMIN,
      memberships: [{ workspace_id: WS, user_id: ADMIN.id, role: "admin" }],
      invites: [seedInvite({ status: "expired", expires_at: past() })],
    };
    setup(state);
    const res = await invitePOST(postReq({ workspace_id: WS, email: NEWBIE.email, role: "member" }));
    expect(res.status).toBe(200);
    expect(state.invites).toHaveLength(2);
    expect(state.invites.filter((i) => i.status === "pending")).toHaveLength(1);
  });

  test("RED: role higher than caller → 403", async () => {
    const state: FakeState = {
      user: ADMIN,
      memberships: [{ workspace_id: WS, user_id: ADMIN.id, role: "admin" }],
      invites: [],
    };
    setup(state);
    const res = await invitePOST(postReq({ workspace_id: WS, email: "x@example.com", role: "owner" }));
    expect(res.status).toBe(403);
  });

  test("RED: invalid role → 400", async () => {
    const state: FakeState = {
      user: ADMIN,
      memberships: [{ workspace_id: WS, user_id: ADMIN.id, role: "admin" }],
      invites: [],
    };
    setup(state);
    const res = await invitePOST(
      postReq({ workspace_id: WS, email: "x@example.com", role: "superadmin" }),
    );
    expect(res.status).toBe(400);
  });

  test("RED: stores sha256 token_hash and never returns the token", async () => {
    const state: FakeState = {
      user: ADMIN,
      memberships: [{ workspace_id: WS, user_id: ADMIN.id, role: "admin" }],
      invites: [],
    };
    setup(state);
    const res = await invitePOST(postReq({ workspace_id: WS, email: NEWBIE.email, role: "member" }));
    expect(res.status).toBe(200);
    const stored = state.invites[0];
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.token_hash).toBe(createHash("sha256").update(stored.token).digest("hex"));
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain(stored.token);
    expect(body).not.toContain("token_hash");
  });
});

describe("invite GET list (Task 8)", () => {
  test("RED: member lists invites without token material", async () => {
    const state: FakeState = {
      user: MEMBER,
      memberships: [{ workspace_id: WS, user_id: MEMBER.id, role: "member" }],
      invites: [seedInvite(), seedInvite({ id: "33333333-3333-4333-8333-333333333333" })],
    };
    setup(state);
    const res = await inviteGET(new NextRequest(`http://x/api/workspace/invite?workspace_id=${WS}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invites: Record<string, unknown>[] };
    expect(body.invites).toHaveLength(2);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("raw-token-uuid");
    expect(raw).not.toContain("token_hash");
    expect(raw).not.toContain("token");
  });

  test("RED: non-member → 403, missing workspace_id → 400", async () => {
    setup({ user: MEMBER, memberships: [], invites: [] });
    const forbidden = await inviteGET(
      new NextRequest(`http://x/api/workspace/invite?workspace_id=${WS}`),
    );
    expect(forbidden.status).toBe(403);
    const bad = await inviteGET(new NextRequest("http://x/api/workspace/invite"));
    expect(bad.status).toBe(400);
  });
});

describe("invite PATCH accept/decline/resend/revoke (Task 8)", () => {
  test("RED: invitee accepts a valid invite → membership added", async () => {
    const invite = seedInvite();
    const state: FakeState = {
      user: NEWBIE,
      memberships: [],
      invites: [invite],
    };
    setup(state);
    const res = await invitePATCH(patchReq({ invite_id: invite.id, action: "accept" }));
    expect(res.status).toBe(200);
    expect(state.invites[0].status).toBe("accepted");
    expect(state.memberships).toContainEqual({
      workspace_id: WS,
      user_id: NEWBIE.id,
      role: "member",
    });
  });

  test("RED: stranger (email mismatch, no admin role) cannot accept → 403", async () => {
    const invite = seedInvite();
    const state: FakeState = {
      user: { id: "evil-1", email: "evil@example.com" },
      memberships: [],
      invites: [invite],
    };
    setup(state);
    const res = await invitePATCH(patchReq({ invite_id: invite.id, action: "accept" }));
    expect(res.status).toBe(403);
    expect(state.invites[0].status).toBe("pending");
  });

  test("RED: accepting an expired invite → 410 and marked expired", async () => {
    const invite = seedInvite({ expires_at: past() });
    const state: FakeState = {
      user: NEWBIE,
      memberships: [],
      invites: [invite],
    };
    setup(state);
    const res = await invitePATCH(patchReq({ invite_id: invite.id, action: "accept" }));
    expect(res.status).toBe(410);
    expect(state.invites[0].status).toBe("expired");
    expect(state.memberships).toHaveLength(0);
  });

  test("RED: invitee declines → declined, no membership", async () => {
    const invite = seedInvite();
    const state: FakeState = {
      user: NEWBIE,
      memberships: [],
      invites: [invite],
    };
    setup(state);
    const res = await invitePATCH(patchReq({ invite_id: invite.id, action: "decline" }));
    expect(res.status).toBe(200);
    expect(state.invites[0].status).toBe("declined");
    expect(state.memberships).toHaveLength(0);
  });

  test("RED: admin resends pending invite → expiry refreshed, token rotated", async () => {
    const invite = seedInvite();
    const state: FakeState = {
      user: ADMIN,
      memberships: [{ workspace_id: WS, user_id: ADMIN.id, role: "admin" }],
      invites: [invite],
    };
    setup(state);
    const before = invite.expires_at;
    const res = await invitePATCH(patchReq({ invite_id: invite.id, action: "resend" }));
    expect(res.status).toBe(200);
    expect(state.invites[0].status).toBe("pending");
    expect(new Date(state.invites[0].expires_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    );
    expect(state.invites[0].token).not.toBe("raw-token-uuid");
  });

  test("RED: resend of a decided invite → 400; resend by viewer → 403", async () => {
    const decided: FakeState = {
      user: ADMIN,
      memberships: [{ workspace_id: WS, user_id: ADMIN.id, role: "admin" }],
      invites: [seedInvite({ status: "accepted" })],
    };
    setup(decided);
    const res = await invitePATCH(
      patchReq({ invite_id: decided.invites[0].id, action: "resend" }),
    );
    expect(res.status).toBe(400);
    const viewerState: FakeState = {
      user: MEMBER,
      memberships: [{ workspace_id: WS, user_id: MEMBER.id, role: "viewer" }],
      invites: [seedInvite()],
    };
    setup(viewerState);
    const forbidden = await invitePATCH(
      patchReq({ invite_id: viewerState.invites[0].id, action: "resend" }),
    );
    expect(forbidden.status).toBe(403);
  });

  test("RED: admin revokes pending invite → revoked", async () => {
    const invite = seedInvite();
    const state: FakeState = {
      user: ADMIN,
      memberships: [{ workspace_id: WS, user_id: ADMIN.id, role: "admin" }],
      invites: [invite],
    };
    setup(state);
    const res = await invitePATCH(patchReq({ invite_id: invite.id, action: "revoke" }));
    expect(res.status).toBe(200);
    expect(state.invites[0].status).toBe("revoked");
  });
});

describe("invite DELETE revoke (Task 8)", () => {
  test("RED: admin DELETE revokes; member DELETE → 403", async () => {
    const invite = seedInvite();
    const adminState: FakeState = {
      user: ADMIN,
      memberships: [{ workspace_id: WS, user_id: ADMIN.id, role: "admin" }],
      invites: [invite],
    };
    setup(adminState);
    const res = await inviteDELETE(
      new NextRequest(`http://x/api/workspace/invite?invite_id=${invite.id}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(200);
    expect(adminState.invites[0].status).toBe("revoked");
    const memberState: FakeState = {
      user: MEMBER,
      memberships: [{ workspace_id: WS, user_id: MEMBER.id, role: "member" }],
      invites: [seedInvite()],
    };
    setup(memberState);
    const forbidden = await inviteDELETE(
      new NextRequest(
        `http://x/api/workspace/invite?invite_id=${memberState.invites[0].id}`,
        { method: "DELETE" },
      ),
    );
    expect(forbidden.status).toBe(403);
  });
});
