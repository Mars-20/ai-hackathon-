import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
import {
  handleAssistantPost,
  handleDeleteConversation,
  handleGetMessages,
  handleGetPrefs,
  handleListConversations,
  handlePutPrefs,
  handleRenameConversation,
  type AssistantHttpContext,
} from "@/lib/assistant/http";
import { AssistantOutageError } from "@/lib/assistant/model";

const UID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CONV_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MSG_NEW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface Row {
  [k: string]: unknown;
}

interface FakeDb {
  conversations: Row[];
  messages: Row[];
  prefs: Row[];
  startups: Row[];
  evidence: Row[];
  memories: Row[];
  rpcImpl: (name: string, params: Row) => unknown;
  spent: Array<{ key: string; usd: number }>;
  quota: { used: number; max: number };
  rateLimited: boolean;
}

// Chainable fake covering exactly the query shapes http.ts uses.
class FQ {
  private filters: Array<{ col: string; val: unknown }> = [];
  private inFilter: { col: string; vals: unknown[] } | null = null;
  private orderBy: { col: string; asc: boolean } | null = null;
  private limitN: number | null = null;
  private ltFilter: { col: string; val: unknown } | null = null;
  private updatePatch: Row | null = null;
  private insertRows: Row[] | null = null;
  private isDelete = false;
  constructor(
    private db: FakeDb,
    private table: string
  ) {}
  select(): this {
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push({ col, val });
    return this;
  }
  in(col: string, vals: unknown[]): this {
    this.inFilter = { col, vals };
    return this;
  }
  lt(col: string, val: unknown): this {
    this.ltFilter = { col, val };
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderBy = { col, asc: opts?.ascending ?? true };
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  private rows(): Row[] {
    const src =
      this.table === "assistant_conversations"
        ? this.db.conversations
        : this.table === "assistant_messages"
          ? this.db.messages
          : this.table === "startups"
            ? this.db.startups
            : this.table === "evidence"
              ? this.db.evidence
              : this.table === "companion_memory"
                ? this.db.memories
                : this.db.prefs;
    let out = src.filter((r) =>
      this.filters.every((f) => r[f.col] === f.val)
    );
    if (this.inFilter) {
      out = out.filter((r) => this.inFilter!.vals.includes(r[this.inFilter!.col]));
    }
    if (this.ltFilter) {
      out = out.filter((r) => (r[this.ltFilter!.col] as string) < (this.ltFilter!.val as string));
    }
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      out = [...out].sort((a, b) =>
        asc
          ? String(a[col]).localeCompare(String(b[col]))
          : String(b[col]).localeCompare(String(a[col]))
      );
    }
    if (this.limitN !== null) out = out.slice(0, this.limitN);
    return out;
  }
  async maybeSingle(): Promise<{ data: Row | null; error: null }> {
    const rows = this.rows();
    return { data: rows[0] ?? null, error: null };
  }
  async single(): Promise<{ data: Row | null; error: { message: string } | null }> {
    const rows = this.rows();
    if (rows.length === 0) return { data: null, error: { message: "none" } };
    return { data: rows[0], error: null };
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
  upsert(row: Row): this {
    this.insertRows = [row];
    (this as unknown as { _upsert: boolean })._upsert = true;
    return this;
  }
  then(
    resolve: (v: { data: Row[] | null; error: null }) => unknown,
    reject?: (e: unknown) => unknown
  ): unknown {
    try {
      if (this.insertRows) {
        const src =
          this.table === "assistant_conversations"
            ? this.db.conversations
            : this.table === "assistant_messages"
              ? this.db.messages
              : this.db.prefs;
        for (const r of this.insertRows) {
          const isUpsert = (this as unknown as { _upsert?: boolean })._upsert;
          if (isUpsert) {
            const ix = src.findIndex(
              (x) => x.user_id === r.user_id || x.id === r.id
            );
            if (ix >= 0) src[ix] = { ...src[ix], ...r };
            else src.push({ ...r });
          } else {
            // Mirror the real unique(conversation_id, client_message_id):
            // a duplicate insert is a 23505, not a silent second row.
            if (
              this.table === "assistant_messages" &&
              src.some(
                (x) =>
                  x.conversation_id === r.conversation_id &&
                  x.client_message_id === r.client_message_id
              )
            ) {
              throw { code: "23505", message: "duplicate key value" };
            }
            src.push({ ...r });
          }
        }
        return resolve({ data: this.insertRows, error: null });
      }
      if (this.updatePatch) {
        const rows = this.rows();
        for (const r of rows) Object.assign(r, this.updatePatch);
        return resolve({ data: rows, error: null });
      }
      if (this.isDelete) {
        const rows = this.rows();
        const src =
          this.table === "assistant_conversations"
            ? this.db.conversations
            : this.table === "assistant_messages"
              ? this.db.messages
              : this.db.prefs;
        for (const r of rows) {
          const ix = src.indexOf(r);
          if (ix >= 0) src.splice(ix, 1);
          if (this.table === "assistant_conversations") {
            this.db.messages = this.db.messages.filter(
              (m) => m.conversation_id !== r.id
            );
          }
        }
        return resolve({ data: [], error: null });
      }
      return resolve({ data: this.rows(), error: null });
    } catch (e) {
      if (reject) return reject(e);
      throw e;
    }
  }
}

function makeCtx(over: Partial<FakeDb & { entitlement: unknown }> = {}): {
  ctx: AssistantHttpContext;
  db: FakeDb;
} {
  const db: FakeDb = {
    conversations: [],
    messages: [],
    prefs: [],
    startups: [],
    evidence: [],
    memories: [],
    rpcImpl: (name: string) => {
      if (name === "consume_assistant_message") {
        if (db.quota.used >= db.quota.max) {
          return [{ allowed: false, used: db.quota.used, remaining: 0 }];
        }
        db.quota.used += 1;
        return [{ allowed: true, used: db.quota.used, remaining: db.quota.max - db.quota.used }];
      }
      if (name === "refund_assistant_message") {
        db.quota.used = Math.max(0, db.quota.used - 1);
        return null;
      }
      throw new Error(`unknown rpc ${name}`);
    },
    spent: [],
    quota: { used: 0, max: 50 },
    rateLimited: false,
    ...over,
  };
  const client = {
    from: (table: string) => new FQ(db, table),
    rpc: async (name: string, params: Row) => {
      try {
        return { data: db.rpcImpl(name, params), error: null };
      } catch (e) {
        return { data: null, error: e };
      }
    },
  } as unknown as SupabaseClient;
  const ctx: AssistantHttpContext = {
    userId: UID,
    db: client,
    admin: client,
    entitlement: (over.entitlement as AssistantHttpContext["entitlement"]) ?? "subscribed",
    quotaMax: 50,
    nowMs: () => Date.parse("2026-10-07T12:00:00.000Z"),
    rate: async () =>
      db.rateLimited ? { limited: true, retryAfter: 30 } : { limited: false, retryAfter: 0 },
    modelCaller: async () => ({
      reply: "قرارك الأخير كان المتابعة.",
      citations: [],
      toolCalls: [],
      usage: [{ totalTokenCount: 100 }],
      dispatched: true,
    }),
    grounding: {
      compiled: async () => "",
      startups: async () => [],
    },
    tools: {
      saveMemory: async () => ({ id: "mem-1" }),
      createExperiment: async () => ({ id: "exp-1" }),
      updateExperiment: async () => ({ id: "exp-1" }),
      runValidation: async () => ({ startup_id: "s-1" }),
    },
    spend: async (key: string, usd: number) => {
      db.spent.push({ key, usd });
      return usd;
    },
  };
  return { ctx, db };
}

async function readSse(res: Response): Promise<string[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => b.replace(/^data: /, ""));
}

