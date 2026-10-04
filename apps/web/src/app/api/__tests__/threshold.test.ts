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

describe("stats tools + misc helpers (Task 7: coverage gate)", () => {
  test("sampleStats: empty, even median, single", async () => {
    const m = await import("@/lib/utils");
    expect(m.sampleStats([])).toEqual({ n: 0, mean: 0, median: 0, min: 0, max: 0, std: 0 });
    const r = m.sampleStats([1, 2, 3, 4]);
    expect(r).toMatchObject({ n: 4, mean: 2.5, median: 2.5, min: 1, max: 4 });
    expect(m.sampleStats([5])).toMatchObject({ n: 1, mean: 5, median: 5, std: 0 });
    expect(m.sampleStats([1, 2, 3])).toMatchObject({ median: 2 });
  });

  test("seanEllisScore: empty, strong, moderate, weak", async () => {
    const m = await import("@/lib/utils");
    expect(m.seanEllisScore([]).pmf_reached).toBe(false);
    expect(m.seanEllisScore([1, 1, 2, 3]).pmf_reached).toBe(true);
    expect(m.seanEllisScore([1, 2, 2, 3]).interpretation).toMatch(/Moderate/);
    expect(m.seanEllisScore([2, 3, 3, 3]).interpretation).toMatch(/Weak/);
  });

  test("responseRate: zero sent, all bands incl. Task 7 memo math", async () => {
    const m = await import("@/lib/utils");
    expect(m.responseRate(0, 0)).toEqual({ rate: 0, label: "No messages sent" });
    expect(m.responseRate(100, 40).label).toBe("Excellent");
    expect(m.responseRate(100, 20).label).toBe("Good");
    expect(m.responseRate(100, 10).label).toBe("Typical");
    expect(m.responseRate(100, 1).label).toBe("Low");
    // Task 7 decision-memo math: engaged sample over total primary sample.
    const primary = [
      { strength: "opinion" as const, sample_size: 4 },
      { strength: "contact_shared" as const, sample_size: 12 },
    ];
    const sent = primary.reduce((a, e) => a + (e.sample_size ?? 1), 0);
    const replied = primary.filter((e) => e.strength !== "opinion").reduce((a, e) => a + (e.sample_size ?? 1), 0);
    expect(m.responseRate(sent, replied).rate).toBe(Math.round((12 / 16) * 100));
  });

  test("confidenceInterval: empty + bounded wilson", async () => {
    const m = await import("@/lib/utils");
    expect(m.confidenceInterval(0, 0)).toEqual({ lower: 0, upper: 0, center: 0 });
    const r = m.confidenceInterval(30, 100);
    expect(r.lower).toBeLessThanOrEqual(r.center);
    expect(r.center).toBeLessThanOrEqual(r.upper);
    const r90 = m.confidenceInterval(30, 100, 0.9);
    expect(r90.center).toBeGreaterThan(0);
  });

  test("meetsGoThreshold: 3 distinct sources but thin sample → ineligible", async () => {
    const m = await import("@/lib/utils");
    const r = m.meetsGoThreshold([
      { strength: "contact_shared" as const, sample_size: 1, source_url: "https://a.example/r1" },
      { strength: "contact_shared" as const, sample_size: 1, source_url: "https://b.example/r2" },
      { strength: "contact_shared" as const, sample_size: 1, source_url: "https://c.example/r3" },
    ]);
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/Sample too small/);
  });

  test("misc helpers: cn/formatUsd/formatMs/truncate/colors", async () => {
    const m = await import("@/lib/utils");
    expect(m.cn("a", undefined, false, null, "b")).toBe("a b");
    expect(m.formatUsd(0.5)).toBe("$0.5000");
    expect(m.formatMs(1500)).toBe("1.5s");
    expect(m.formatMs(500)).toBe("500ms");
    expect(m.truncate("abcdef", 5)).toBe("ab...");
    expect(m.truncate("abc", 5)).toBe("abc");
    expect(m.getVerdictColor("go")).toBe("#40c057");
    expect(m.getVerdictColor("bogus")).toBe("#94a3b8");
    expect(m.getRiskColor("critical")).toBe("#fa5252");
    expect(m.getRiskColor("bogus")).toBe("#94a3b8");
  });
});

describe("golden path completeness (Task 7): intake asks <=3 clarifying Qs", () => {
  test("intake schema allows clarifying_questions <=3", async () => {
    const m = await import("@/lib/validation");
    expect(m.intakeSchema).toBeDefined();
    const ok3 = m.intakeSchema.safeParse({
      clarifying_questions: ["Who pays?", "What stage?", "How monetized?"],
    });
    expect(ok3.success).toBe(true);
    const tooMany = m.intakeSchema.safeParse({
      clarifying_questions: ["q1", "q2", "q3", "q4"],
    });
    expect(tooMany.success).toBe(false);
  });
});
