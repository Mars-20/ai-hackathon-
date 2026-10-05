import { describe, test, expect } from "vitest";
import { describeResearchCoverage } from "@/lib/research-label";

// UI-truthfulness (prod 2026-10-05): the research header unconditionally
// claimed "grounded claims" while every item was unverified synthesis
// (provider gemini-ungrounded, URLs stripped). The header must reflect
// how many items actually carry a tool-grounded source. RED-first.

const item = (source_type?: string, source_url?: string | null) => ({
  source_type,
  source_url: source_url ?? null,
});

describe("describeResearchCoverage", () => {
  test("all items tool-grounded", () => {
    expect(
      describeResearchCoverage([item("web_search", "https://a.example"), item("web_search", "https://b.example")])
    ).toBe("Market Research — 2 grounded claims");
  });

  test("no items grounded: honest synthesis label", () => {
    expect(describeResearchCoverage([item(), item("web_search", null)])).toBe(
      "Market Research — 2 research claims (unverified synthesis)"
    );
  });

  test("mixed coverage shows the grounded count", () => {
    expect(
      describeResearchCoverage([item("web_search", "https://a.example"), item(), item()])
    ).toBe("Market Research — 3 research claims (1 grounded)");
  });

  test("empty list", () => {
    expect(describeResearchCoverage([])).toBe("Market Research");
  });
});
