import { describe, test, expect } from "vitest";
import {
  sampleStats,
  seanEllisScore,
  responseRate,
  confidenceInterval,
} from "../../../../../../packages/tools/stats";

// Property-style suite (deterministic seeded RNG — no new dependency).
// Asserts mathematical invariants over hundreds of generated inputs,
// complementing the hand-picked examples in threshold.test.ts.

/** Deterministic LCG: same sequence every run, no flakiness. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe("stats properties (seeded)", () => {
  test("sampleStats: n/min/max/median/std invariants hold", () => {
    const rand = lcg(42);
    for (let i = 0; i < 300; i++) {
      const len = 1 + Math.floor(rand() * 20);
      const data = Array.from({ length: len }, () => +(rand() * 200 - 100).toFixed(3));
      const s = sampleStats(data);
      expect(s.n).toBe(data.length);
      expect(s.min).toBe(Math.min(...data));
      expect(s.max).toBe(Math.max(...data));
      // mean is display-rounded to 2dp but MUST stay inside [min,max]
      // exactly — the implementation clamps it, so ordering is strict.
      expect(s.min).toBeLessThanOrEqual(s.mean);
      expect(s.mean).toBeLessThanOrEqual(s.max);
      expect(s.min).toBeLessThanOrEqual(s.median);
      expect(s.median).toBeLessThanOrEqual(s.max);
      expect(s.std).toBeGreaterThanOrEqual(0);
      // mean is within rounding of the true average
      const trueMean = data.reduce((a, b) => a + b, 0) / data.length;
      expect(Math.abs(s.mean - trueMean)).toBeLessThan(0.011);
    }
  });

  test("sampleStats: constant arrays have std 0; empty is zeroed", () => {
    expect(sampleStats([])).toEqual({ n: 0, mean: 0, median: 0, min: 0, max: 0, std: 0 });
    const rand = lcg(7);
    for (let i = 0; i < 50; i++) {
      const v = +(rand() * 100).toFixed(2);
      const s = sampleStats([v, v, v, v]);
      expect(s.std).toBe(0);
      expect(s.mean).toBeCloseTo(v, 2);
      expect(s.median).toBe(v);
    }
  });

  test("seanEllisScore: score bounded, pmf flag consistent", () => {
    const rand = lcg(99);
    for (let i = 0; i < 300; i++) {
      const len = 1 + Math.floor(rand() * 30);
      const responses = Array.from({ length: len }, () => 1 + Math.floor(rand() * 3));
      const r = seanEllisScore(responses);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
      expect(r.pmf_reached).toBe(r.score >= 40);
      const expected = Math.round((responses.filter((x) => x === 1).length / len) * 100);
      expect(r.score).toBe(expected);
    }
  });

  test("responseRate: exact math + label bands", () => {
    const rand = lcg(13);
    for (let i = 0; i < 300; i++) {
      const sent = 1 + Math.floor(rand() * 500);
      const replied = Math.floor(rand() * (sent + 1));
      const r = responseRate(sent, replied);
      expect(r.rate).toBe(Math.round((replied / sent) * 100));
      const expected =
        r.rate >= 30 ? "Excellent" : r.rate >= 15 ? "Good" : r.rate >= 5 ? "Typical" : "Low";
      expect(r.label).toBe(expected);
    }
    expect(responseRate(0, 0)).toEqual({ rate: 0, label: "No messages sent" });
  });

  test("confidenceInterval: ordered + bounded in [0,100]", () => {
    const rand = lcg(2024);
    for (let i = 0; i < 300; i++) {
      const n = 1 + Math.floor(rand() * 1000);
      const k = Math.floor(rand() * (n + 1));
      for (const conf of [0.95, 0.9]) {
        const ci = confidenceInterval(k, n, conf);
        expect(ci.lower).toBeGreaterThanOrEqual(0);
        expect(ci.upper).toBeLessThanOrEqual(100);
        expect(ci.lower).toBeLessThanOrEqual(ci.center);
        expect(ci.center).toBeLessThanOrEqual(ci.upper);
      }
    }
    // Edges: 0/0 and unanimous outcomes stay in bounds.
    expect(confidenceInterval(0, 0)).toEqual({ lower: 0, upper: 0, center: 0 });
    const all = confidenceInterval(50, 50);
    expect(all.upper).toBeLessThanOrEqual(100);
    expect(all.lower).toBeGreaterThanOrEqual(0);
  });
});
