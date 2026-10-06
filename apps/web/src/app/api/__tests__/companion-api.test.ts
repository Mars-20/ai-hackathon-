import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));

import type { CompanionDeps } from "@/lib/companion/dal";
import {
  companionRateKey,
  handleCreateCompanionMemory,
  handleDecideCompanionMemory,
  handleDeleteCompanionMemory,
  handleGetCompanionProfile,
  handleListCompanionMemories,
  handleToggleCompanionProfile,
  type CompanionHttpContext,
} from "@/lib/companion/http";
import type { EntitlementStatus } from "@/lib/entitlements";
import type { MemoryRow } from "@/lib/companion/ranker";

const UID = "11111111-1111-4111-8111-111111111111";
const RID = (n: string): string => `00000000-0000-4000-8000-0000000000${n}`;
const A1 = RID("a1");
const A2 = RID("a2");

function row(over: Partial<MemoryRow> & { id: string; value: string }): MemoryRow {
  return {
    kind: "fact",
    status: "approved",
    confidence: 0.9,
    source_ref: "infer",
    created_at: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

const R1 = row({ id: RID("01"), value: "ميزانية المشروع 5000 ريال" });
const R2 = row({
  id: RID("02"),
  kind: "preference",
  value: "يفضل الشاي",
  status: "pending",
  confidence: 0.88,
  created_at: "2026-08-01T00:00:00.000Z",
});
const R3 = row({ id: RID("03"), value: "المقر في جدة", created_at: "2026-07-01T00:00:00.000Z" });

interface FakeState {
  entitlement: EntitlementStatus | null;
  authed: boolean;
  listRows: MemoryRow[];
  approvedValues: string[];
  deleteRows: Array<{ id: string }>;
  profile: { user_id: string; memory_enabled: boolean } | null;
  rpcImpl: (name: string, params: Record<string, unknown>) => unknown;
  calls: { rpc: string[]; orArgs: string[]; limits: number[]; redisDel: string[] };
}

// Chainable PostgREST-shaped fake: terminals limit()/maybeSingle()/await.
class FQ {
  private ors: string[] = [];
  private isDelete = false;
  private upsertRow: Record<string, unknown> | null = null;
  constructor(
    private state: FakeState,
    private table: string,
  ) {}
  select(): this {
    return this;
  }
  eq(): this {
    return this;
  }
  in(): this {
    return this;
  }
  order(): this {
    return this;
  }
  or(expr: string): this {
    this.ors.push(expr);
    this.state.calls.orArgs.push(expr);
    return this;
  }
  delete(): this {
    this.isDelete = true;
    return this;
  }
  upsert(r: Record<string, unknown>): this {
    this.upsertRow = r;
    return this;
  }
  limit(n: number): { data: unknown; error: null } {
    this.state.calls.limits.push(n);
    if (this.table === "companion_memory" && !this.isDelete) {
      const page = this.ors.length > 0 ? [R3] : [R1, R2, R3];
      return { data: page.slice(0, n), error: null };
    }
    return { data: [], error: null };
  }
  maybeSingle(): { data: unknown; error: null } {
    if (this.table === "companion_profile") {
      if (this.upsertRow) {
        const enabled = this.upsertRow.memory_enabled as boolean;
        this.state.profile = { user_id: UID, memory_enabled: enabled };
        return { data: this.state.profile, error: null };
      }
      return { data: this.state.profile, error: null };
    }
    return { data: null, error: null };
  }
  then(
    resolve: (v: { data: unknown; error: null }) => void,
    reject: (e: unknown) => void,
  ): void {
    try {
      if (this.isDelete) resolve({ data: this.state.deleteRows, error: null });
      else if (this.table === "companion_profile")
        resolve({ data: this.state.profile, error: null });
      else resolve({ data: this.state.approvedValues.map((value) => ({ value })), error: null });
    } catch (e) {
      reject(e);
    }
  }
}

function makeCtx(over?: Partial<FakeState>): {
  ctx: CompanionHttpContext;
  state: FakeState;
  rateProbe: ReturnType<typeof vi.fn>;
} {
  const state: FakeState = {
    entitlement: "trial_active",
    authed: true,
    listRows: [R1, R2, R3],
    approvedValues: [],
    deleteRows: [{ id: A1 }],
    profile: { user_id: UID, memory_enabled: true },
    rpcImpl: (name: string) => {
      if (name === "decide_memory")
        return {
          data: { ok: true, code: "OK", row: { ...R2, status: "approved" } },
          error: null,
        };
      return {
        data: { ok: true, code: "OK", results: [{ index: 0, ok: true, code: "OK", id: A2 }], dropped: [] },
        error: null,
      };
    },
    calls: { rpc: [], orArgs: [], limits: [], redisDel: [] },
    ...over,
  };
  const client = {
    from: (table: string) => new FQ(state, table),
    rpc: async (name: string, params: Record<string, unknown>) => {
      state.calls.rpc.push(name);
      return state.rpcImpl(name, params);
    },
  };
  const dalOver: CompanionDeps = {
    userClient: async () => client as unknown as SupabaseClient,
    getEntitlementStatus: async () => state.entitlement,
    redisGet: async () => null,
    redisSetex: async () => {},
    redisDel: async (key: string) => {
      state.calls.redisDel.push(key);
    },
    nowMs: () => Date.now(),
  };
  const rateProbe = vi.fn(async () => ({ limited: false, retryAfter: 0 }));
  const ctx: CompanionHttpContext = {
    getUser: async () => (state.authed ? { id: UID } : null),
    checkRate: rateProbe,
    dalOver,
  };
  return { ctx, state, rateProbe };
}

const enc = (c: unknown): string =>
  Buffer.from(JSON.stringify(c), "utf8").toString("base64url");

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/companion/memory", () => {
  it("pages with an opaque cursor across two requests", async () => {
    const { ctx, state } = makeCtx();
    const p1 = await handleListCompanionMemories(
      new Request("http://localhost/api/companion/memory?limit=2"),
      ctx,
    );
    expect(p1.status).toBe(200);
    const b1 = await body(p1);
    expect((b1.items as unknown[]).map((r) => (r as MemoryRow).id)).toEqual([R1.id, R2.id]);
    expect(b1.nextCursor).toEqual({ created_at: R2.created_at, id: R2.id });
    expect(state.calls.limits).toEqual([3]);
    expect(state.calls.orArgs).toEqual([]);

    const p2 = await handleListCompanionMemories(
      new Request(
        `http://localhost/api/companion/memory?limit=2&cursor=${enc(b1.nextCursor)}`,
      ),
      ctx,
    );
    expect(p2.status).toBe(200);
    const b2 = await body(p2);
    expect((b2.items as unknown[]).map((r) => (r as MemoryRow).id)).toEqual([R3.id]);
    expect(b2.nextCursor).toBeNull();
    expect(state.calls.orArgs).toHaveLength(1);
    expect(state.calls.orArgs[0]).toContain(R2.created_at);
    expect(state.calls.orArgs[0]).toContain(R2.id);
  });

  it("rejects bad status/cursor/limit BEFORE touching rate-limit", async () => {
    const { ctx, rateProbe } = makeCtx();
    for (const url of [
      "http://localhost/api/companion/memory?status=everything",
      "http://localhost/api/companion/memory?cursor=!!!not-base64!!!",
      "http://localhost/api/companion/memory?limit=abc",
      "http://localhost/api/companion/memory?limit=0",
      "http://localhost/api/companion/memory?limit=101",
    ]) {
      const res = await handleListCompanionMemories(new Request(url), ctx);
      expect(res.status).toBe(422);
      expect(await body(res)).toMatchObject({ code: "INVALID" });
    }
    expect(rateProbe).not.toHaveBeenCalled();
  });
});

