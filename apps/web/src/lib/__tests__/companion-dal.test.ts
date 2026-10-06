import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
// server-only resolves to empty.js under the react-server export condition;
// neutralize it for the node test env (admin-dal.test.ts precedent).
vi.mock("server-only", () => ({}));
import type { EntitlementStatus } from "@/lib/entitlements";
import {
  createManualMemory,
  decideMemory,
  forgetMemory,
  getCompiledContext,
  getCompanionProfile,
  listMemories,
  proposeMemories,
  purgeCompanionCache,
  setMemoryEnabled,
  type CompanionDeps,
} from "../companion/dal";
import {
  decideActionSchema,
  memoryIdSchema,
  memoryKindSchema,
  memoryValueSchema,
  statusFilterSchema,
} from "../companion/validation";

// ---------- in-memory fakes (no network) ----------

interface FakeRow {
  id: string;
  user_id: string;
  kind: string;
  value: string;
  status: string;
  confidence: number | null;
  source_ref: string | null;
  startup_id: string | null;
  created_at: string;
  decided_at: string | null;
}

interface FakeState {
  authUid: string;
  entitlement: EntitlementStatus | null;
  profiles: Map<string, boolean>;
  memories: FakeRow[];
  rpcImpl: (name: string, params: Record<string, unknown>) => { data: unknown; error: null };
  selectError: Record<string, { code: string; message: string }>;
  redisGetImpl: (key: string) => Promise<string | null>;
  calls: {
    rpc: Array<{ name: string; params: Record<string, unknown> }>;
    redisGet: string[];
    redisSetex: Array<{ key: string; ttl: number; value: string }>;
    redisDel: string[];
    from: string[];
  };
}

// Minimal chainable query builder honoring exactly the chains dal.ts uses.
class FQ {
  private mode: "select" | "insert" | "upsert" | "delete" = "select";
  private payload: Record<string, unknown> = {};
  private upsertOpts: Record<string, unknown> = {};
  private filters: Array<(r: FakeRow) => boolean> = [];
  private profileFilters: Array<(p: { user_id: string; memory_enabled: boolean }) => boolean> = [];
  private orders: Array<{ col: string; asc: boolean }> = [];
  private limitN?: number;
  private orExpr?: string;

  constructor(
    private state: FakeState,
    private table: string,
  ) {}

