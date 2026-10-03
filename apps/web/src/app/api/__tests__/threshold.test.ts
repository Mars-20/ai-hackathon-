import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { meetsGoThreshold, GO_THRESHOLD } from "@/lib/utils";

// Task 7: verdict `go` requires real evidence — ≥3 DISTINCT sources, no thin.
// Thin = one source repeated, or the same URL de-duplicated below the minimum.
// Sample math: 3 × 12 = 36 ≥ quant floor, so eligibility hinges ONLY on
// distinct-source counting (imports GO_THRESHOLD, never literals).

const rung4 = (over: object = {}) => ({
  strength: "contact_shared" as const,
  sample_size: 12,
  ...over,
});

describe("threshold/verifier gate (Task 7): thin evidence must not go", () => {
  test("RED: same URL repeated x3 with n>=30 → ineligible (thin)", () => {
    const url = "https://example.com/market-report";
    const r = meetsGoThreshold([
      rung4({ source_url: url }),
      rung4({ source_url: url }),
      rung4({ source_url: url }),
    ]);
    expect(r.eligible).toBe(false);
  });

  test("RED: same URL modulo case/trailing-slash/fragment → still thin", () => {
    const r = meetsGoThreshold([
      rung4({ source_url: "https://example.com/market-report" }),
      rung4({ source_url: "https://EXAMPLE.com/market-report/" }),
      rung4({ source_url: "https://example.com/market-report#section" }),
    ]);
    expect(r.eligible).toBe(false);
  });

  test("GREEN: 3 distinct URLs with n>=30 → eligible", () => {
    const r = meetsGoThreshold([
      rung4({ source_url: "https://a.example/report-1" }),
      rung4({ source_url: "https://b.example/report-2" }),
      rung4({ source_url: "https://c.example/report-3" }),
    ]);
    expect(r.eligible).toBe(true);
  });

  test("GREEN: 3 URL-less primary items (interviews) still eligible — no regression", () => {
    const perSource = Math.ceil(
      GO_THRESHOLD.MIN_SAMPLE_QUANT / GO_THRESHOLD.MIN_INDEPENDENT_SOURCES
    );
    const r = meetsGoThreshold(
      Array.from({ length: GO_THRESHOLD.MIN_INDEPENDENT_SOURCES }, () => ({
        strength: "contact_shared" as const,
        sample_size: perSource,
        source_type: "interview",
      }))
    );
    expect(r.eligible).toBe(true);
  });
});

describe("threshold single-source (no literal copy in route)", () => {
  test("route imports the gate from @/lib/utils and defines no threshold literals", () => {
    const src = readFileSync(join(__dirname, "..", "agent", "route.ts"), "utf8");
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

  test("GO_THRESHOLD import is the canonical gate (sanity)", () => {
    expect(GO_THRESHOLD.MIN_INDEPENDENT_SOURCES).toBeGreaterThanOrEqual(3);
  });
});
