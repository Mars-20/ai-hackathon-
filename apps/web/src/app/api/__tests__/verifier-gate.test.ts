import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deriveConfidence,
  claimHasUrlSupport,
  findUnsupportedFactualClaims,
  applyVerifierGate,
} from "@/lib/utils";

// Task 10 — verifier gate wiring (final review I1/I2/I3, spec §4.4).
// RED-first: each test below fails on the pre-fix code, then passes.

const rung4 = (over: object = {}) => ({
  strength: "contact_shared" as const,
  sample_size: 12,
  ...over,
});

describe("I2: deriveConfidence medium requires interviewSample>=12 (spec §2)", () => {
  test("RED: 3x rung4 survey-only, total n=36, interview n=0 → NOT medium", () => {
    const evidence = [
      rung4({ source_type: "survey" }),
      rung4({ source_type: "survey" }),
      rung4({ source_type: "survey" }),
    ];
    expect(deriveConfidence(evidence)).not.toBe("medium");
  });

  test("GREEN: 3x rung4 interviews, interview n=12 → medium", () => {
    const evidence = [
      rung4({ source_type: "interview", sample_size: 4 }),
      rung4({ source_type: "interview", sample_size: 4 }),
      rung4({ source_type: "interview", sample_size: 4 }),
    ];
    expect(deriveConfidence(evidence)).toBe("medium");
  });
});

describe("I3: deterministic verifier is per-claim (claim↔evidence URL), not global", () => {
  const unrelatedUrlEvidence = [
    {
      claim: "Competitor pricing starts at $49 per seat per month",
      source_url: "https://pricing.example/vendor-page",
    },
  ];

  test("RED: one global URL must not cover an unrelated market-size claim", () => {
    expect(
      claimHasUrlSupport("The market is worth $5B growing 20% yearly", unrelatedUrlEvidence)
    ).toBe(false);
  });

  test("GREEN: URL-bearing evidence sharing claim tokens covers the claim", () => {
    expect(
      claimHasUrlSupport("Competitor pricing starts at $49 per seat", unrelatedUrlEvidence)
    ).toBe(true);
  });

  test("RED: factual line with no URL anywhere in evidence → unsupported", () => {
    expect(findUnsupportedFactualClaims("The market is worth $5B growing 20% yearly", [])).toHaveLength(1);
  });

  test("GREEN: matched claim is not flagged", () => {
    expect(
      findUnsupportedFactualClaims("Competitor pricing starts at $49 per seat", unrelatedUrlEvidence)
    ).toHaveLength(0);
  });
});

describe("I1: unsupported>0 → test_more + warnings[] (verifier is a gate, not advisory)", () => {
  test("RED: go + unsupported claims → test_more with warnings", () => {
    const gate = applyVerifierGate("go", {
      approved: false,
      unsupportedClaims: ["The market is worth $5B"],
    });
    expect(gate.verdict).toBe("test_more");
    expect(gate.warnings).toContain("The market is worth $5B");
    expect(gate.overridden).toBe(true);
  });

  test("GREEN: go + approved verifier → go untouched, no warnings", () => {
    const gate = applyVerifierGate("go", { approved: true, unsupportedClaims: [] });
    expect(gate.verdict).toBe("go");
    expect(gate.warnings).toHaveLength(0);
    expect(gate.overridden).toBe(false);
  });

  test("I1-a: stop + unsupported claims → stop PRESERVED (never downgraded to test_more), warnings kept", () => {
    const gate = applyVerifierGate("stop", {
      approved: false,
      unsupportedClaims: ["The market is worth $5B"],
    });
    expect(gate.verdict).toBe("stop");
    expect(gate.warnings).toContain("The market is worth $5B");
    expect(gate.overridden).toBe(false);
  });

  test("I1-a: iterate + unsupported claims → iterate preserved, warnings kept", () => {
    const gate = applyVerifierGate("iterate", {
      approved: false,
      unsupportedClaims: ["The market is worth $5B"],
    });
    expect(gate.verdict).toBe("iterate");
    expect(gate.warnings).toContain("The market is worth $5B");
    expect(gate.overridden).toBe(false);
  });

  test("I1-a: test_more + unsupported claims → test_more preserved, warnings kept", () => {
    const gate = applyVerifierGate("test_more", {
      approved: false,
      unsupportedClaims: ["The market is worth $5B"],
    });
    expect(gate.verdict).toBe("test_more");
    expect(gate.warnings).toContain("The market is worth $5B");
    expect(gate.overridden).toBe(false);
  });
});

describe("I1 wiring: route consumes verifierResult in the decision path", () => {
  const src = readFileSync(join(__dirname, "..", "agent", "route.ts"), "utf8");

  test("RED: decision memo receives the verifier result (param or post-memo override)", () => {
    const consumes =
      /runDecisionMemoSkill\([\s\S]*?verifierResult/.test(src) ||
      /applyVerifierGate\([\s\S]*?verifierResult/.test(src);
    expect(consumes).toBe(true);
  });

  test("RED: deterministic net is per-claim (no global hasUrl bypass)", () => {
    expect(src).not.toMatch(/const hasUrl = evidence\.some\(\(e\) => !!e\.source_url\)/);
  });

  test("route still imports the gate from @/lib/utils and defines no threshold literals", () => {
    expect(src).toMatch(/from\s+["']@\/lib\/utils["']/);
    expect(src).toMatch(/meetsGoThreshold/);
    for (const pat of [
      /const\s+GO_THRESHOLD/,
      /MIN_RUNG\s*[:=]/,
      /MIN_INDEPENDENT_SOURCES\s*[:=]/,
      /MIN_SAMPLE_QUANT\s*[:=]/,
      /MIN_INTERVIEWS_SATURATED\s*[:=]/,
    ]) {
      expect(src).not.toMatch(pat);
    }
  });
});
