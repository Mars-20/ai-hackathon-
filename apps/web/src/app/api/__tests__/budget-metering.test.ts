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

describe("grounding tool shape (static)", () => {
  const routeSrc = readFileSync(join(__dirname, "..", "agent", "route.ts"), "utf8");

  test("grounding uses the SDK-typed googleSearchRetrieval tool", () => {
    // RC (prod 2026-10-05): google_search/googleSearch keys are not in the
    // installed SDK's Tool union — the API ignored them and grounding never
    // fired (permanent gemini-ungrounded, URLs stripped).
    expect(routeSrc).toMatch(/googleSearchRetrieval/);
    expect(routeSrc).not.toMatch(/google_search:\s*\{\}/);
    expect(routeSrc).not.toMatch(/[^a-zA-Z]googleSearch:\s*\{\}/);
  });

  test("no as-never casts hide tool shapes from the compiler", () => {
    expect(routeSrc).not.toMatch(/tools as never/);
  });

  test("grounded helper attempt omits JSON response config", () => {
    // Search grounding is not combined with responseMimeType JSON mode;
    // the prompt constrains JSON and parseJsonSafely extracts it.
    const start = routeSrc.indexOf("Grounding attempt (spec");
    const end = routeSrc.indexOf("groundedModel.generateContent");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(routeSrc.slice(start, end)).not.toMatch(/responseMimeType/);
  });
});

describe("per-request upstream timeouts (static)", () => {
  const routeSrc = readFileSync(join(__dirname, "..", "agent", "route.ts"), "utf8");

  test("every Gemini generateContent call is bounded by withTimeout", () => {
    // RC1: unbounded generateContent hung 209s and ate the 90s run budget.
    const sites = routeSrc.match(/\.generateContent\(/g) ?? [];
    expect(sites.length).toBeGreaterThan(0);
    const bounded = routeSrc.match(/withTimeout\([^;]*?\.generateContent\(/g) ?? [];
    expect(bounded.length).toBe(sites.length);
  });

  test("Groq fetch carries a per-attempt AbortSignal timeout", () => {
    expect(routeSrc).toMatch(/AbortSignal\.timeout\(/);
  });
});

describe("grounding model (static)", () => {
  const routeSrc = readFileSync(join(__dirname, "..", "agent", "route.ts"), "utf8");

  test("dedicated grounding model with free-tier grounding, env-overridable", () => {
    // Gemini 3.5 grounding is paid-only; gemini-2.5-flash-lite carries 500
    // free grounded RPD on the same key (Google pricing docs). Grounded call
    // sites must resolve to GROUNDING_MODEL, never the planner default.
    expect(routeSrc).toMatch(/GEMINI_GROUNDING_MODEL/);
    expect(routeSrc).toMatch(/gemini-2\.5-flash-lite/);
  });

  test("groundedSearch helper passes the grounding model to the shared caller", () => {
    expect(routeSrc).toMatch(/enableGrounding:\s*true,[\s\S]*?geminiModel:\s*GROUNDING_MODEL/);
  });

  test("direct grounding tool variants use GROUNDING_MODEL, never PLANNER_MODEL", () => {
    const start = routeSrc.indexOf("groundingToolVariants");
    const end = routeSrc.indexOf("Groq fallback: no browsing capability");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = routeSrc.slice(start, end);
    expect(block).toMatch(/model:\s*GROUNDING_MODEL/);
    expect(block).not.toMatch(/model:\s*PLANNER_MODEL/);
  });
});
