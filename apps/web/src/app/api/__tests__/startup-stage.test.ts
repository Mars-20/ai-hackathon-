import { describe, test, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
}));

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { PUT as stagePUT } from "@/app/api/startups/[id]/stage/route";
import { GET as stageGET } from "@/app/api/startups/[id]/stage/route";
import { PATCH as trackPATCH } from "@/app/api/startups/[id]/stage/track/route";
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
  /** Tables whose inserts fail (fault-injection for atomicity tests). */
  failTables: string[];
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
    failTables: [],
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
      if (this.db.failTables.includes(this.table)) {
        this.rowsToInsert = null;
        return { data: null, error: { message: "injected insert failure" } };
      }
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

  test("a Go older than the last advancement does not re-fire", async () => {
    const db = seedDb({
      decisions: [
        { id: "d1", startup_id: SID, verdict: "go", created_at: "2026-10-07T00:00:00Z" },
      ],
      history: [
        {
          id: "h1",
          startup_id: SID,
          from_stage: "idea",
          to_stage: "prototype",
          actor: "suggestion",
          created_at: "2026-10-08T00:00:00Z",
        },
      ],
    });
    // Startup already sits at prototype after the recorded advancement.
    db.startups[0].stage = "prototype";
    wire(db);
    const res = await stageGET(reqWithBody({}), params);
    expect(res.status).toBe(200);
    expect((await res.json()).suggestion).toBeNull();
  });
});

describe("PATCH /api/startups/[id]/stage/track", () => {
  beforeEach(() => vi.clearAllMocks());

  test("401 without user", async () => {
    const db = seedDb({ user: null });
    wire(db);
    const res = await trackPATCH(reqWithBody({ track: "saas_tech" }), params);
    expect(res.status).toBe(401);
  });

  test("404 for unknown startup", async () => {
    const db = seedDb({ startups: [] });
    wire(db);
    const res = await trackPATCH(reqWithBody({ track: "saas_tech" }), params);
    expect(res.status).toBe(404);
  });

  test("403 for another owner's startup", async () => {
    const db = seedDb({
      startups: [
        { id: SID, owner_id: OTHER, workspace_id: null, stage: "idea" },
      ],
    });
    wire(db);
    const res = await trackPATCH(reqWithBody({ track: "saas_tech" }), params);
    expect(res.status).toBe(403);
  });

  test("400 INVALID for unknown track", async () => {
    const db = seedDb();
    wire(db);
    const res = await trackPATCH(reqWithBody({ track: "nope" }), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID" });
  });

  test("switching track stores stage_track and preserves every other column", async () => {    const db = seedDb({
      startups: [
        {
          id: SID,
          owner_id: UID,
          workspace_id: "99999999-9999-4999-8999-999999999999",
          stage: "idea",
          stage_track: null,
          stage_order: null,
          name: "Keep",
          one_liner: "keep me",
          domain: "edtech",
          target_customer: "x",
          business_model: "y",
        },
      ],
    });
    wire(db);
    const res = await trackPATCH(reqWithBody({ track: "saas_tech" }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ track: "saas_tech" });
    expect(db.startups[0]).toMatchObject({
      stage: "idea",
      stage_track: "saas_tech",
      name: "Keep",
      one_liner: "keep me",
      domain: "edtech",
      target_customer: "x",
      business_model: "y",
      workspace_id: "99999999-9999-4999-8999-999999999999",
    });
  });
  test("a valid custom order is stored and shadows the template", async () => {
    const db = seedDb();
    wire(db);
    const order = [
      { key: "idea", label: "فكرة" },
      { key: "pilot", label: "تجربة" },
    ];
    const res = await trackPATCH(
      reqWithBody({ track: "local_service", order }),
      params,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ track: "local_service" });
    expect(db.startups[0]).toMatchObject({
      stage: "idea",
      stage_track: "local_service",
      stage_order: order,
    });
  });
  test("switching track without an order clears a previous custom order", async () => {
    const db = seedDb({
      startups: [
        {
          id: SID,
          owner_id: UID,
          workspace_id: null,
          stage: "idea",
          stage_track: "local_service",
          stage_order: [{ key: "idea", label: "فكرة" }],
        },
      ],
    });
    wire(db);
    const res = await trackPATCH(reqWithBody({ track: "saas_tech" }), params);
    expect(res.status).toBe(200);
    expect(db.startups[0]).toMatchObject({
      stage_track: "saas_tech",
      stage_order: null,
    });
  });
  test("400 INVALID for malformed custom orders", async () => {
    const bad = [
      { order: [{ key: "", label: "x" }] },
      {
        order: [
          { key: "Idea", label: "a" },
          { key: "idea", label: "b" },
        ],
      },
      { order: [] },
      { order: "idea" },
      { order: [{ key: "idea", label: "" }] },
    ];
    for (const body of bad) {
      const db = seedDb();
      wire(db);
      const res = await trackPATCH(
        reqWithBody({ track: "general", ...body }),
        params,
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "INVALID" });
      expect(db.startups[0].stage_order).toBeNull();
    }
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

describe("frozen startups (is_frozen)", () => {
  beforeEach(() => vi.clearAllMocks());

  function frozenDb(): FakeDb {
    return seedDb({
      startups: [
        {
          id: SID,
          owner_id: UID,
          workspace_id: null,
          stage: "idea",
          stage_track: null,
          stage_order: null,
          is_frozen: true,
        },
      ],
    });
  }

  test("PUT confirm on a frozen startup is 403 FROZEN and changes nothing", async () => {
    const db = frozenDb();
    wire(db);
    const res = await stagePUT(reqWithBody({ to: "prototype" }), params);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "FROZEN" });
    expect(db.startups[0].stage).toBe("idea");
    expect(db.history).toHaveLength(0);
  });

  test("dismiss on a frozen startup is 403 FROZEN and records nothing", async () => {
    const db = frozenDb();
    wire(db);
    const res = await dismissPOST(reqWithBody({ to: "prototype" }), params);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "FROZEN" });
    expect(db.dismissals).toHaveLength(0);
  });

  test("track switch on a frozen startup is 403 FROZEN and keeps the track", async () => {
    const db = frozenDb();
    wire(db);
    const res = await trackPATCH(reqWithBody({ track: "saas_tech" }), params);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "FROZEN" });
    expect(db.startups[0].stage_track).toBeNull();
  });

  test("history insert failure reverts the stage (no silent move)", async () => {
    const db = seedDb({ failTables: ["startup_stage_history"] });
    wire(db);
    const res = await stagePUT(reqWithBody({ to: "prototype" }), params);
    expect(res.status).toBe(500);
    expect(db.startups[0].stage).toBe("idea");
    expect(db.history).toHaveLength(0);
  });
});