describe("POST /api/companion/memory", () => {
  it("trial user writes 201 via propose→decide with cache purge", async () => {
    const { ctx, state, rateProbe } = makeCtx({ entitlement: "trial_active" });
    const res = await handleCreateCompanionMemory(
      new Request("http://localhost/api/companion/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "fact", value: "صفقة جديدة" }),
      }),
      ctx,
    );
    expect(res.status).toBe(201);
    expect(await body(res)).toEqual({ id: A2 });
    expect(state.calls.rpc).toEqual(["propose_memories", "decide_memory"]);
    expect(rateProbe).toHaveBeenCalledTimes(1);
    expect(rateProbe.mock.calls[0][0]).toBe(companionRateKey(UID));
    expect(state.calls.redisDel).toEqual([`companion:ctx:v1:${UID}`]);
  });

  it("invalid kind / malformed JSON / blank value → 422 before rate + RPC", async () => {
    const { ctx, state, rateProbe } = makeCtx();
    for (const raw of [
      JSON.stringify({ kind: "rumor", value: "x" }),
      "{not json",
      JSON.stringify({ kind: "fact", value: "   " }),
    ]) {
      const res = await handleCreateCompanionMemory(
        new Request("http://localhost/api/companion/memory", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: raw,
        }),
        ctx,
      );
      expect(res.status).toBe(422);
      expect(await body(res)).toMatchObject({ code: "INVALID" });
    }
    expect(rateProbe).not.toHaveBeenCalled();
    expect(state.calls.rpc).toEqual([]);
  });

  it("maps RPC denies: STARTUP_NOT_OWNED → 422, MEMORY_DUPLICATE → 409", async () => {
    const owned = makeCtx({
      rpcImpl: () => ({ data: { ok: false, code: "STARTUP_NOT_OWNED" }, error: null }),
    });
    const r1 = await handleCreateCompanionMemory(
      new Request("http://localhost/api/companion/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "fact", value: "x", startup_id: RID("f1") }),
      }),
      owned.ctx,
    );
    expect(r1.status).toBe(422);
    expect(await body(r1)).toMatchObject({ code: "STARTUP_NOT_OWNED" });

    const dupe = makeCtx({
      rpcImpl: (name: string) => {
        if (name === "decide_memory")
          return { data: { ok: true, code: "OK", row: { ...R2, status: "approved" } }, error: null };
        return {
          data: { ok: true, code: "OK", results: [{ index: 0, ok: false, code: "MEMORY_DUPLICATE" }], dropped: [] },
          error: null,
        };
      },
    });
    const r2 = await handleCreateCompanionMemory(
      new Request("http://localhost/api/companion/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "fact", value: "مكررة" }),
      }),
      dupe.ctx,
    );
    expect(r2.status).toBe(409);
    expect(await body(r2)).toMatchObject({ code: "MEMORY_DUPLICATE" });
  });
});