  select(_cols?: string): this {
    void _cols;
    return this;
  }
  insert(row: Record<string, unknown>): this {
    this.mode = "insert";
    this.payload = row;
    return this;
  }
  upsert(row: Record<string, unknown>, opts?: Record<string, unknown>): this {
    this.mode = "upsert";
    this.payload = row;
    this.upsertOpts = opts ?? {};
    return this;
  }
  delete(): this {
    this.mode = "delete";
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push((r) => (r as unknown as Record<string, unknown>)[col] === val);
    this.profileFilters.push((p) => (p as unknown as Record<string, unknown>)[col] === val);
    return this;
  }
  in(col: string, vals: unknown[]): this {
    this.filters.push((r) => vals.includes((r as unknown as Record<string, unknown>)[col]));
    return this;
  }
  lt(col: string, val: unknown): this {
    this.filters.push(
      (r) => ((r as unknown as Record<string, unknown>)[col] as string) < (val as string),
    );
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orders.push({ col, asc: opts?.ascending ?? true });
    return this;
  }
  or(expr: string): this {
    this.orExpr = expr;
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  private applyOr(rows: FakeRow[]): FakeRow[] {
    if (!this.orExpr) return rows;
    const lt = this.orExpr.match(/created_at\.lt\.([^,]+)/)?.[1];
    const eq = this.orExpr.match(/created_at\.eq\.([^,)]+)/)?.[1];
    const idLt = this.orExpr.match(/id\.lt\.([^,)]+)/)?.[1];
    return rows.filter(
      (r) => (lt !== undefined && r.created_at < lt) || (r.created_at === eq && (idLt === undefined || r.id < idLt)),
    );
  }

  private execute(): { data: unknown; error: { code: string; message: string } | null } {
    const { state, table } = this;
    state.calls.from.push(table);
    if (state.selectError[table]) return { data: null, error: state.selectError[table] };
    if (table === "companion_profile") {
      let rows = [...state.profiles.entries()].map(([user_id, memory_enabled]) => ({
        user_id,
        memory_enabled,
      }));
      rows = rows.filter((p) => this.profileFilters.every((f) => f(p)));
      if (this.mode === "insert" || this.mode === "upsert") {
        const uid = this.payload.user_id as string;
        const enabled =
          (this.payload.memory_enabled as boolean | undefined) ??
          state.profiles.get(uid) ??
          true;
        state.profiles.set(uid, enabled);
        return { data: [{ user_id: uid, memory_enabled: enabled }], error: null };
      }
      return { data: rows, error: null };
    }
    if (table === "companion_memory") {
      if (this.mode === "delete") {
        const doomed = state.memories.filter((r) => this.filters.every((f) => f(r)));
        state.memories = state.memories.filter((r) => !this.filters.every((f) => f(r)));
        return { data: doomed.map((r) => ({ id: r.id })), error: null };
      }
      let rows = state.memories.filter((r) => this.filters.every((f) => f(r)));
      rows = this.applyOr(rows);
      for (const o of [...this.orders].reverse()) {
        rows = [...rows].sort((a, b) =>
          o.asc
            ? String(a[o.col as keyof FakeRow]) < String(b[o.col as keyof FakeRow])
              ? -1
              : 1
            : String(a[o.col as keyof FakeRow]) > String(b[o.col as keyof FakeRow])
              ? -1
              : 1,
        );
      }
      if (this.limitN !== undefined) rows = rows.slice(0, this.limitN);
      return { data: rows, error: null };
    }
    return { data: [], error: null };
  }

  async maybeSingle(): Promise<{ data: unknown; error: { code: string; message: string } | null }> {
    const { data, error } = this.execute();
    return { data: (data as unknown[])[0] ?? null, error };
  }

  then(
    resolve: (v: { data: unknown; error: { code: string; message: string } | null }) => void,
    reject?: (e: unknown) => void,
  ): void {
    try {
      resolve(this.execute());
    } catch (e) {
      if (reject) reject(e);
      else throw e;
    }
  }
}

let seq = 0;

function mem(over: Partial<FakeRow> & { user_id: string; value: string }): FakeRow {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    kind: "fact",
    status: "pending",
    confidence: null,
    source_ref: null,
    startup_id: null,
    created_at: new Date(Date.now() - seq * 1000).toISOString(),
    decided_at: null,
    ...over,
  };
}

function makeDeps(over?: Partial<FakeState>): { deps: CompanionDeps; state: FakeState } {
  const state: FakeState = {
    authUid: "user-A",
    entitlement: "subscribed",
    profiles: new Map(),
    memories: [],
    rpcImpl: () => {
      throw new Error("rpcImpl not stubbed for this test");
    },
    selectError: {},
    redisGetImpl: async () => null,
    calls: { rpc: [], redisGet: [], redisSetex: [], redisDel: [], from: [] },
    ...over,
  };
  const client = {
    from: (table: string) => new FQ(state, table),
    rpc: async (name: string, params: Record<string, unknown>) => {
      state.calls.rpc.push({ name, params });
      return state.rpcImpl(name, params);
    },
  };
  const deps: CompanionDeps = {
    userClient: async () => client as unknown as SupabaseClient,
    getEntitlementStatus: async () => state.entitlement,
    redisGet: async (key: string) => {
      state.calls.redisGet.push(key);
      return state.redisGetImpl(key);
    },
    redisSetex: async (key: string, ttl: number, value: string) => {
      state.calls.redisSetex.push({ key, ttl, value });
    },
    redisDel: async (key: string) => {
      state.calls.redisDel.push(key);
    },
    nowMs: () => Date.now(),
  };
  return { deps, state };
}

