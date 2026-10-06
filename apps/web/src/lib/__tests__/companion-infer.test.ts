import { describe, expect, it, vi, beforeEach } from "vitest";
import { flagPossibleConflicts } from "../companion/ranker";
import type { ProposeRow, ProposeResult } from "../companion/dal";
import { incrBudgetAtomic } from "../companion/redis";
import {
  INFER_DAILY_LIMIT,
  buildExtractionPrompt,
  dedupeAgainstApproved,
  filterExtractionCandidates,
  parseExtractionResult,
  runPostSessionInference,
} from "../companion/infer";

vi.mock("../companion/redis", () => ({ incrBudgetAtomic: vi.fn() }));

const mockedIncr = vi.mocked(incrBudgetAtomic);

beforeEach(() => {
  mockedIncr.mockReset();
});

// ---------------------------------------------------------------------------
// N=30 rubric fixture set (mirrored in docs/superpowers/rubric/companion-infer-rubric.md).
// Each fixture: raw LLM JSON -> parse -> secret/PII/dupe filter chain.
// expect = values that must survive; secret-bearing candidates must NEVER survive.
// ---------------------------------------------------------------------------
interface Fixture {
  name: string;
  json: string;
  approved: string[];
  email: string;
  expect: string[];
}

const LONG_VALUE = "x".repeat(501);

const FIXTURES: Fixture[] = [
  { name: "keep-preference", json: `[{"kind":"preference","value":"يفضل الاجتماعات صباحا","confidence":0.9}]`, approved: [], email: "owner@x.com", expect: ["يفضل الاجتماعات صباحا"] },
  { name: "keep-fact", json: `[{"kind":"fact","value":"المقر الرئيسي في الرياض","confidence":0.85}]`, approved: [], email: "owner@x.com", expect: ["المقر الرئيسي في الرياض"] },
  { name: "keep-constraint", json: `[{"kind":"preference","value":"لا يعمل أيام الجمعة","confidence":0.8}]`, approved: [], email: "owner@x.com", expect: ["لا يعمل أيام الجمعة"] },
  { name: "keep-episode", json: `[{"kind":"episode","value":"أطلقنا النسخة التجريبية في مارس","confidence":0.75}]`, approved: [], email: "owner@x.com", expect: ["أطلقنا النسخة التجريبية في مارس"] },
  { name: "threshold-edge-keep", json: `[{"kind":"fact","value":"الفريق خمسة أشخاص","confidence":0.7}]`, approved: [], email: "owner@x.com", expect: ["الفريق خمسة أشخاص"] },
  { name: "threshold-drop", json: `[{"kind":"fact","value":"تخمين ضعيف","confidence":0.62}]`, approved: [], email: "owner@x.com", expect: [] },
  { name: "threshold-drop-low", json: `[{"kind":"fact","value":"تخمين أضعف","confidence":0.3}]`, approved: [], email: "owner@x.com", expect: [] },
  { name: "secret-sk", json: `[{"kind":"fact","value":"المفتاح sk-live-abc123XYZ","confidence":0.95}]`, approved: [], email: "owner@x.com", expect: [] },
  { name: "secret-aws", json: `[{"kind":"fact","value":"استخدم AKIAIOSFODNN7EXAMPLE للنشر","confidence":0.95}]`, approved: [], email: "owner@x.com", expect: [] },
  { name: "secret-private-key", json: `[{"kind":"fact","value":"الشهادة -----BEGIN PRIVATE KEY----- سرية","confidence":0.95}]`, approved: [], email: "owner@x.com", expect: [] },
  { name: "secret-github", json: `[{"kind":"fact","value":"التوكن ghp_1234567890abcdef1234567890abcdef1234","confidence":0.95}]`, approved: [], email: "owner@x.com", expect: [] },
  { name: "pii-third-party-email", json: `[{"kind":"fact","value":"تواصل مع sara@example.com للمتابعة","confidence":0.9}]`, approved: [], email: "owner@x.com", expect: [] },
  { name: "pii-phone", json: `[{"kind":"fact","value":"رقم المورد 0551234567","confidence":0.9}]`, approved: [], email: "owner@x.com", expect: [] },
  { name: "self-email-kept", json: `[{"kind":"fact","value":"راسلني على owner@x.com","confidence":0.9}]`, approved: [], email: "owner@x.com", expect: ["راسلني على owner@x.com"] },
  { name: "dupe-approved-exact", json: `[{"kind":"preference","value":"يفضل الاجتماعات صباحا","confidence":0.9}]`, approved: ["يفضل الاجتماعات صباحا"], email: "owner@x.com", expect: [] },
  { name: "dupe-approved-normalized", json: `[{"kind":"preference","value":"يفضل الاجتماعات صباحا","confidence":0.9}]`, approved: ["يفضل الاجتماعات صباحاً"], email: "owner@x.com", expect: [] },
  { name: "near-miss-kept", json: `[{"kind":"preference","value":"يفضل الاجتماعات صباحا يوم الأحد","confidence":0.88}]`, approved: ["يفضل الاجتماعات صباحا"], email: "owner@x.com", expect: ["يفضل الاجتماعات صباحا يوم الأحد"] },
  { name: "within-batch-dupe", json: `[{"kind":"fact","value":"المقر في جدة","confidence":0.9},{"kind":"fact","value":"المقر في جدة","confidence":0.85}]`, approved: [], email: "owner@x.com", expect: ["المقر في جدة"] },
  { name: "malformed-nonjson", json: `hello world`, approved: [], email: "owner@x.com", expect: [] },
  { name: "malformed-not-array", json: `{"kind":"fact","value":"x","confidence":0.9}`, approved: [], email: "owner@x.com", expect: [] },
  { name: "malformed-missing-kind", json: `[{"value":"بلا نوع","confidence":0.9}]`, approved: [], email: "owner@x.com", expect: [] },
  { name: "malformed-missing-value", json: `[{"kind":"fact","confidence":0.9}]`, approved: [], email: "owner@x.com", expect: [] },
  { name: "malformed-bad-kind", json: `[{"kind":"secret","value":"نوع مرفوض","confidence":0.9}]`, approved: [], email: "owner@x.com", expect: [] },
  { name: "malformed-confidence-string", json: `[{"kind":"fact","value":"ثقة نصية","confidence":"high"}]`, approved: [], email: "owner@x.com", expect: [] },
  { name: "malformed-empty-value", json: `[{"kind":"fact","value":"   ","confidence":0.9}]`, approved: [], email: "owner@x.com", expect: [] },
  { name: "malformed-overlong", json: `[{"kind":"fact","value":"${LONG_VALUE}","confidence":0.9}]`, approved: [], email: "owner@x.com", expect: [] },
  { name: "fenced-json", json: "```json\n[{\"kind\":\"fact\",\"value\":\"التوسع في مصر\",\"confidence\":0.82}]\n```", approved: [], email: "owner@x.com", expect: ["التوسع في مصر"] },
  { name: "mixed-batch", json: `[{"kind":"fact","value":"الشريك اسمه كريم","confidence":0.9},{"kind":"fact","value":"تخمين","confidence":0.62},{"kind":"fact","value":"sk-live-abc123XYZ","confidence":0.95}]`, approved: [], email: "owner@x.com", expect: ["الشريك اسمه كريم"] },
  { name: "multi-keep", json: `[{"kind":"preference","value":"يفضل الدفع المسبق","confidence":0.9},{"kind":"fact","value":"الحد الأقصى عشرة موظفين","confidence":0.8}]`, approved: [], email: "owner@x.com", expect: ["يفضل الدفع المسبق", "الحد الأقصى عشرة موظفين"] },
  { name: "conflict-near-miss-kept", json: `[{"kind":"fact","value":"ميزانية المشروع 8000 ريال","confidence":0.88}]`, approved: ["ميزانية المشروع 5000 ريال"], email: "owner@x.com", expect: ["ميزانية المشروع 8000 ريال"] },
];

