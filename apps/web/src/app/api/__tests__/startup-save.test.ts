import { describe, test, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: vi.fn(),
  createServiceRoleClient: vi.fn(),
}));

import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";
import { POST as savePOST } from "@/app/api/startups/save/route";

const mockedClient = vi.mocked(createServerSupabaseClient);
const mockedService = vi.mocked(createServiceRoleClient);

const UID = "11111111-1111-4111-8111-111111111111";
const WID = "44444444-4444-4444-8444-444444444444";

interface Row {
  [k: string]: unknown;
}
interface FakeDb {
  user: { id: string } | null;
  entitlementStatus: string;
  memberships: Row[];
  workspaces: Row[];
  startups: Row[];
  /** When true, personal-workspace creation fails (RLS/deadlock path). */
  failWorkspaceCreate: boolean;
  lastUpsert: Row | null;
}

function seedDb(over: Partial<FakeDb> = {}): FakeDb {
  return {
    user: { id: UID },
    entitlementStatus: "legacy",
    memberships: [],
    workspaces: [],
    startups: [],
    failWorkspaceCreate: false,
    lastUpsert: null,
    ...over,
  };
}

// Purpose-built fake covering the save route's query shapes, including the
// prod NOT NULL constraint on startups.workspace_id (23502 on NULL).
class FQ {
  private filters: Array<{ col: string; val: unknown }> = [];
  private patch: Row | null = null;
  private rowsToInsert: Row[] | null = null;
  private isUpsert = false;
  private limitN: number | null = null;
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
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  insert(rows: Row | Row[]): this {
    this.rowsToInsert = (Array.isArray(rows) ? rows : [rows]).map((r) => ({
      ...r,
    }));
    return this;
  }
  upsert(row: Row, _opts?: unknown): this {
    this.rowsToInsert = [{ ...row }];
    this.isUpsert = true;
    return this;
  }
  private matched(): Row[] {
    let rows: Row[];
    if (this.table === "startups") rows = this.db.startups;
    else if (this.table === "workspace_members") rows = this.db.memberships;
    else if (this.table === "workspaces") rows = this.db.workspaces;
    else rows = [];
    return rows.filter((r) => this.filters.every((f) => r[f.col] === f.val));
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    if (this.table === "user_entitlements") {
      return { data: { status: this.db.entitlementStatus }, error: null };
    }
    return { data: this.matched()[0] ?? null, error: null };
  }
  async single(): Promise<{ data: Row | null; error: { message: string; code?: string } | null }> {
    if (this.rowsToInsert) {
      const row = this.rowsToInsert[this.rowsToInsert.length - 1];
      if (this.table === "startups") {
        this.db.lastUpsert = { ...row };
        // Prod enforces workspace_id NOT NULL (migration 0008).
        if (row.workspace_id == null) {
          this.rowsToInsert = null;
          return {
            data: null,
            error: {
              message:
                'null value in column "workspace_id" of relation "startups" violates not-null constraint',
              code: "23502",
            },
          };
        }
        this.db.startups.push({ ...row });
        this.rowsToInsert = null;
        return { data: { ...row }, error: null };
      }
      if (this.table === "workspaces") {
        if (this.db.failWorkspaceCreate) {
          this.rowsToInsert = null;
          return { data: null, error: { message: "insert failed" } };
        }
        const created = { id: WID, ...row };
        this.db.workspaces.push(created);
        this.rowsToInsert = null;
        return { data: created, error: null };
      }
    }
    const rows = this.matched();
    if (rows.length === 0) return { data: null, error: { message: "none" } };
    return { data: rows[0], error: null };
  }
  then(resolve: (v: { data: Row[] | null; error: null; count?: number }) => unknown): unknown {
    if (this.rowsToInsert) {
      if (this.table === "workspace_members") {
        for (const r of this.rowsToInsert) this.db.memberships.push({ ...r });
        this.rowsToInsert = null;
        return resolve({ data: [], error: null });
      }
      this.rowsToInsert = null;
      return resolve({ data: [], error: null });
    }
    if (this.patch) {
      const rows = this.matched();
      for (const r of rows) Object.assign(r, this.patch);
      return resolve({ data: rows, error: null });
    }
    let rows = this.matched();
    if (this.limitN != null) rows = rows.slice(0, this.limitN);
    // Head-count shape used by the trial gate.
    return resolve({ data: rows, error: null, count: rows.length });
  }
}

function wire(db: FakeDb): void {
  mockedClient.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: db.user } }) },
    from: (table: string) => new FQ(db, table),
  } as never);
  mockedService.mockReturnValue({
    from: (table: string) => new FQ(db, table),
    rpc: async () => ({ data: "ok", error: null }),
  } as never);
}

function saveReq(startup: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/startups/save", {
    method: "POST",
    body: JSON.stringify({ startup }),
  });
}

const NEW_STARTUP = {
  name: "Fresh idea",
  one_liner: "Test one liner",
  domain: "general",
  stage: "idea",
};

describe("POST /api/startups/save workspace_id", () => {
  beforeEach(() => vi.clearAllMocks());

  test("401 without user", async () => {
    const db = seedDb({ user: null });
    wire(db);
    const res = await savePOST(saveReq(NEW_STARTUP));
    expect(res.status).toBe(401);
  });

  test("403 for a workspace the caller is not a member of", async () => {
    const db = seedDb();
    wire(db);
    const res = await savePOST(saveReq({ ...NEW_STARTUP, workspace_id: WID }));
    expect(res.status).toBe(403);
  });

  test("absent workspace_id resolves a personal workspace (never 500)", async () => {
    const db = seedDb();
    wire(db);
    const res = await savePOST(saveReq(NEW_STARTUP));
    expect(res.status).toBe(200);
    expect(db.lastUpsert?.workspace_id).toBe(WID);
    const body = (await res.json()) as { startup: Row };
    expect(body.startup.workspace_id).toBe(WID);
  });

  test("workspace resolution failure fails closed (429), never 500", async () => {
    const db = seedDb({ failWorkspaceCreate: true });
    wire(db);
    const res = await savePOST(saveReq(NEW_STARTUP));
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(429);
  });
});
