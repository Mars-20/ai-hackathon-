import { describe, test, expect } from "vitest";
import {
  normalizeVerdict,
  shouldRunInvestorReadiness,
  buildIcpSummary,
  buildMarketCtx,
  marketBlock,
  fallbackIcpProfile,
  parseIcpProfile,
  parseInvestorScorecard,
  sliceTraceForPersist,
} from "@/lib/skills-helpers";
import type { IcpProfile, TraceEvent } from "@/lib/types";

const ICP: IcpProfile = {
  role_title: "Head of Operations",
  context: "Series A Egyptian B2B SaaS, 50-500 staff",
  pain: "client feedback scattered across WhatsApp",
  workaround: "Excel + WhatsApp",
  buying_authority: "owns a tools budget",
  tam: { value: "$2.1B MENA ops software" },
  sam: { value: "2,340 Egyptian firms" },
  som: { value: "234 firms Y1", basis: "10% outreach capacity" },
  preliminary: true,
};

describe("normalizeVerdict", () => {
  test.each([
    ["go", "go"], ["Go", "go"], [" GO ", "go"], ["iterate", "iterate"],
    ["STOP", "stop"], ["test_more", "test_more"], ["Test More", null],
    ["", null], [null, null], [undefined, null], [42, null],
  ])("normalizeVerdict(%j) → %j", (input, expected) => {
    expect(normalizeVerdict(input)).toBe(expected);
  });
});

describe("shouldRunInvestorReadiness", () => {
  test.each([["go", true], ["Go", true], ["iterate", true], ["stop", false], ["test_more", false], ["garbage", false], [null, false]])(
    "%j → %j", (v, expected) => expect(shouldRunInvestorReadiness(v)).toBe(expected),
  );
});

describe("builders + caps", () => {
  test("buildIcpSummary ≤300 chars and contains role + SOM", () => {
    const s = buildIcpSummary(ICP);
    expect(s.length).toBeLessThanOrEqual(300);
    expect(s).toContain("Head of Operations");
    expect(s).toContain("234 firms Y1");
  });
  test("buildMarketCtx ≤800 chars, synthesis-only", () => {
    const m = buildMarketCtx(
      { tam: ICP.tam, sam: ICP.sam, som: ICP.som },
      "ops heads in Egyptian SaaS",
    );
    expect(m.length).toBeLessThanOrEqual(800);
    expect(m).toContain("$2.1B");
  });
  test("marketBlock empty → empty; non-empty → MARKET block", () => {
    expect(marketBlock("")).toBe("");
    expect(marketBlock("TAM: $2.1B")).toContain("MARKET:");
  });
  test("marketBlock wraps content as untrusted (prompt-injection hardening)", () => {
    expect(marketBlock("TAM: $2.1B")).toContain("<untrusted>TAM: $2.1B</untrusted>");
  });
  test("buildMarketCtx tolerates partial synthesis (no throw, degrades to known parts)", () => {
    const partial = { tam: undefined, sam: { value: "2,340 firms" }, som: undefined };
    expect(buildMarketCtx(partial as unknown as Parameters<typeof buildMarketCtx>[0], "ops heads")).toContain("2,340 firms");
    expect(buildMarketCtx({} as unknown as Parameters<typeof buildMarketCtx>[0], "ops heads")).toBe("");
  });
});

describe("parsers are fail-soft", () => {
  test("parseIcpProfile valid → profile; garbage → null", () => {
    expect(parseIcpProfile(JSON.stringify({ ...ICP, extra: 1 }))?.role_title).toBe("Head of Operations");
    expect(parseIcpProfile("not json{{")).toBeNull();
    expect(parseIcpProfile(JSON.stringify({ role_title: 42 }))).toBeNull();
  });
  test("parseIcpProfile tolerates fenced JSON (Groq fallback wraps in ```json)", () => {
    const fenced = "```json\n" + JSON.stringify(ICP) + "\n```";
    expect(parseIcpProfile(fenced)?.role_title).toBe("Head of Operations");
    expect(parseIcpProfile("Here is the profile:\n" + JSON.stringify(ICP))?.role_title).toBe("Head of Operations");
  });
  test("parseInvestorScorecard clamps + whitelists", () => {
    const good = parseInvestorScorecard(JSON.stringify({
      signals: [{ key: "team", score_1_10: 99, note: "strong" }, { key: "bogus", score_1_10: 5, note: "x" }],
      overall_1_10: -3, verdict_fit: "fundable", top_gaps: ["traction"],
    }));
    expect(good?.signals).toHaveLength(1);
    expect(good?.signals[0].score_1_10).toBe(10);
    expect(good?.overall_1_10).toBe(1);
    expect(parseInvestorScorecard("{{bad")).toBeNull();
    expect(parseInvestorScorecard(JSON.stringify({ verdict_fit: "maybe" }))).toBeNull();
    const fenced = "```json\n" + JSON.stringify({
      signals: [{ key: "team", score_1_10: 7, note: "strong" }],
      overall_1_10: 7, verdict_fit: "fundable", top_gaps: [],
    }) + "\n```";
    expect(parseInvestorScorecard(fenced)?.verdict_fit).toBe("fundable");
  });
});

describe("sliceTraceForPersist", () => {
  const row = (id: string, actor: string): TraceEvent =>
    ({ id, actor, event_type: "tool_result", payload: {}, created_at: new Date().toISOString() }) as TraceEvent;
  test("60-row fixture keeps investor rows, caps at 55, dedupes", () => {
    const trace = Array.from({ length: 57 }, (_, i) => row(`r${i}`, "executor"));
    trace.push(row("inv1", "skill:investor-readiness"), row("inv2", "skill:investor-readiness"), row("r5", "executor"));
    const out = sliceTraceForPersist(trace);
    expect(out.length).toBeLessThanOrEqual(55);
    expect(out.map((t) => t.id)).toContain("inv1");
    expect(out.map((t) => t.id)).toContain("inv2");
    expect(new Set(out.map((t) => t.id)).size).toBe(out.length);
  });
  test("short traces pass through untouched", () => {
    const trace = [row("a", "router")];
    expect(sliceTraceForPersist(trace)).toEqual(trace);
  });
});
