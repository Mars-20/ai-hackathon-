import { describe, test, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
}));

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { PUT as stagePUT } from "@/app/api/startups/[id]/stage/route";
import { POST as dismissPOST } from "@/app/api/startups/[id]/stage/dismiss/route";

const mockedClient = vi.mocked(createServerSupabaseClient);

const UID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SID = "33333333-3333-4333-8333-333333333333";

interface Row {
  [k: string]: unknown;
}
interface FakeDb {
  user: { id: string } | null;
  startups: Row[];
  decisions: Row[];
  evidence: Row[];
  history: Row[];
  dismissals: Row[];
}

function seedDb(over: Partial<FakeDb> = {}): FakeDb {
  return {
    user: { id: UID },
    startups: [
      {
        id: SID,
        owner_id: UID,
        workspace_id: null,
        stage: "idea",
        stage_track: null,
        stage_order: null,
      },
    ],
    decisions: [],
    evidence: [],
    history: [],
    dismissals: [],
    ...over,
  };
}

// Minimal chainable fake covering the stage routes' query shapes.
class FQ {
  private filters: Array<{ col: string; val: unknown }> = [];
  private patch: Row | null = null;
  private rowsToInsert: Row[] | null = null;
  constructor(
    private db: FakeDb,
    private table: string,
  ) {}
  select(..._args: unknown[]): this {
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push({ col, val });
    return this;
  }
  update(patch: Row): this {
    this.patch = patch;
    return this;
  }
  insert(rows: Row | Row[]): this {
    this.rowsToInsert = (Array.isArray(rows) ? rows : [rows]).map((r, i) => ({
      id: `gen-${Date.now()}-${i}`,
      created_at: new Date().toISOString(),
      ...r,
    }));
    return this;
  }
  upsert(row: Row, _opts?: unknown): this {
    this.rowsToInsert = [
      {
        id: `gen-${Date.now()}`,
        created_at: new Date().toISOString(),
        ...row,
      },
    ];
    (this as unknown as { _upsert: boolean })._upsert = true;
    return this;
  }
  private src(): Row[] {
    if (this.table === "startups") return this.db.startups;
    if (this.table === "decisions") return this.db.decisions;
    if (this.table === "evidence") return this.db.evidence;
    if (this.table === "startup_stage_history") return this.db.history;
    return this.db.dismissals;
  }
  private matched(): Row[] {
    return this.src().filter((r) =>
      this.filters.every((f) => r[f.col] === f.val),
    );
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    return { data: this.matched()[0] ?? null, error: null };
  }
  async single(): Promise<{ data: Row | null; error: { message: string } | null }> {
    if (this.rowsToInsert) {
      const last = this.rowsToInsert[this.rowsToInsert.length - 1];
      this.commitInserts();
      return { data: last, error: null };
    }
    const rows = this.matched();
    if (this.patch) {
      for (const r of rows) Object.assign(r, this.patch);
      if (rows.length === 0) return { data: null, error: { message: "none" } };
      return { data: rows[0], error: null };
    }
    if (rows.length === 0) return { data: null, error: { message: "none" } };
    return { data: rows[0], error: null };
  }
  private commitInserts(): void {
    if (!this.rowsToInsert) return;
    const isUpsert = (this as unknown as { _upsert?: boolean })._upsert;
    for (const r of this.rowsToInsert) {
      if (isUpsert && this.table === "stage_suggestion_dismissals") {
        const ix = this.src().findIndex(
          (x) =>
            x.startup_id === r.startup_id &&
            x.from_stage === r.from_stage &&
            x.to_stage === r.to_stage,
        );
        if (ix >= 0) this.src()[ix] = { ...this.src()[ix], ...r };
        else this.src().push(r);
      } else {
        this.src().push(r);
      }
    }
    this.rowsToInsert = null;
  }
  then(
    resolve: (v: { data: Row[] | null; error: null }) => unknown,
  ): unknown {
    if (this.rowsToInsert) {
      const rows = this.rowsToInsert;
      this.commitInserts();
      return resolve({ data: rows, error: null });
    }
    if (this.patch) {
      const rows = this.matched();
      for (const r of rows) Object.assign(r, this.patch);
      return resolve({ data: rows, error: null });
    }
    return resolve({ data: this.matched(), error: null });
  }
}