describe("PATCH /api/companion/memory/[id]", () => {
  it("plain approve → 200 without conflict field + purges", async () => {
    const { ctx, state } = makeCtx();
    const res = await handleDecideCompanionMemory(
      new Request(`http://localhost/api/companion/memory/${R2.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      }),
      R2.id,
      ctx,
    );
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b).toMatchObject({ id: R2.id, status: "approved" });
    expect(b).not.toHaveProperty("possible_conflict_with");
    expect(state.calls.redisDel).toEqual([`companion:ctx:v1:${UID}`]);
  });

  it("decide-and-edit approve surfaces possible_conflict_with (true positive)", async () => {
    const edited = "ميزانية المشروع 8000 ريال";
    const { ctx } = makeCtx({
      rpcImpl: (name: string) => {
        if (name === "decide_memory")
          return {
            data: { ok: true, code: "OK", row: { ...R1, id: A2, value: edited, status: "approved" } },
            error: null,
          };
        return { data: { ok: true, code: "OK", results: [], dropped: [] }, error: null };
      },
    });
    const res = await handleDecideCompanionMemory(
      new Request(`http://localhost/api/companion/memory/${A2}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve", value: edited }),
      }),
      A2,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ possible_conflict_with: R1.id });
  });

  it("decide-and-edit approve without overlap omits the flag (true negative)", async () => {
    const { ctx } = makeCtx({
      rpcImpl: (name: string) => {
        if (name === "decide_memory")
          return {
            data: { ok: true, code: "OK", row: { ...R1, id: A2, value: "أحب القهوة", status: "approved" } },
            error: null,
          };
        return { data: { ok: true, code: "OK", results: [], dropped: [] }, error: null };
      },
    });
    const res = await handleDecideCompanionMemory(
      new Request(`http://localhost/api/companion/memory/${A2}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve", value: "أحب القهوة" }),
      }),
      A2,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await body(res)).not.toHaveProperty("possible_conflict_with");
  });

  it("rejected→approve is allowed (spec §3 changed-mind), unknown id → 404 likely-archived", async () => {
    const { ctx } = makeCtx();
    const changed = await handleDecideCompanionMemory(
      new Request(`http://localhost/api/companion/memory/${R2.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      }),
      R2.id,
      ctx,
    );
    expect(changed.status).toBe(200);

    const ghost = makeCtx({
      rpcImpl: () => ({ data: { ok: false, code: "NOT_FOUND" }, error: null }),
    });
    const res = await handleDecideCompanionMemory(
      new Request(`http://localhost/api/companion/memory/${RID("99")}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      }),
      RID("99"),
      ghost.ctx,
    );
    expect(res.status).toBe(404);
    expect(await body(res)).toMatchObject({ code: "NOT_FOUND", hint: "likely-archived" });
  });

  it("bad action / malformed id → 422 before rate", async () => {
    const { ctx, rateProbe } = makeCtx();
    const badAction = await handleDecideCompanionMemory(
      new Request(`http://localhost/api/companion/memory/${R2.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "maybe" }),
      }),
      R2.id,
      ctx,
    );
    expect(badAction.status).toBe(422);
    const badId = await handleDecideCompanionMemory(
      new Request("http://localhost/api/companion/memory/nope", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      }),
      "nope",
      ctx,
    );
    expect(badId.status).toBe(422);
    expect(rateProbe).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/companion/memory/[id]", () => {
  it("hard delete → 200 purged:true + cache purge", async () => {
    const { ctx, state } = makeCtx();
    const res = await handleDeleteCompanionMemory(
      new Request(`http://localhost/api/companion/memory/${A1}`, { method: "DELETE" }),
      A1,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ purged: true });
    expect(state.calls.redisDel).toEqual([`companion:ctx:v1:${UID}`]);
  });

  it("absent row (archive-equivalent) → 404 likely-archived", async () => {
    const { ctx } = makeCtx({ deleteRows: [] });
    const res = await handleDeleteCompanionMemory(
      new Request(`http://localhost/api/companion/memory/${RID("99")}`, { method: "DELETE" }),
      RID("99"),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(await body(res)).toMatchObject({ code: "NOT_FOUND", hint: "likely-archived" });
  });
});

