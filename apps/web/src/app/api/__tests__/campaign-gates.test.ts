import { describe, test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { executeCampaignAction } from "../../../../../../packages/tools/campaign";

// Task 5 (TDD RED): campaign gates — unsubscribed blocks queue, daily send
// cap blocks the 101st, consent re-verified from DB (never trust the
// lead_has_consent flag), channel locked to email until license.
// L3 experiment approval-status itself is Task 6 — explicitly NOT covered here.

// ── In-memory PostgREST fake: supports the exact chains queue_message uses ──
interface LeadRow {
  id: string;
  unsubscribed: boolean;
  consent_given: boolean;
  consent_timestamp: string | null;
  consent_text: string | null;
}

interface MsgRow {
  id: string;
  lead_id: string;
  idempotency_key: string | null;
  created_at: string;
  sent_at: string | null;
}

function makeFakeDb(opts: { leads?: LeadRow[]; messages?: MsgRow[] } = {}) {
  const state = {
    leads: [...(opts.leads ?? [])],
    messages: [...(opts.messages ?? [])],
  };
  const applyFilters = (
    rows: Record<string, unknown>[],
    eq: Array<{ col: string; val: unknown }>,
    gte: Array<{ col: string; val: unknown }>,
  ) =>
    rows.filter(
      (r) =>
        eq.every((f) => r[f.col] === f.val) &&
        gte.every((f) => String(r[f.col] ?? "") >= String(f.val)),
    );
  const from = (table: string) => {
    const eq: Array<{ col: string; val: unknown }> = [];
    const gte: Array<{ col: string; val: unknown }> = [];
    const rows = () =>
      (table === "leads" ? state.leads : state.messages) as unknown as Record<string, unknown>[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q: any = {
      select: () => q,
      eq: (col: string, val: unknown) => {
        eq.push({ col, val });
        return q;
      },
      gte: (col: string, val: unknown) => {
        gte.push({ col, val });
        return q;
      },
      maybeSingle: async () => ({
        data: applyFilters(rows(), eq, gte)[0] ?? null,
        error: null,
      }),
      single: async () => {
        const row = applyFilters(rows(), eq, gte)[0];
        return row
          ? { data: row, error: null }
          : { data: null, error: { message: "none" } };
      },
      insert: (vals: Record<string, unknown>) => ({
        select: () => ({
          single: async () => {
            const row = {
              id: `msg-${state.messages.length + 1}`,
              created_at: new Date().toISOString(),
              ...vals,
            };
            (state.messages as unknown as Record<string, unknown>[]).push(row);
            return { data: row, error: null };
          },
        }),
      }),
      // Thenable so `await q` resolves like a PostgREST filter builder.
      then: (resolve: (v: unknown) => void) =>
        resolve({ data: applyFilters(rows(), eq, gte), error: null }),
    };
    return q;
  };
  return { from, state };
}

const GOOD_LEAD: LeadRow = {
  id: "lead-good",
  unsubscribed: false,
  consent_given: true,
  consent_timestamp: new Date().toISOString(),
  consent_text: "I agree to receive validation emails.",
};

function queuePayload(over: Record<string, unknown> = {}) {
  return {
    lead_id: GOOD_LEAD.id,
    lead_has_consent: true,
    channel: "email",
    template_type: "intro",
    sender_address: "founder@example.com",
    body_text: "Hello — reply or opt-out/unsubscribe here: https://example.com/unsub",
    ...over,
  };
}

describe("campaign gates (Task 5, mocked supabase)", () => {
  test("RED: unsubscribed lead blocks queue even with lead_has_consent flag", async () => {
    const db = makeFakeDb({
      leads: [{ ...GOOD_LEAD, id: "lead-unsub", unsubscribed: true }],
    });
    const res = await executeCampaignAction(
      "queue_message",
      queuePayload({ lead_id: "lead-unsub" }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
    );
    expect(res.success).toBe(false);
    expect(res.error ?? "").toMatch(/unsubscrib/i);
  });

  test("RED: send cap blocks the 101st message of the day", async () => {
    const now = new Date().toISOString();
    const db = makeFakeDb({
      leads: [GOOD_LEAD],
      messages: Array.from({ length: 100 }, (_, i) => ({
        id: `sent-${i}`,
        lead_id: GOOD_LEAD.id,
        idempotency_key: `k-${i}`,
        created_at: now,
        sent_at: now,
      })),
    });
    const res = await executeCampaignAction(
      "queue_message",
      queuePayload(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
    );
    expect(res.success).toBe(false);
    expect(res.error ?? "").toMatch(/cap/i);
  });

  test("RED: DB consent re-verified — flag true but DB consent false blocks", async () => {
    const db = makeFakeDb({
      leads: [
        {
          ...GOOD_LEAD,
          consent_given: false,
          consent_timestamp: null,
          consent_text: null,
        },
      ],
    });
    const res = await executeCampaignAction(
      "queue_message",
      queuePayload(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
    );
    expect(res.success).toBe(false);
    expect(res.error ?? "").toMatch(/consent/i);
  });

  test("RED: non-email channel blocked until license", async () => {
    const db = makeFakeDb({ leads: [GOOD_LEAD] });
    const res = await executeCampaignAction(
      "queue_message",
      queuePayload({ channel: "whatsapp" }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
    );
    expect(res.success).toBe(false);
    expect(res.error ?? "").toMatch(/email|license|channel/i);
  });

  test("GREEN control: subscribed + consented lead under cap queues", async () => {
    const db = makeFakeDb({ leads: [GOOD_LEAD] });
    const res = await executeCampaignAction(
      "queue_message",
      queuePayload(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db as any,
    );
    expect(res.success).toBe(true);
    expect(db.state.messages).toHaveLength(1);
  });
});

// ── Static assertions: companion tool changes (fail until implemented) ───────
// Repo root resolved from apps/web cwd (vitest runs with cwd=apps/web).
const repoRoot = path.resolve(process.cwd(), "..", "..");
const readSrc = (p: string) => fs.readFileSync(path.join(repoRoot, p), "utf8");

describe("task 5 companion tools (static)", () => {
  test("RED: campaign implements DAILY_SEND_CAP + unsubscribed gate", () => {
    const src = readSrc("packages/tools/campaign.ts");
    expect(src).toMatch(/DAILY_SEND_CAP/);
    expect(src).toMatch(/has unsubscribed/);
  });

  test("RED: fetch_page respects robots.txt", () => {
    const src = readSrc("packages/tools/fetch_page.ts");
    expect(src).toMatch(/robots\.txt/);
  });

  test("RED: save_artifact returns dashboard link + service_role path", () => {
    const src = readSrc("packages/tools/save_artifact.ts");
    expect(src).toMatch(/validate\?artifact=/);
    expect(src).toMatch(/service_role/i);
  });

  test("RED: prospect decision recorded — search-only, no auto-enroll", () => {
    const p = path.join(repoRoot, "packages/tools/prospect_search.ts");
    expect(fs.existsSync(p)).toBe(true);
    const src = fs.readFileSync(p, "utf8");
    expect(src).toMatch(/match_reason/);
    expect(src).toMatch(/prospects/);
    // Search-only: no enrollment/sequence capability (decision comment may
    // still name the downgraded scope in prose).
    expect(src).not.toMatch(/into sequences/i);
    expect(src).not.toMatch(/createSequence|startSequence|enrollLead|autoEnroll/i);
  });
});