// RPC stub honoring the Task 2 contract: caller check + cap under lock.
function contractRpc(state: FakeState) {
  return (name: string, params: Record<string, unknown>) => {
    if (params.p_user_id !== state.authUid)
      return { data: { ok: false, code: "FORBIDDEN" }, error: null };
    if (name === "decide_memory") {
      const row = state.memories.find(
        (m) => m.id === params.p_id && m.user_id === params.p_user_id,
      );
      if (!row) return { data: { ok: false, code: "NOT_FOUND" }, error: null };
      const approved = state.memories.filter(
        (m) => m.user_id === params.p_user_id && m.status === "approved",
      ).length;
      if (params.p_action === "approve" && row.status !== "approved" && approved >= 200)
        return { data: { ok: false, code: "MEMORY_FULL" }, error: null };
      row.status = params.p_action === "approve" ? "approved" : "rejected";
      row.decided_at = new Date().toISOString();
      return { data: { ok: true, code: "OK", row }, error: null };
    }
    return { data: { ok: true, code: "OK", results: [], dropped: [] }, error: null };
  };
}

describe("validation", () => {
  it("accepts the DB domains, rejects the rest", () => {
    expect(memoryKindSchema.safeParse("fact").success).toBe(true);
    expect(memoryKindSchema.safeParse("rumor").success).toBe(false);
    expect(memoryValueSchema.safeParse("x").success).toBe(true);
    expect(memoryValueSchema.safeParse("").success).toBe(false);
    expect(memoryValueSchema.safeParse("x".repeat(501)).success).toBe(false);
    expect(memoryIdSchema.safeParse("00000000-0000-4000-8000-000000000001").success).toBe(true);
    expect(memoryIdSchema.safeParse("nope").success).toBe(false);
    expect(decideActionSchema.safeParse("approve").success).toBe(true);
    expect(decideActionSchema.safeParse("maybe").success).toBe(false);
    expect(statusFilterSchema.safeParse("all").success).toBe(true);
    expect(statusFilterSchema.safeParse("everything").success).toBe(false);
  });
});

describe("profiles", () => {
  it("lazy-inserts an enabled profile on first read", async () => {
    const { deps, state } = makeDeps();
    const p = await getCompanionProfile("user-A", deps);
    expect(p).toEqual({ user_id: "user-A", memory_enabled: true });
    expect(state.profiles.get("user-A")).toBe(true);
  });

  it("returns a stored disabled profile untouched", async () => {
    const { deps } = makeDeps({ profiles: new Map([["user-A", false]]) });
    await expect(getCompanionProfile("user-A", deps)).resolves.toEqual({
      user_id: "user-A",
      memory_enabled: false,
    });
  });
});

describe("approve at cap (Review-Focus #1)", () => {
  it("maps a full ledger to MEMORY_FULL", async () => {
    const approved = Array.from({ length: 200 }, (_, i) =>
      mem({ user_id: "user-A", value: `old fact ${i}`, status: "approved" }),
    );
    const pending = mem({ user_id: "user-A", value: "one more" });
    const { deps, state } = makeDeps({ memories: [...approved, pending] });
    state.rpcImpl = contractRpc(state);
    await expect(decideMemory("user-A", pending.id, "approve", undefined, deps)).rejects.toMatchObject(
      { code: "MEMORY_FULL" },
    );
  });
});

describe("disabled memory (Review-Focus #3)", () => {
  it("returns '' with no Redis touch and no approved-select", async () => {
    const pending = Array.from({ length: 5 }, (_, i) =>
      mem({ user_id: "user-A", value: `queued ${i}` }),
    );
    const { deps, state } = makeDeps({
      profiles: new Map([["user-A", false]]),
      memories: pending,
    });
    await expect(getCompiledContext("user-A", "q", deps)).resolves.toBe("");
    expect(state.calls.redisGet).toEqual([]);
    expect(state.calls.from).toEqual(["companion_profile"]);
  });
});

describe("Redis outage at DAL level (Review-Focus #4)", () => {
  it("falls back to Postgres for reads, still writes decides", async () => {
    const row = mem({ user_id: "user-A", value: "نبيع القهوة", status: "approved" });
    const { deps, state } = makeDeps({
      profiles: new Map([["user-A", true]]),
      memories: [row],
      redisGetImpl: async () => {
        throw new Error("redis down");
      },
    });
    state.rpcImpl = contractRpc(state);
    const block = await getCompiledContext("user-A", "القهوة", deps);
    expect(block).toContain("نبيع القهوة");
    const target = mem({ user_id: "user-A", value: "target row" });
    state.memories.push(target);
    await decideMemory("user-A", target.id, "approve", undefined, deps);
    expect(state.calls.rpc.some((c) => c.name === "decide_memory")).toBe(true);
  });
});

