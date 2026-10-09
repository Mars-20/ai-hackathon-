import { describe, expect, it } from "vitest";
import {
  claimHasNumericContent,
  isGroundedEvidence,
  splitEvidenceByGrounding,
} from "../skills-helpers";

describe("isGroundedEvidence", () => {
  it("accepts a grounded web_search row", () => {
    expect(
      isGroundedEvidence({ source_type: "web_search", source_url: "https://example.com/report", grounding_status: "grounded" })
    ).toBe(true);
  });
  it("treats NULL grounding_status with URL as legacy grounded", () => {
    expect(
      isGroundedEvidence({ source_type: "web_search", source_url: "https://example.com/report", grounding_status: null })
    ).toBe(true);
  });
  it("rejects the fallback-path signature (null source, null url)", () => {
    expect(isGroundedEvidence({ source_type: null, source_url: null, grounding_status: null })).toBe(false);
  });
  it("rejects empty-string and non-http URLs", () => {
    expect(isGroundedEvidence({ source_type: "web_search", source_url: "  ", grounding_status: null })).toBe(false);
    expect(isGroundedEvidence({ source_type: "web_search", source_url: "ftp://example.com/x", grounding_status: null })).toBe(false);
  });
  it("rejects quarantined rows even when a URL is present", () => {
    expect(
      isGroundedEvidence({ source_type: "web_search", source_url: "https://example.com/report", grounding_status: "quarantined" })
    ).toBe(false);
  });
});

describe("claimHasNumericContent", () => {
  it("detects market numbers and ignores citation markers", () => {
    expect(claimHasNumericContent("Global market valued at $216.5B in 2024")).toBe(true);
    expect(claimHasNumericContent("CAGR of 18-20% through 2030")).toBe(true);
    expect(claimHasNumericContent("Founders struggle with landing pages [S1]")).toBe(false);
    expect(claimHasNumericContent("السوق ينمو بمعدل ٢٠٪ سنويا")).toBe(true);
  });
});

describe("splitEvidenceByGrounding", () => {
  it("partitions stably", () => {
    const rows = [
      { id: "a", source_type: "web_search", source_url: "https://a.example", grounding_status: null },
      { id: "b", source_type: null, source_url: null, grounding_status: null },
    ];
    const { grounded, ungrounded } = splitEvidenceByGrounding(rows);
    expect(grounded.map((r) => r.id)).toEqual(["a"]);
    expect(ungrounded.map((r) => r.id)).toEqual(["b"]);
  });
});

it("treats primary evidence as grounded by provenance (no URL needed)", () => {
  expect(isGroundedEvidence({ evidence_type: "primary", source_type: "interview", source_url: null, grounding_status: null })).toBe(true);
  expect(isGroundedEvidence({ evidence_type: "primary", source_type: null, source_url: null, grounding_status: null })).toBe(true);
});
it("keeps secondary rows URL-gated", () => {
  expect(isGroundedEvidence({ evidence_type: "secondary", source_type: null, source_url: null, grounding_status: null })).toBe(false);
});
