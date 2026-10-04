import { describe, test, expect } from "vitest";
import {
  meetsGoThreshold,
  deriveConfidence,
  validateQuestion,
  normalizeSourceUrl,
  isBudgetExceeded,
  combineVerifierWithMemoScan,
  GO_THRESHOLD,
  BUDGET,
} from "@/lib/utils";

describe("meetsGoThreshold (Gate 1)", () => {
  test("thin opinion → ineligible", () => {
    const r = meetsGoThreshold([{ strength: "opinion", sample_size: 1 }]);
    expect(r.eligible).toBe(false);
  });

  test("rung4 x3 n>=30 → eligible", () => {
    const perSource = Math.ceil(
      GO_THRESHOLD.MIN_SAMPLE_QUANT / GO_THRESHOLD.MIN_INDEPENDENT_SOURCES
    );
    const evidence = Array.from({ length: GO_THRESHOLD.MIN_INDEPENDENT_SOURCES }, () => ({
      strength: "contact_shared" as const,
      sample_size: perSource,
    }));
    const r = meetsGoThreshold(evidence);
    expect(r.eligible).toBe(true);
  });
});

describe("validateQuestion (leading EN+AR rejected)", () => {
  test("leading EN rejected", () => {
    const r = validateQuestion("Don't you think our product is amazing?");
    expect(r.isLeading).toBe(true);
    expect(r.approved).toBe(false);
  });

  test("leading AR rejected", () => {
    const r = validateQuestion("أليس صحيح أن هذا المنتج مفيد؟");
    expect(r.isLeading).toBe(true);
    expect(r.approved).toBe(false);
  });

  test("open past-behavior question approved", () => {
    const r = validateQuestion("Tell me about the last time you tried to solve billing?");
    expect(r.approved).toBe(true);
  });
});

describe("deriveConfidence", () => {
  test("high: rung5 x3 with n>=quant", () => {
    const perSource = Math.ceil(
      GO_THRESHOLD.MIN_SAMPLE_QUANT / GO_THRESHOLD.MIN_INDEPENDENT_SOURCES
    );
    const evidence = Array.from({ length: GO_THRESHOLD.MIN_INDEPENDENT_SOURCES }, () => ({
      strength: "commitment" as const,
      sample_size: perSource,
    }));
    expect(deriveConfidence(evidence)).toBe("high");
  });

  test("medium: rung4 x3 interviews with n>=interviews floor", () => {
    const perSource = Math.ceil(
      GO_THRESHOLD.MIN_INTERVIEWS_SATURATED / GO_THRESHOLD.MIN_INDEPENDENT_SOURCES
    );
    const evidence = Array.from({ length: GO_THRESHOLD.MIN_INDEPENDENT_SOURCES }, () => ({
      strength: "contact_shared" as const,
      sample_size: perSource,
      source_type: "interview" as const,
    }));
    expect(deriveConfidence(evidence)).toBe("medium");
  });

  test("not medium: rung4 x3 survey-only never counts as interview depth", () => {
    const evidence = Array.from({ length: GO_THRESHOLD.MIN_INDEPENDENT_SOURCES }, () => ({
      strength: "contact_shared" as const,
      sample_size: GO_THRESHOLD.MIN_INTERVIEWS_SATURATED,
      source_type: "survey" as const,
    }));
    expect(deriveConfidence(evidence)).not.toBe("medium");
  });

  test("low: thin opinion", () => {
    expect(deriveConfidence([{ strength: "opinion", sample_size: 1 }])).toBe("low");
  });
});

describe("skills fixes (Task 4)", () => {
  test("Would you pay rejected", () => {
    expect(validateQuestion("Would you pay 20 dollars per month for this?").approved).toBe(false);
  });
  test("utm variants collapse", () => {
    expect(normalizeSourceUrl("https://example.com/r/?utm_source=x")).toBe(normalizeSourceUrl("https://example.com/r/"));
  });
  test("same-URL x3 never medium", () => {
    const ev = [1,2,3].map(() => ({ strength: "contact_shared" as const, sample_size: 4, source_type: "interview" as const, source_url: "https://x.test/r" }));
    expect(meetsGoThreshold(ev).eligible).toBe(false);
    expect(deriveConfidence(ev)).toBe("low");
  });
  test("rung4 padding never high", () => {
    const ev = [{ strength: "commitment" as const, sample_size: 2, source_url: "https://a.test" },{ strength: "commitment" as const, sample_size: 2, source_url: "https://b.test" },{ strength: "commitment" as const, sample_size: 2, source_url: "https://c.test" },{ strength: "contact_shared" as const, sample_size: 30, source_url: "https://d.test" }];
    expect(deriveConfidence(ev)).not.toBe("high");
  });
});

describe("isBudgetExceeded", () => {
  test("exceeded at cost cap", () => {
    expect(isBudgetExceeded(BUDGET.MAX_COST_USD, 0)).toBe(true);
  });

  test("exceeded at tool-call cap", () => {
    expect(isBudgetExceeded(0, BUDGET.MAX_TOOL_CALLS)).toBe(true);
  });

  test("not exceeded below both caps", () => {
    expect(isBudgetExceeded(BUDGET.MAX_COST_USD - 0.1, BUDGET.MAX_TOOL_CALLS - 1)).toBe(false);
  });
});

describe("combineVerifierWithMemoScan (post-memo rescan)", () => {
  const ev = [{ claim: "pilot cohort retention", source_url: "https://x.test/pilot" }];
  test("clean memo returns verifier unchanged", () => {
    const v = { approved: true, unsupportedClaims: [] as string[] };
    expect(combineVerifierWithMemoScan(v, "Evidence evaluated, more interviews needed", ev)).toBe(v);
  });
  test("memo-introduced figure forces disapproval + union", () => {
    const v = { approved: true, unsupportedClaims: [] as string[] };
    const out = combineVerifierWithMemoScan(v, "The market is worth $5B and growing fast", ev);
    expect(out.approved).toBe(false);
    expect(out.unsupportedClaims.length).toBeGreaterThan(0);
  });
  test("no duplicate lines when memo repeats planner flag", () => {
    const v = { approved: false, unsupportedClaims: ["Market is worth $5B"] };
    const out = combineVerifierWithMemoScan(v, "Market is worth $5B", ev);
    expect(out.unsupportedClaims).toEqual(["Market is worth $5B"]);
  });
});