function wire(db: FakeDb): void {
  mockedClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: db.user } }) },
    from: (table: string) => new FQ(db, table),
  } as never);
}

function reqWithBody(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/x", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: SID }) };

describe("PUT /api/startups/[id]/stage", () => {
  beforeEach(() => vi.clearAllMocks());

  test("401 without user", async () => {
    const db = seedDb({ user: null });
    wire(db);
    const res = await stagePUT(reqWithBody({ to: "prototype" }), params);
    expect(res.status).toBe(401);
  });

  test("404 for unknown startup", async () => {
    const db = seedDb({ startups: [] });
    wire(db);
    const res = await stagePUT(reqWithBody({ to: "prototype" }), params);
    expect(res.status).toBe(404);
  });

  test("403 for another owner's startup", async () => {
    const db = seedDb({
      startups: [
        { id: SID, owner_id: OTHER, workspace_id: null, stage: "idea" },
      ],
    });
    wire(db);
    const res = await stagePUT(reqWithBody({ to: "prototype" }), params);
    expect(res.status).toBe(403);
  });

  test("400 INVALID for out-of-track target", async () => {
    const db = seedDb();
    wire(db);
    const res = await stagePUT(reqWithBody({ to: "beta" }), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID" });
  });

  test("400 INVALID for no-op (to === current)", async () => {
    const db = seedDb();
    wire(db);
    const res = await stagePUT(reqWithBody({ to: "idea" }), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID" });
  });

  test("confirm with live Go writes stage + suggestion history", async () => {
    const db = seedDb({
      decisions: [
        { id: "d1", startup_id: SID, verdict: "go", created_at: "2026-10-08T00:00:00Z" },
      ],
    });
    wire(db);
    const res = await stagePUT(reqWithBody({ to: "prototype" }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stage).toBe("prototype");
    expect(body.history_id).toBeTruthy();
    expect(db.startups[0].stage).toBe("prototype");
    expect(db.history).toHaveLength(1);
    expect(db.history[0]).toMatchObject({
      from_stage: "idea",
      to_stage: "prototype",
      actor: "suggestion",
    });
    expect(db.history[0].supporting_refs).toMatchObject({
      decisionIds: ["d1"],
    });
  });

  test("confirm without basis records user actor", async () => {
    const db = seedDb();
    wire(db);
    const res = await stagePUT(reqWithBody({ to: "prototype" }), params);
    expect(res.status).toBe(200);
    expect(db.history[0]).toMatchObject({ actor: "user" });
  });
});

describe("POST /api/startups/[id]/stage/dismiss", () => {
  beforeEach(() => vi.clearAllMocks());

  test("401 without user", async () => {
    const db = seedDb({ user: null });
    wire(db);
    const res = await dismissPOST(reqWithBody({ to: "prototype" }), params);
    expect(res.status).toBe(401);
  });

  test("400 INVALID for out-of-track target", async () => {
    const db = seedDb();
    wire(db);
    const res = await dismissPOST(reqWithBody({ to: "beta" }), params);
    expect(res.status).toBe(400);
  });

  test("dismiss records the pair with current rung4 count", async () => {
    const db = seedDb({
      evidence: [
        { id: "e1", startup_id: SID, strength: "commitment" },
        { id: "e2", startup_id: SID, strength: "contact_shared" },
        { id: "e3", startup_id: SID, strength: "opinion" },
      ],
    });
    wire(db);
    const res = await dismissPOST(reqWithBody({ to: "prototype" }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dismissed: true });
    expect(db.dismissals).toHaveLength(1);
    expect(db.dismissals[0]).toMatchObject({
      startup_id: SID,
      from_stage: "idea",
      to_stage: "prototype",
      rung4_count: 2,
    });
  });
});
