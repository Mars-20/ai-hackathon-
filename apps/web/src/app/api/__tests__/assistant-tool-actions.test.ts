import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));

import { handleToolAction } from "@/lib/assistant/http";
import type { AssistantHttpContext } from "@/lib/assistant/http";
import { shapeToolCard } from "@/lib/assistant/cards";

// Project C — interactive action cards: retry failed tools, confirm
// destructive tools before execution, undo additive tools.

const UID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CONV = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMO_ID = "69fa5f74-1a2b-4c3d-8e4f-69fa5f741a2b";
const EXP_ID = "dead10cc-5bee-4a11-9c22-feedface1234";
const STARTUP_ID = "55555555-5555-4355-8555-555555555555";
const M_FAIL_1 = "66666666-6666-4666-8666-666666666666";
const M_OK_1 = "77777777-7777-4777-8777-777777777777";
const M_FAIL_2 = "88888888-8888-4888-8888-888888888888";
const M_PROP_1 = "99999999-9999-4999-8999-999999999999";
const M_PROP_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc";
const M_OK_2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const M_OK_3 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const M_OK_4 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const M_OK_5 = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const M_FAIL_3 = "12345678-1234-4234-8234-1234567890ab";

interface Row {
  [k: string]: unknown;
}

interface FakeDb {
  conversations: Row[];
  messages: Row[];
  memories: Row[];
  experiments: Row[];
  startups: Row[];
  trace: Row[];
}