const SECRET_MARKERS = ["sk-live", "AKIA", "BEGIN PRIVATE", "ghp_"];

describe("companion inference rubric (N=30, bar >=24, zero secret flags)", () => {
  it("has exactly 30 fixtures", () => {
    expect(FIXTURES).toHaveLength(30);
  });

  it("passes the >=80% bar with zero secret leaks", () => {
    let pass = 0;
    for (const f of FIXTURES) {
      const kept = filterExtractionCandidates(parseExtractionResult(f.json), {
        userEmail: f.email,
        approvedValues: f.approved,
      }).map((c) => c.value);
      if (JSON.stringify(kept) === JSON.stringify(f.expect)) pass++;
      for (const v of kept) {
        for (const m of SECRET_MARKERS) expect(v).not.toContain(m);
      }
    }
    expect(pass).toBeGreaterThanOrEqual(24);
  });
});

describe("buildExtractionPrompt", () => {
  it("embeds memo + startup and demands strict JSON with confidence", () => {
    const p = buildExtractionPrompt("المذكرة التجريبية", "متجر نورة");
    expect(p).toContain("المذكرة التجريبية");
    expect(p).toContain("متجر نورة");
    expect(p).toContain("confidence");
    expect(p).toContain("JSON");
  });
});

describe("parseExtractionResult", () => {
  it("keeps 0.7 exactly and drops malformed without throwing", () => {
    expect(parseExtractionResult("nope")).toEqual([]);
    expect(parseExtractionResult(`[{"kind":"fact","value":"ok","confidence":0.7}]`)).toHaveLength(1);
    expect(parseExtractionResult(`[{"kind":"fact","value":"  padded  ","confidence":0.9}]`)[0].value).toBe("padded");
    expect(parseExtractionResult(`[{"kind":"goal","value":"خارج المفردات","confidence":0.9}]`)).toEqual([]);
  });
});

