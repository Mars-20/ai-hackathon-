import { describe, expect, it } from "vitest";
import {
  adaptCitedRows,
  buildAssistantSystemInstruction,
  criticScan,
  parseAssistantToolCall,
  TOOL_NAMES,
} from "@/lib/assistant/model";

describe("assistant-model", () => {
  it("critic-blocks-uncited-draft", () => {
    const r = criticScan("The market is worth $50 billion annually.", []);
    expect(r.blocked).toBe(true);
    expect(r.unsupported.length).toBeGreaterThan(0);
  });

  it("critic passes a cited draft", () => {
    const adapted = adaptCitedRows([
      { claim: "CAC is below LTV", source_url: "https://example.com/e/1" },
    ]);
    const r = criticScan("CAC is below LTV according to the study.", adapted);
    expect(r).toEqual({ blocked: false, unsupported: [] });
  });

  it("rejects unknown tool names", () => {
    expect(() => parseAssistantToolCall("drop_tables", {})).toThrow();
    expect(TOOL_NAMES).toEqual([
      "run_validation",
      "save_memory",
      "create_experiment",
      "update_experiment",
      "navigate",
    ]);
  });

  it("tool-schema-rejections: save-memory value over 500 chars fails", () => {
    expect(() =>
      parseAssistantToolCall("save_memory", {
        kind: "fact",
        value: "x".repeat(501),
      })
    ).toThrow();
  });

  it("tool-schema-rejections: malformed uuid fails", () => {
    expect(() =>
      parseAssistantToolCall("navigate", { startup_id: "not-a-uuid" })
    ).toThrow();
  });

  it("parses a valid save-memory call", () => {
    const call = parseAssistantToolCall("save_memory", {
      kind: "preference",
      value: "يفضل الاجتماعات صباحا",
    });
    expect(call).toEqual({
      name: "save_memory",
      args: { kind: "preference", value: "يفضل الاجتماعات صباحا" },
    });
  });

  it("critic ignores citation markers (markers are provenance, not claims)", () => {
    // Live regression (2026-10-07): every cited reply was blocked because the
    // digit inside [S1]/[M1]/[E1] markers matched the factual-line detector,
    // and marker-only rows never carry source_url → refusalFor replaced the
    // correct answer. Markers must not count as factual content.
    expect(
      criticScan("اللون المقترح لشعار Flowboard هو الأزرق المخضر [M1]", [])
    ).toEqual({ blocked: false, unsupported: [] });
    expect(
      criticScan(
        "I am sorry, but there is no evidence or supporting data recorded in your context or memory for your Flowboard idea [S1], so I cannot name any supporting evidence",
        []
      )
    ).toEqual({ blocked: false, unsupported: [] });
    expect(
      criticScan("لقد قمت بحفظ أن اللون المقترح لشعار Flowboard [S1] هو الأزرق المخضر في ذاكرتك", [])
    ).toEqual({ blocked: false, unsupported: [] });
  });

  it("critic still blocks bare numbers behind a marker", () => {
    // Safety net intact: stripping markers must not launder real figures.
    const r = criticScan("The market is worth $50 billion annually [E1].", []);
    expect(r.blocked).toBe(true);
    expect(r.unsupported.length).toBeGreaterThan(0);
  });

  it("critic exempts [S#]-backed structural position statements", () => {
    // Progress answers are inherently numeric ("stage 2 of 5") — the same
    // bug class as the 2026-10-07 marker block. A position claim backed by
    // an [S#] marker is structural, not factual, and must pass.
    expect(
      criticScan("مشروعك في المرحلة 2 من 5 [S1]", [])
    ).toEqual({ blocked: false, unsupported: [] });
    expect(
      criticScan("Your project is at stage 2 of 5 [S1]", [])
    ).toEqual({ blocked: false, unsupported: [] });
  });

  it("critic still blocks position-shaped lines carrying real figures", () => {
    // The exemption covers ONLY the ordinal pattern: extra numbers, money,
    // or market-sizing words in the same line stay blocked.
    const r = criticScan("المرحلة 2 من 5 بميزانية $50B [S1]", []);
    expect(r.blocked).toBe(true);
    expect(r.unsupported.length).toBeGreaterThan(0);
  });

  it("critic still blocks unmarked position statements", () => {
    // No [S#] provenance → still a bare numeric claim.
    const r = criticScan("مشروعك في المرحلة 2 من 5", []);
    expect(r.blocked).toBe(true);
  });

  it("system instruction tells the model when to call save_memory", () => {
    // Live gap (2026-10-07): save_memory was proposed once in all of prod
    // history — the prompt never instructs the model to save on "remember
    // X" requests, and the no-rows rule suppresses tool proposals. The
    // instruction must name the trigger explicitly.
    // Live gap 2 (2026-10-09): the trigger is remember-request ONLY, so the
    // model never saves durable user facts proactively. The instruction must
    // also allow one proactive save per turn for stated facts/preferences.
    const s = buildAssistantSystemInstruction("base prompt", "");
    expect(s).toContain("save_memory");
    expect(s).toMatch(/remember|store/i);
    expect(s).toMatch(/proactive|without being asked/i);
  });

  it("adaptCitedRows maps startup+evidence rows", () => {
    const out = adaptCitedRows([
      { claim: "CAC < LTV", source_url: "https://x/1" },
      { title: "Stealth fintech", source_url: "https://x/2" },
      { value: "ميزانية المشروع 5000 ريال" },
    ]);
    expect(out).toEqual([
      { claim: "CAC < LTV", source_url: "https://x/1" },
      { claim: "Stealth fintech", source_url: "https://x/2" },
      { claim: "ميزانية المشروع 5000 ريال", source_url: undefined },
    ]);
  });
});