class FQ {
  private filters: Array<{ col: string; val: unknown }> = [];
  private updatePatch: Row | null = null;
  private insertRows: Row[] | null = null;
  private isDelete = false;
  constructor(
    private db: FakeDb,
    private table: string
  ) {}
  private src(): Row[] {
    switch (this.table) {
      case "assistant_conversations":
        return this.db.conversations;
      case "assistant_messages":
        return this.db.messages;
      case "companion_memory":
        return this.db.memories;
      case "experiments":
        return this.db.experiments;
      case "startups":
        return this.db.startups;
      default:
        return this.db.trace;
    }
  }
  select(): this {
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push({ col, val });
    return this;
  }
  order(): this {
    return this;
  }
  limit(): this {
    return this;
  }
  private rows(): Row[] {
    return this.src().filter((r) => this.filters.every((f) => r[f.col] === f.val));
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const rows = this.rows();
    return { data: rows[0] ?? null, error: null };
  }
  insert(rows: Row | Row[]): this {
    this.insertRows = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  update(patch: Row): this {
    this.updatePatch = patch;
    return this;
  }
  delete(): this {
    this.isDelete = true;
    return this;
  }
  then(resolve: (v: { data: Row[] | null; error: null }) => unknown): unknown {
    if (this.insertRows) {
      for (const r of this.insertRows) this.src().push({ ...r });
      return resolve({ data: this.insertRows, error: null });
    }
    if (this.updatePatch) {
      const rows = this.rows();
      for (const r of rows) Object.assign(r, this.updatePatch);
      return resolve({ data: rows, error: null });
    }
    if (this.isDelete) {
      const src = this.src();
      for (const r of this.rows()) {
        const ix = src.indexOf(r);
        if (ix >= 0) src.splice(ix, 1);
      }
      return resolve({ data: [], error: null });
    }
    return resolve({ data: this.rows(), error: null });
  }
}

function makeCtx(
  db: Partial<FakeDb>,
  tools?: AssistantHttpContext["tools"]
): { ctx: AssistantHttpContext; full: FakeDb } {
  const full: FakeDb = {
    conversations: [],
    messages: [],
    memories: [],
    experiments: [],
    startups: [],
    trace: [],
    ...db,
  };
  const client = {
    from: (table: string) => new FQ(full, table),
  } as unknown as SupabaseClient;
  const ctx: AssistantHttpContext = {
    userId: UID,
    db: client,
    admin: client,
    entitlement: "subscribed",
    quotaMax: 50,
    tools:
      tools ??
      ({} as unknown as NonNullable<AssistantHttpContext["tools"]>),
  };
  return { ctx, full };
}

function ownedConv(userId: string = UID): Row {
  return { id: CONV, user_id: userId, title: "t" };
}

async function body(res: Response): Promise<{ status: number; json: Row }> {
  return { status: res.status, json: (await res.json()) as Row };
}

describe("retry failed tool rows", () => {
  const failedSaveRow = (): Row => ({
    id: M_FAIL_1,
    conversation_id: CONV,
    role: "tool",
    content: "Action failed: boom — you can retry this action.",
    tool_name: "save_memory",
    tool_args: { kind: "fact", value: "HQ in Riyadh" },
  });

  it("re-executes a failed save_memory and persists a new success row (no quota)", async () => {
    const { ctx, full } = makeCtx(
      { conversations: [ownedConv()], messages: [failedSaveRow()] },
      {
        saveMemory: async () => ({ id: MEMO_ID }),
      } as unknown as NonNullable<AssistantHttpContext["tools"]>
    );
    const res = await handleToolAction(ctx, { action: "retry", message_id: M_FAIL_1 });
    const { status, json } = await body(res);
    expect(status).toBe(200);
    expect((json.card as Row).result_summary).toBe(`Saved to memory (${MEMO_ID})`);
    // New row appended; the failed row stays as audit history.
    expect(full.messages).toHaveLength(2);
    expect(full.trace.filter((t) => t.event_type === "tool_result")).toHaveLength(1);
  });

  it("rejects retry of a non-failed row with 409", async () => {
    const { ctx } = makeCtx({
      conversations: [ownedConv()],
      messages: [
        {
          id: M_OK_1,
          conversation_id: CONV,
          role: "tool",
          content: `Saved to memory (${MEMO_ID})`,
          tool_name: "save_memory",
          tool_args: { kind: "fact", value: "x" },
        },
      ],
    });
    const res = await handleToolAction(ctx, { action: "retry", message_id: M_OK_1 });
    expect(res.status).toBe(409);
  });

  it("rejects another user's row with 403", async () => {
    const { ctx } = makeCtx({
      conversations: [ownedConv(OTHER)],
      messages: [{ ...failedSaveRow(), conversation_id: CONV }],
    });
    const res = await handleToolAction(ctx, { action: "retry", message_id: M_FAIL_1 });
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown message id", async () => {
    const { ctx } = makeCtx({ conversations: [ownedConv()] });
    const res = await handleToolAction(ctx, { action: "retry", message_id: MEMO_ID });
    expect(res.status).toBe(404);
  });

  it("retry re-executes a confirmed-but-failed update_experiment without a second confirm", async () => {
    const { ctx } = makeCtx(
      {
        conversations: [ownedConv()],
        messages: [
          {
            id: M_FAIL_2,
            conversation_id: CONV,
            role: "tool",
            content: "Action failed: RPC down — you can retry this action.",
            tool_name: "update_experiment",
            tool_args: { experiment_id: EXP_ID, patch: { status: "running" } },
          },
        ],
      },
      {
        updateExperiment: async () => ({ id: EXP_ID }),
      } as unknown as NonNullable<AssistantHttpContext["tools"]>
    );
    const res = await handleToolAction(ctx, { action: "retry", message_id: M_FAIL_2 });
    const { status, json } = await body(res);
    expect(status).toBe(200);
    expect((json.card as Row).result_summary).toBe(`Experiment updated (${EXP_ID})`);
  });
});

describe("confirm destructive proposals", () => {
  const proposalRow = (): Row => ({
    id: M_PROP_1,
    conversation_id: CONV,
    role: "tool",
    content: "PROPOSED_ACTION: Update experiment to running",
    tool_name: "update_experiment",
    tool_args: { experiment_id: EXP_ID, patch: { status: "running" } },
  });

  it("executes a proposed update_experiment and resolves the proposal row in place", async () => {
    const { ctx, full } = makeCtx(
      { conversations: [ownedConv()], messages: [proposalRow()] },
      {
        updateExperiment: async () => ({ id: EXP_ID }),
      } as unknown as NonNullable<AssistantHttpContext["tools"]>
    );
    const res = await handleToolAction(ctx, { action: "confirm", message_id: M_PROP_1 });
    const { status, json } = await body(res);
    expect(status).toBe(200);
    expect((json.card as Row).result_summary).toBe(`Experiment updated (${EXP_ID})`);
    // Resolved in place: still exactly one row, prefix gone (idempotent by shape).
    expect(full.messages).toHaveLength(1);
    expect(String(full.messages[0].content).startsWith("PROPOSED_ACTION:")).toBe(false);
  });

  it("rejects confirm of a non-destructive tool with 422", async () => {
    const { ctx } = makeCtx({
      conversations: [ownedConv()],
      messages: [
        {
          id: M_PROP_2,
          conversation_id: CONV,
          role: "tool",
          content: "PROPOSED_ACTION: Save memory",
          tool_name: "save_memory",
          tool_args: { kind: "fact", value: "x" },
        },
      ],
    });
    const res = await handleToolAction(ctx, { action: "confirm", message_id: M_PROP_2 });
    expect(res.status).toBe(422);
  });

  it("second confirm of a resolved row is 409 (no double execution)", async () => {
    let calls = 0;
    const { ctx } = makeCtx(
      {
        conversations: [ownedConv()],
        messages: [{ ...proposalRow(), content: `Experiment updated (${EXP_ID})` }],
      },
      {
        updateExperiment: async () => {
          calls++;
          return { id: EXP_ID };
        },
      } as unknown as NonNullable<AssistantHttpContext["tools"]>
    );
    const res = await handleToolAction(ctx, { action: "confirm", message_id: M_PROP_1 });
    expect(res.status).toBe(409);
    expect(calls).toBe(0);
  });

  it("confirm validates stored args strictly (422 on tampered args)", async () => {
    const { ctx } = makeCtx({
      conversations: [ownedConv()],
      messages: [
        {
          ...proposalRow(),
          tool_args: { experiment_id: "not-a-uuid", patch: { status: "running" } },
        },
      ],
    });
    const res = await handleToolAction(ctx, { action: "confirm", message_id: M_PROP_1 });
    expect(res.status).toBe(422);
  });
});

describe("undo additive tools", () => {
  it("undo save_memory deletes the memory row and marks the card undone", async () => {
    const { ctx, full } = makeCtx({
      conversations: [ownedConv()],
      messages: [
        {
          id: M_OK_2,
          conversation_id: CONV,
          role: "tool",
          content: `Saved to memory (${MEMO_ID})`,
          tool_name: "save_memory",
          tool_args: { kind: "fact", value: "HQ in Riyadh" },
        },
      ],
      memories: [{ id: MEMO_ID, user_id: UID, value: "HQ in Riyadh", status: "approved" }],
    });
    const res = await handleToolAction(ctx, { action: "undo", message_id: M_OK_2 });
    const { status, json } = await body(res);
    expect(status).toBe(200);
    expect(json.undone).toBe(true);
    expect(full.memories).toHaveLength(0);
    expect(String(full.messages[0].content).endsWith(" (undone)")).toBe(true);
  });

  it("undo save_memory never touches another user's memory", async () => {
    const { ctx, full } = makeCtx({
      conversations: [ownedConv()],
      messages: [
        {
          id: M_OK_3,
          conversation_id: CONV,
          role: "tool",
          content: `Saved to memory (${MEMO_ID})`,
          tool_name: "save_memory",
          tool_args: { kind: "fact", value: "x" },
        },
      ],
      memories: [{ id: MEMO_ID, user_id: OTHER, value: "x", status: "approved" }],
    });
    const res = await handleToolAction(ctx, { action: "undo", message_id: M_OK_3 });
    expect(res.status).toBe(404);
    expect(full.memories).toHaveLength(1);
  });

  it("undo create_experiment deletes a still-draft owned experiment", async () => {
    const { ctx, full } = makeCtx({
      conversations: [ownedConv()],
      messages: [
        {
          id: M_OK_4,
          conversation_id: CONV,
          role: "tool",
          content: `Experiment created (${EXP_ID})`,
          tool_name: "create_experiment",
          tool_args: { startup_id: STARTUP_ID, type: "interview", design: {} },
        },
      ],
      startups: [{ id: STARTUP_ID, owner_id: UID, workspace_id: null }],
      experiments: [{ id: EXP_ID, startup_id: STARTUP_ID, status: "draft" }],
    });
    const res = await handleToolAction(ctx, { action: "undo", message_id: M_OK_4 });
    const { status, json } = await body(res);
    expect(status).toBe(200);
    expect(json.undone).toBe(true);
    expect(full.experiments).toHaveLength(0);
  });

  it("undo create_experiment refuses a non-draft experiment with 409", async () => {
    const { ctx, full } = makeCtx({
      conversations: [ownedConv()],
      messages: [
        {
          id: M_OK_5,
          conversation_id: CONV,
          role: "tool",
          content: `Experiment created (${EXP_ID})`,
          tool_name: "create_experiment",
          tool_args: { startup_id: STARTUP_ID, type: "interview", design: {} },
        },
      ],
      startups: [{ id: STARTUP_ID, owner_id: UID, workspace_id: null }],
      experiments: [{ id: EXP_ID, startup_id: STARTUP_ID, status: "running" }],
    });
    const res = await handleToolAction(ctx, { action: "undo", message_id: M_OK_5 });
    expect(res.status).toBe(409);
    expect(full.experiments).toHaveLength(1);
  });

  it("undo of a failed row is 409 (nothing to revert)", async () => {
    const { ctx } = makeCtx({
      conversations: [ownedConv()],
      messages: [
        {
          id: M_FAIL_3,
          conversation_id: CONV,
          role: "tool",
          content: "Action failed: boom — you can retry this action.",
          tool_name: "save_memory",
          tool_args: { kind: "fact", value: "x" },
        },
      ],
    });
    const res = await handleToolAction(ctx, { action: "undo", message_id: M_FAIL_3 });
    expect(res.status).toBe(409);
  });
});

describe("proposal/undone card shaping (client)", () => {
  it("shapeToolCard strips the proposal prefix and flags needsConfirm", () => {
    const card = shapeToolCard("update_experiment", "PROPOSED_ACTION: Update experiment to running");
    expect(card.result_summary).toBe("Update experiment to running");
    expect(card.needsConfirm).toBe(true);
  });

  it("shapeToolCard flags the undone suffix", () => {
    const card = shapeToolCard("save_memory", `Saved to memory (${MEMO_ID}) (undone)`);
    expect(card.undone).toBe(true);
  });

  it("plain success rows carry no flags", () => {
    const card = shapeToolCard("save_memory", `Saved to memory (${MEMO_ID})`);
    expect(card.needsConfirm).toBeUndefined();
    expect(card.undone).toBeUndefined();
  });
});