describe("dedupeAgainstApproved", () => {
  it("suppresses normalized dupes and keeps near-misses", () => {
    const cands = [
      { kind: "preference", value: "يفضل الاجتماعات صباحا", confidence: 0.9 },
      { kind: "preference", value: "يفضل الاجتماعات صباحا يوم الأحد", confidence: 0.88 },
    ];
    const out = dedupeAgainstApproved(cands, ["يفضل الاجتماعات صباحاً"]);
    expect(out.map((c) => c.value)).toEqual(["يفضل الاجتماعات صباحا يوم الأحد"]);
  });
});

describe("runPostSessionInference", () => {
  const base = {
    userId: "u1",
    userEmail: "owner@x.com",
    memoText: "memo",
    startupName: "s",
    approvedValues: [] as string[],
  };
  const canned = (text: string) => async () => ({ text, usage: { totalTokenCount: 123 } });

  it("skips over-cap without calling the model (spend-first-drop-later)", async () => {
    mockedIncr.mockResolvedValue(51);
    const callAI = vi.fn(canned(`[]`));
    const propose = vi.fn();
    const out = await runPostSessionInference({ ...base, callAI, propose });
    expect(out).toEqual({ skipped: "over-cap" });
    expect(callAI).not.toHaveBeenCalled();
    expect(INFER_DAILY_LIMIT).toBe(50);
  });

  it("skips on Redis outage without calling the model", async () => {
    mockedIncr.mockRejectedValue(new Error("boom"));
    const callAI = vi.fn(canned(`[]`));
    const out = await runPostSessionInference({ ...base, callAI, propose: vi.fn() });
    expect(out).toEqual({ skipped: "redis" });
    expect(callAI).not.toHaveBeenCalled();
  });

  it("skips when disabled without touching budget", async () => {
    const out = await runPostSessionInference({
      ...base,
      isEnabled: false,
      callAI: canned(`[]`),
      propose: vi.fn(),
    });
    expect(out).toEqual({ skipped: "disabled" });
    expect(mockedIncr).not.toHaveBeenCalled();
  });

  it("proposes parsed+filtered rows and returns usage (mocked model)", async () => {
    mockedIncr.mockResolvedValue(1);
    const text = `[{"kind":"preference","value":"يفضل الدفع المسبق","confidence":0.9},{"kind":"fact","value":"تخمين","confidence":0.62},{"kind":"fact","value":"sk-live-abc123XYZ","confidence":0.95}]`;
    const propose = vi.fn<(rows: ProposeRow[]) => Promise<ProposeResult>>(async () => ({
      results: [{ index: 0, ok: true, code: "OK", id: "m1" }],
      dropped: [],
    }));
    const out = await runPostSessionInference({ ...base, callAI: canned(text), propose });
    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose.mock.calls[0][0]).toEqual([
      { kind: "preference", value: "يفضل الدفع المسبق", confidence: 0.9, source_ref: "post-session" },
    ]);
    expect(out).toEqual({
      proposed: { results: [{ index: 0, ok: true, code: "OK", id: "m1" }], dropped: [] },
      usage: { totalTokenCount: 123 },
    });
  });

  it("skips the propose RPC when every candidate is filtered", async () => {
    mockedIncr.mockResolvedValue(2);
    const propose = vi.fn();
    const out = await runPostSessionInference({
      ...base,
      callAI: canned(`[{"kind":"fact","value":"sk-live-abc123XYZ","confidence":0.95}]`),
      propose,
    });
    expect(propose).not.toHaveBeenCalled();
    expect(out).toEqual({ proposed: { results: [], dropped: [] }, usage: { totalTokenCount: 123 } });
  });

  it("returns usage with proposeError when the propose step fails (review #9)", async () => {
    mockedIncr.mockResolvedValue(3);
    const propose = vi.fn(async () => {
      throw new Error("MEMORY_FULL at RPC");
    });
    const out = await runPostSessionInference({
      ...base,
      callAI: canned(`[{"kind":"fact","value":"يستيقظ مبكرا","confidence":0.9}]`),
      propose,
    });
    expect(propose).toHaveBeenCalledTimes(1);
    expect(out).toEqual({
      proposed: { results: [], dropped: [] },
      usage: { totalTokenCount: 123 },
      proposeError: "MEMORY_FULL at RPC",
    });
  });
  it("keeps near-miss conflicts for propose (Task 7 flags them at decide time)", () => {
    const kept = filterExtractionCandidates(
      parseExtractionResult(`[{"kind":"fact","value":"ميزانية المشروع 8000 ريال","confidence":0.88}]`),
      { userEmail: "owner@x.com", approvedValues: ["ميزانية المشروع 5000 ريال"] },
    );
    expect(kept).toHaveLength(1);
    const flags = flagPossibleConflicts(
      [{ id: "c0", kind: "fact", value: kept[0].value, created_at: new Date(0).toISOString() }],
      [{ id: "a1", kind: "fact", value: "ميزانية المشروع 5000 ريال", created_at: new Date(0).toISOString() }],
    );
    expect(flags.size).toBeGreaterThan(0);
  });
});