describe("assistant-chat handlers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("foreign-conversation-403: user B posting to A's thread gets FORBIDDEN", async () => {
    const { ctx, db } = makeCtx();
    db.conversations.push({
      id: CONV_A,
      user_id: UID,
      title: "A",
      created_at: "2026-10-07T10:00:00.000Z",
      updated_at: "2026-10-07T10:00:00.000Z",
    });
    const otherCtx: AssistantHttpContext = { ...ctx, userId: OTHER };
    const res = await handleAssistantPost(otherCtx, {
      conversation_id: CONV_A,
      client_message_id: MSG_NEW,
      message: "hi",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(db.quota.used).toBe(0);
  });

  it("idempotent-retry-same-client-id consumes one unit", async () => {
    const { ctx, db } = makeCtx();
    const body = { client_message_id: MSG_NEW, message: "مرحبا" };
    const first = await handleAssistantPost(ctx, body);
    expect(first.status).toBe(200);
    const events = await readSse(first);
    expect(events[events.length - 1]).toContain('"type":"done"');
    expect(db.quota.used).toBe(1);
    const again = await handleAssistantPost(ctx, body);
    expect(again.status).toBe(200);
    expect(db.quota.used).toBe(1);
    const againEvents = await readSse(again);
    expect(JSON.parse(againEvents[againEvents.length - 1]).deduped).toBe(true);
  });

  it("quota exhausted → 402 + plans_url", async () => {
    const { ctx } = makeCtx({ quota: { used: 50, max: 50 } });
    const res = await handleAssistantPost(ctx, {
      client_message_id: MSG_NEW,
      message: "hi",
    });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body).toMatchObject({
      code: "ASSISTANT_QUOTA_EXHAUSTED",
      plans_url: "/plans?reason=assistant_quota",
    });
    expect(typeof body.retryAfter).toBe("number");
    expect(res.headers.get("Retry-After")).toBe(String(body.retryAfter));
  });

  it("conversation-cap-409: thread at 200 messages rejects without consuming", async () => {
    const { ctx, db } = makeCtx();
    db.conversations.push({
      id: CONV_A,
      user_id: UID,
      title: "full",
      created_at: "2026-10-07T10:00:00.000Z",
      updated_at: "2026-10-07T10:00:00.000Z",
    });
    for (let i = 0; i < 200; i++) {
      db.messages.push({
        id: `m-${i}`,
        conversation_id: CONV_A,
        seq: i,
        client_message_id: `c-${i}`,
        role: i % 2 === 0 ? "user" : "assistant",
        content: "x",
        created_at: "2026-10-07T10:00:00.000Z",
      });
    }
    const res = await handleAssistantPost(ctx, {
      conversation_id: CONV_A,
      client_message_id: MSG_NEW,
      message: "one more",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "CONVERSATION_FULL" });
    expect(db.quota.used).toBe(0);
  });

  it("secret in user message → 422 without consuming quota", async () => {
    const { ctx, db } = makeCtx();
    const res = await handleAssistantPost(ctx, {
      client_message_id: MSG_NEW,
      message: "my key is sk-live-abc123XYZ456",
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "SECRET_BLOCKED" });
    expect(db.quota.used).toBe(0);
  });

  it("total provider outage → SSE error MODEL_UNAVAILABLE + refund", async () => {
    const { ctx, db } = makeCtx();
    ctx.modelCaller = async () => {
      throw new AssistantOutageError();
    };
    const res = await handleAssistantPost(ctx, {
      client_message_id: MSG_NEW,
      message: "hi",
    });
    expect(res.status).toBe(200);
    const events = (await readSse(res)).map((e) => JSON.parse(e));
    expect(events[events.length - 1]).toMatchObject({
      type: "error",
      code: "MODEL_UNAVAILABLE",
    });
    expect(db.quota.used).toBe(0);
  });

  it("retry after outage re-executes instead of echoing the question", async () => {
    const { ctx, db } = makeCtx();
    ctx.modelCaller = async () => {
      throw new AssistantOutageError();
    };
    const body = { client_message_id: MSG_NEW, message: "where is my data?" };
    const failed = await handleAssistantPost(ctx, body);
    expect(failed.status).toBe(200);
    expect(db.quota.used).toBe(0);
    ctx.modelCaller = async () => ({
      reply: "here is your data.",
      citations: [],
      toolCalls: [],
      usage: [{ totalTokenCount: 50 }],
      dispatched: true,
    });
    const retry = await handleAssistantPost(ctx, body);
    const events = (await readSse(retry)).map((e) => JSON.parse(e));
    const done = events[events.length - 1];
    // Fresh execution in the adopted thread (not a replay): no dedupe flag,
    // one quota unit, one conversation, delivered answer.
    expect(done.deduped).toBe(false);
    expect(events[0]).toMatchObject({ type: "token", text: "here is your data." });
    expect(db.quota.used).toBe(1);
    expect(db.conversations).toHaveLength(1);
    // The retry reuses the persisted question row — no duplicate insert
    // (the fake enforces unique(conversation_id, client_message_id) like
    // Postgres, so a re-insert would throw 23505 here).
    expect(
      db.messages.filter(
        (m) => m.role === "user" && m.client_message_id === MSG_NEW
      )
    ).toHaveLength(1);
  });

  it("critic passes grounded numeric replies, refuses invented ones", async () => {
    const sid = "33333333-3333-4333-8333-333333333333";
    const seed = (over: Partial<FakeDb> = {}) =>
      makeCtx({
        startups: [{ id: sid, owner_id: UID, name: "Acme", one_liner: "widgets" }],
        evidence: [
          {
            startup_id: sid,
            claim: "Acme landing page converts at 12 percent",
            source_url: "https://example.com/acme-study",
          },
        ],
        ...over,
      });
    const body = { client_message_id: MSG_NEW, message: "how does Acme convert?" };

    // Grounded: the 12% figure appears in owned evidence → streams as-is.
    {
      const { ctx } = seed();
      ctx.modelCaller = async () => ({
        reply: "Acme converts at 12 percent [E1].",
        citations: [],
        toolCalls: [],
        usage: [{ totalTokenCount: 10 }],
        dispatched: true,
      });
      const res = await handleAssistantPost(ctx, body);
      const text = (await readSse(res)).map((e) => JSON.parse(e));
      const tokens = text
        .filter((e) => e.type === "token")
        .map((e) => e.text)
        .join("");
      expect(tokens).toContain("12 percent");
      expect(tokens).not.toMatch(/can't find supporting data/);
    }
    // Invented: 87 terawatt-hours appears in no owned row and shares no
    // claim tokens with any of them → refusal replaces the draft.
    {
      const { ctx } = seed();
      ctx.modelCaller = async () => ({
        reply: "Bitcoin miners use 87 terawatt hours.",
        citations: [],
        toolCalls: [],
        usage: [{ totalTokenCount: 10 }],
        dispatched: true,
      });
      const res = await handleAssistantPost(
        { ...ctx, nowMs: ctx.nowMs },
        { client_message_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", message: "how does Acme convert?" }
      );
      const text = (await readSse(res)).map((e) => JSON.parse(e));
      const tokens = text
        .filter((e) => e.type === "token")
        .map((e) => e.text)
        .join("");
      expect(tokens).toMatch(/can't find supporting data/);
      expect(tokens).not.toContain("87 terawatt");
    }
  });

  it("critic accepts memory-backed replies citing [M1]", async () => {
    // Live regression (2026-10-07): a just-saved memory cited as [M1] was
    // critic-blocked because the critic's adapted rows excluded memories
    // entirely — saved memories could never be quoted back.
    const { ctx } = makeCtx({
      memories: [
        {
          user_id: UID,
          status: "approved",
          value: "Acme landing page converts at 12 percent",
        },
      ],
    });
    ctx.modelCaller = async () => ({
      reply: "Acme converts at 12 percent [M1].",
      citations: [],
      toolCalls: [],
      usage: [{ totalTokenCount: 10 }],
      dispatched: true,
    });
    const res = await handleAssistantPost(ctx, {
      client_message_id: MSG_NEW,
      message: "how does Acme convert?",
    });
    const text = (await readSse(res)).map((e) => JSON.parse(e));
    const tokens = text
      .filter((e) => e.type === "token")
      .map((e) => e.text)
      .join("");
    expect(tokens).toContain("12 percent");
    expect(tokens).not.toMatch(/can't find supporting data/);
  });

  it("tool SSE events carry redacted args per spec §5", async () => {
    const { ctx } = makeCtx();
    ctx.modelCaller = async () => ({
      reply: "Saved.",
      citations: [],
      toolCalls: [
        { name: "save_memory", args: { kind: "preference", value: "likes dark mode" } },
      ],
      usage: [{ totalTokenCount: 10 }],
      dispatched: true,
    });
    ctx.tools!.saveMemory = async () => ({ id: "mem-9" });
    const res = await handleAssistantPost(ctx, {
      client_message_id: MSG_NEW,
      message: "remember I like dark mode",
    });
    const events = (await readSse(res)).map((e) => JSON.parse(e));
    const tool = events.find((e) => e.type === "tool");
    expect(tool).toMatchObject({
      tool: "save_memory",
      args: { kind: "preference", value: "likes dark mode" },
    });
    expect(tool.result_summary).toContain("mem-9");
  });

  it("prefs PUT without active_conversation_id preserves the pinned thread", async () => {
    const { ctx, db } = makeCtx({
      prefs: [{ user_id: UID, float_enabled: false, active_conversation_id: CONV_A }],
    });
    const res = await handlePutPrefs(ctx, { float_enabled: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      float_enabled: true,
      active_conversation_id: CONV_A,
    });
    expect(db.prefs[0].active_conversation_id).toBe(CONV_A);
  });

  it("list/get/rename/delete are owner-scoped; prefs round-trip", async () => {
    const { ctx, db } = makeCtx();
    db.conversations.push(
      {
        id: CONV_A,
        user_id: UID,
        title: "mine",
        created_at: "2026-10-07T10:00:00.000Z",
        updated_at: "2026-10-07T11:00:00.000Z",
      },
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        user_id: OTHER,
        title: "theirs",
        created_at: "2026-10-07T10:00:00.000Z",
        updated_at: "2026-10-07T10:00:00.000Z",
      }
    );
    const list = await handleListConversations(ctx, { page: "1", limit: "20" });
    expect(await list.json()).toMatchObject({
      conversations: [{ id: CONV_A, title: "mine" }],
    });
    const otherCtx: AssistantHttpContext = { ...ctx, userId: OTHER };
    expect((await handleGetMessages(otherCtx, CONV_A, {})).status).toBe(403);
    expect((await handleRenameConversation(otherCtx, CONV_A, { title: "x" })).status).toBe(403);
    const renamed = await handleRenameConversation(ctx, CONV_A, { title: "renamed" });
    expect(renamed.status).toBe(200);
    expect(db.conversations[0].title).toBe("renamed");
    const badTitle = await handleRenameConversation(ctx, CONV_A, { title: "" });
    expect(badTitle.status).toBe(400);
    expect((await handleDeleteConversation(otherCtx, CONV_A)).status).toBe(403);
    const deleted = await handleDeleteConversation(ctx, CONV_A);
    expect(deleted.status).toBe(200);
    expect(db.conversations).toHaveLength(1);

    const prefs0 = await handleGetPrefs(ctx);
    expect(await prefs0.json()).toMatchObject({ float_enabled: false });
    const put = await handlePutPrefs(ctx, { float_enabled: true });
    expect(put.status).toBe(200);
    const prefs1 = await handleGetPrefs(ctx);
    expect(await prefs1.json()).toMatchObject({ float_enabled: true });
    const badPref = await handlePutPrefs(ctx, {
      float_enabled: true,
      active_conversation_id: "not-a-uuid",
    });
    expect(badPref.status).toBe(400);
  });

  it("rate-limited → 429 with Retry-After; trial-consumed → 402", async () => {
    const { ctx } = makeCtx();
    ctx.rate = async () => ({ limited: true, retryAfter: 30 });
    const rl = await handleAssistantPost(ctx, {
      client_message_id: MSG_NEW,
      message: "hi",
    });
    expect(rl.status).toBe(429);
    expect(rl.headers.get("Retry-After")).toBe("30");
    const { ctx: ctx2 } = makeCtx({ entitlement: "trial_consumed" });
    const gate = await handleAssistantPost(ctx2, {
      client_message_id: MSG_NEW,
      message: "hi",
    });
    expect(gate.status).toBe(402);
    expect(await gate.json()).toMatchObject({ code: "TRIAL_CONSUMED" });
  });
});