describe("profile toggle", () => {
  it("GET profile → 200; POST toggle persists + purges", async () => {
    const { ctx, state } = makeCtx();
    const got = await handleGetCompanionProfile(
      new Request("http://localhost/api/companion/profile/toggle"),
      ctx,
    );
    expect(got.status).toBe(200);
    expect(await body(got)).toEqual({ user_id: UID, memory_enabled: true });

    const toggled = await handleToggleCompanionProfile(
      new Request("http://localhost/api/companion/profile/toggle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memory_enabled: false }),
      }),
      ctx,
    );
    expect(toggled.status).toBe(200);
    expect(await body(toggled)).toEqual({ user_id: UID, memory_enabled: false });
    expect(state.calls.redisDel).toEqual([`companion:ctx:v1:${UID}`]);
  });

  it("non-boolean toggle → 422 before rate", async () => {
    const { ctx, rateProbe } = makeCtx();
    const res = await handleToggleCompanionProfile(
      new Request("http://localhost/api/companion/profile/toggle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ memory_enabled: "false" }),
      }),
      ctx,
    );
    expect(res.status).toBe(422);
    expect(rateProbe).not.toHaveBeenCalled();
  });
});

describe("auth → validation → rate order + entitlement matrix", () => {
  it("anonymous on all six handlers → 5×401 + profile 401 with zero rate burn", async () => {
    const { ctx, rateProbe } = makeCtx({ authed: false });
    const reqs: Array<Promise<Response>> = [
      handleListCompanionMemories(new Request("http://localhost/api/companion/memory"), ctx),
      handleCreateCompanionMemory(
        new Request("http://localhost/api/companion/memory", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "fact", value: "x" }),
        }),
        ctx,
      ),
      handleDecideCompanionMemory(
        new Request(`http://localhost/api/companion/memory/${R2.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "approve" }),
        }),
        R2.id,
        ctx,
      ),
      handleDeleteCompanionMemory(
        new Request(`http://localhost/api/companion/memory/${A1}`, { method: "DELETE" }),
        A1,
        ctx,
      ),
      handleGetCompanionProfile(new Request("http://localhost/api/companion/profile/toggle"), ctx),
      handleToggleCompanionProfile(
        new Request("http://localhost/api/companion/profile/toggle", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ memory_enabled: false }),
        }),
        ctx,
      ),
    ];
    for (const p of reqs) {
      const res = await p;
      expect(res.status).toBe(401);
      expect(await body(res)).toMatchObject({ code: "UNAUTHORIZED" });
    }
    expect(rateProbe).not.toHaveBeenCalled();
  });

  it("trial_consumed reads but cannot write; paused/null denied with plans_url", async () => {
    const ro = makeCtx({ entitlement: "trial_consumed" });
    const listed = await handleListCompanionMemories(
      new Request("http://localhost/api/companion/memory"),
      ro.ctx,
    );
    expect(listed.status).toBe(200);

    const denied = await handleCreateCompanionMemory(
      new Request("http://localhost/api/companion/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "fact", value: "x" }),
      }),
      ro.ctx,
    );
    expect(denied.status).toBe(402);
    expect(await body(denied)).toMatchObject({ code: "TRIAL_CONSUMED", plans_url: "/plans" });
    expect(ro.state.calls.rpc).toEqual([]);

    const decided = await handleDecideCompanionMemory(
      new Request(`http://localhost/api/companion/memory/${R2.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      }),
      R2.id,
      ro.ctx,
    );
    expect(decided.status).toBe(402);

    const paused = makeCtx({ entitlement: "paused" });
    const pList = await handleListCompanionMemories(
      new Request("http://localhost/api/companion/memory"),
      paused.ctx,
    );
    expect(pList.status).toBe(402);
    expect(await body(pList)).toMatchObject({ code: "ACCOUNT_PAUSED", plans_url: "/plans" });

    const anon = makeCtx({ entitlement: null });
    const aPost = await handleCreateCompanionMemory(
      new Request("http://localhost/api/companion/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "fact", value: "x" }),
      }),
      anon.ctx,
    );
    expect(aPost.status).toBe(402);
    expect(await body(aPost)).toMatchObject({ code: "SUBSCRIPTION_REQUIRED" });
  });

  it("disabled (paused) account writes nothing: 402 before any write RPC", async () => {
    const { ctx, state } = makeCtx({ entitlement: "paused" });
    const res = await handleCreateCompanionMemory(
      new Request("http://localhost/api/companion/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "fact", value: "x" }),
      }),
      ctx,
    );
    expect(res.status).toBe(402);
    expect(state.calls.rpc).toEqual([]);
    expect(state.calls.redisDel).toEqual([]);
  });

  it("rate-limited → 429 with Retry-After, no DAL touch", async () => {
    const { ctx, state } = makeCtx();
    ctx.checkRate = async () => ({ limited: true, retryAfter: 7 });
    const res = await handleListCompanionMemories(
      new Request("http://localhost/api/companion/memory"),
      ctx,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("7");
    expect(await body(res)).toMatchObject({ retryAfter: 7 });
    expect(state.calls.rpc).toEqual([]);
    expect(state.calls.limits).toEqual([]);
  });
});

describe("route wiring", () => {
  const root = path.join(__dirname, "..", "companion");
  it("all three route files gate via user-JWT auth + mem: rate buckets", () => {
    for (const f of ["memory/route.ts", "memory/[id]/route.ts", "profile/toggle/route.ts"]) {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      expect(src).toMatch(/checkRateLimit/);
      expect(src).toMatch(/mem:/);
      expect(src).toMatch(/getUser|createServerSupabaseClient/);
    }
  });
});
