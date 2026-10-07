import { describe, expect, it } from "vitest";
import {
  adaptCitedRows,
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