describe("ownership (H4)", () => {
  it("maps a foreign startup to STARTUP_NOT_OWNED", async () => {
    const { deps, state } = makeDeps();
    state.rpcImpl = () => ({
      data: { ok: true, code: "OK", results: [{ index: 0, ok: false, code: "STARTUP_NOT_OWNED" }], dropped: [] },
      error: null,
    });
    await expect(
      createManualMemory(
        "user-A",
        { kind: "fact", value: "linked thought", startup_id: "11111111-1111-4111-8111-111111111111" },
        deps,
      ),
    ).rejects.toMatchObject({ code: "STARTUP_NOT_OWNED" });
  });
});

describe("cache discipline", () => {
  it("forget + toggle purge the exact ctx key", async () => {
    const row = mem({ user_id: "user-A", value: "forgettable" });
    const { deps, state } = makeDeps({ memories: [row] });
    await forgetMemory("user-A", row.id, deps);
    expect(state.memories).toHaveLength(0);
    await setMemoryEnabled("user-A", false, deps);
    expect(state.calls.redisDel).toEqual(["companion:ctx:v1:user-A", "companion:ctx:v1:user-A"]);
  });

  it("approve purges; forgetting a ghost is NOT_FOUND", async () => {
    const row = mem({ user_id: "user-A", value: "approve me" });
    const { deps, state } = makeDeps({ memories: [row] });
    state.rpcImpl = contractRpc(state);
    await decideMemory("user-A", row.id, "approve", undefined, deps);
    expect(state.calls.redisDel).toEqual(["companion:ctx:v1:user-A"]);
    await expect(
      forgetMemory("user-A", "00000000-0000-4000-8000-999999999999", deps),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("missing table (M6/H6)", () => {
  it("PGRST205 shape degrades to '' without throwing", async () => {
    const { deps } = makeDeps({
      profiles: new Map([["user-A", true]]),
      selectError: {
        companion_memory: {
          code: "PGRST205",
          message: "Could not find the table 'public.companion_memory' in the schema cache",
        },
      },
    });
    await expect(getCompiledContext("user-A", "q", deps)).resolves.toBe("");
  });
});

describe("entitlement matrix (g)", () => {
  it("paused list → ACCOUNT_PAUSED, null → SUBSCRIPTION_REQUIRED", async () => {
    const { deps } = makeDeps({ entitlement: "paused" });
    await expect(listMemories("user-A", "all", 20, undefined, deps)).rejects.toMatchObject({
      code: "ACCOUNT_PAUSED",
    });
    const { deps: nullDeps } = makeDeps({ entitlement: null });
    await expect(listMemories("user-A", "all", 20, undefined, nullDeps)).rejects.toMatchObject({
      code: "SUBSCRIPTION_REQUIRED",
    });
  });

  it("trial_consumed lists OK but cannot decide", async () => {
    const row = mem({ user_id: "user-A", value: "trial thought" });
    const { deps, state } = makeDeps({ entitlement: "trial_consumed", memories: [row] });
    state.rpcImpl = contractRpc(state);
    const { rows } = await listMemories("user-A", "all", 20, undefined, deps);
    expect(rows).toHaveLength(1);
    await expect(decideMemory("user-A", row.id, "approve", undefined, deps)).rejects.toMatchObject({
      code: "TRIAL_CONSUMED",
    });
    expect(state.calls.rpc).toHaveLength(0);
  });
});

describe("all hides rejected (H10) + pagination", () => {
  it("never surfaces rejected rows and pages by (created_at,id)", async () => {
    const rows = [
      mem({ user_id: "user-A", value: "p1" }),
      mem({ user_id: "user-A", value: "a1", status: "approved" }),
      mem({ user_id: "user-A", value: "r1", status: "rejected" }),
      mem({ user_id: "user-A", value: "p2" }),
    ];
    const { deps } = makeDeps({ memories: rows });
    const first = await listMemories("user-A", "all", 2, undefined, deps);
    expect(first.rows.map((r) => r.value).sort()).toEqual(["a1", "p1", "p2"].slice(0, 2).sort());
    expect(first.rows.some((r) => r.status === "rejected")).toBe(false);
    expect(first.nextCursor).not.toBeNull();
    const second = await listMemories("user-A", "all", 2, first.nextCursor ?? undefined, deps);
    expect(second.rows).toHaveLength(1);
    expect(second.rows.some((r) => r.status === "rejected")).toBe(false);
    expect(second.nextCursor).toBeNull();
  });
});

describe("cross-user FORBIDDEN (C3)", () => {
  it("user-A client calling for user-B is denied by the RPC", async () => {
    const row = mem({ user_id: "user-B", value: "not mine" });
    const { deps, state } = makeDeps({ memories: [row] });
    state.rpcImpl = contractRpc(state);
    await expect(decideMemory("user-B", row.id, "approve", undefined, deps)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("manual create", () => {
  it("pre-checks normalized dupes without calling the RPC", async () => {
    const { deps, state } = makeDeps({
      memories: [mem({ user_id: "user-A", value: "نبيع القهوة", status: "approved" })],
    });
    state.rpcImpl = () => ({
      data: { ok: true, code: "OK", results: [{ index: 0, ok: true, code: "OK", id: "x" }], dropped: [] },
      error: null,
    });
    await expect(
      createManualMemory("user-A", { kind: "fact", value: "نبيع القهوة!" }, deps),
    ).rejects.toMatchObject({ code: "MEMORY_DUPLICATE" });
    expect(state.calls.rpc).toHaveLength(0);
  });

  it("single-row propose with NULL confidence returns the new id", async () => {
    const { deps, state } = makeDeps();
    state.rpcImpl = () => ({
      data: {
        ok: true,
        code: "OK",
        results: [{ index: 0, ok: true, code: "OK", id: "new-id-1" }],
        dropped: [],
      },
      error: null,
    });
    await expect(
      createManualMemory("user-A", { kind: "preference", value: "أحب الشاي" }, deps),
    ).resolves.toEqual({ id: "new-id-1" });
    const sent = state.calls.rpc[0].params.p_rows as Array<Record<string, unknown>>;
    expect(sent[0].confidence).toBeNull();
  });
});

describe("propose batch", () => {
  it("passes results/dropped through, throws top-level denies", async () => {
    const { deps, state } = makeDeps();
    state.rpcImpl = () => ({
      data: {
        ok: true,
        code: "OK",
        results: [{ index: 0, ok: true, code: "OK", id: "a" }],
        dropped: ["old-id"],
      },
      error: null,
    });
    await expect(
      proposeMemories("user-A", [{ kind: "fact", value: "v", confidence: 0.9 }], deps),
    ).resolves.toEqual({
      results: [{ index: 0, ok: true, code: "OK", id: "a" }],
      dropped: ["old-id"],
    });
    state.rpcImpl = () => ({ data: { ok: false, code: "INVALID" }, error: null });
    await expect(proposeMemories("user-A", [], deps)).rejects.toMatchObject({ code: "INVALID" });
  });
});

describe("purge helper", () => {
  it("deletes the ctx key and nothing else", async () => {
    const { deps, state } = makeDeps();
    await purgeCompanionCache("user-A", deps);
    expect(state.calls.redisDel).toEqual(["companion:ctx:v1:user-A"]);
  });
});

describe("redis cache path", () => {
  it("hit returns without touching Postgres; miss compiles and setexes", async () => {
    const row = mem({ user_id: "user-A", value: "نبيع القهوة", status: "approved" });
    const { deps, state } = makeDeps({
      profiles: new Map([["user-A", true]]),
      memories: [row],
      redisGetImpl: async () => "<untrusted>cached</untrusted>",
    });
    await expect(getCompiledContext("user-A", "q", deps)).resolves.toBe(
      "<untrusted>cached</untrusted>",
    );
    expect(state.calls.from).toEqual(["companion_profile"]);

    const { deps: missDeps, state: missState } = makeDeps({
      profiles: new Map([["user-A", true]]),
      memories: [row],
    });
    const block = await getCompiledContext("user-A", "القهوة", missDeps);
    expect(block).toContain("نبيع القهوة");
    expect(missState.calls.redisSetex).toHaveLength(1);
    expect(missState.calls.redisSetex[0].key).toBe("companion:ctx:v1:user-A");
    expect(missState.calls.redisSetex[0].ttl).toBe(3600);
  });
});
