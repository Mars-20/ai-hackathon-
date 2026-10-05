import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isBudgetExceeded } from "@/lib/utils";
import { extractUsageCost } from "@/lib/cost";

// Task 3 — runtime metering + per-phase budget + prompt delimiters + router/backoff.
// RED-first: runtime assertions pin the contract; static assertions fail until
// route.ts/rate-limit.ts are plumbed (usageMetadata, per-phase budget,
// <untrusted> delimiters, Groq router classifier + backoff, workspace rate key).

describe("budget metering", () => {
  test("real usageMetadata overrides static table", () => {
    const c = extractUsageCost({ totalTokenCount: 100000 }, "gemini_call");
    expect(c).not.toBe(0.004); // must reflect 100k tokens, not static fallback
  });

  test("budget exceeded mid-loop blocks", () => {
    expect(isBudgetExceeded(0.51, 0)).toBe(true);
    expect(isBudgetExceeded(0, 15)).toBe(true);
  });
});

describe("task 3 wiring (static)", () => {
  const routeSrc = readFileSync(join(__dirname, "..", "agent", "route.ts"), "utf8");
  const rateSrc = readFileSync(join(__dirname, "..", "..", "..", "lib", "rate-limit.ts"), "utf8");

  test("gemini call sites meter real usage, no static undefined fallback", () => {
    // Search-tool fallback without metering stays legitimate (and keeps the
    // Task 5 single-source assertion green), but gemini_call must be metered.
    expect(routeSrc).not.toMatch(/extractUsageCost\(undefined,\s*"gemini_call"\)/);
    expect(routeSrc).toMatch(/extractUsageCost\(undefined,\s*"search"\)/);
  });

  test("budget is enforced after EVERY phase with 429 retryAfter", () => {
    const hits = routeSrc.match(/assertPhaseBudget\(totalCost, toolCalls\)/g) ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(5);
    expect(routeSrc).toMatch(/isBudgetExceeded/);
    expect(routeSrc).toMatch(/retryAfter/);
  });

  test("user/idea/evidence fields are wrapped in <untrusted> delimiters", () => {
    expect(routeSrc).toMatch(/<untrusted>/);
  });

  test("system/user prompts are split (no blind concatenation)", () => {
    expect(routeSrc).toMatch(/systemInstruction/);
  });

  test("dedicated Groq router classifier with backoff reads x-ratelimit headers", () => {
    expect(routeSrc).toMatch(/runRouterClassifier/);
    expect(routeSrc).toMatch(/openai\/gpt-oss-120b/);
    expect(routeSrc).toMatch(/x-ratelimit/i);
    expect(routeSrc).toMatch(/backoff/i);
  });

  test("quota guards: router caps output tokens, permanent 4xx fail fast", () => {
    expect(routeSrc).toMatch(/max_tokens:\s*300/);
    expect(routeSrc).toMatch(/fail fast/);
  });

  test("rate-limit key prefers user_id, else workspace_id, else ip+route", () => {
    expect(rateSrc).toMatch(/workspace/);
    expect(routeSrc).toMatch(/workspaceId/);
  });
});
