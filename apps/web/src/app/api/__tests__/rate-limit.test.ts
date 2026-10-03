import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import {
  checkRateLimit,
  resolveRateLimitKey,
  RATE_MAX,
  RATE_WINDOW_MS,
  resetRateLimitForTests,
} from "@/lib/rate-limit";
import {
  checkBudget,
  recordSpend,
  extractUsageCost,
  COST_TABLE,
  resetCostForTests,
} from "@/lib/cost";
import { BUDGET } from "@/lib/utils";

const TEST_IP = "10.20.30.40";
const ROUTE = "/api/agent";

function makeAgentReq(ip: string, body: unknown = { idea: "test idea for rate limit" }) {
  return new NextRequest("http://localhost/api/agent", {
    method: "POST",
    headers: { "x-forwarded-for": ip, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetRateLimitForTests();
  resetCostForTests();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

describe("rate-limit (Task 5)", () => {
  test("allows RATE_MAX requests then limits the next one with retryAfter", async () => {
    const key = resolveRateLimitKey({ userId: "", ip: TEST_IP, route: ROUTE });
    for (let i = 0; i < RATE_MAX; i++) {
      const r = await checkRateLimit({ key, limit: RATE_MAX, windowMs: RATE_WINDOW_MS });
      expect(r.limited).toBe(false);
    }
    const blocked = await checkRateLimit({ key, limit: RATE_MAX, windowMs: RATE_WINDOW_MS });
    expect(blocked.limited).toBe(true);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect(blocked.retryAfter).toBeLessThanOrEqual(Math.ceil(RATE_WINDOW_MS / 1000));
  });

  test("user key and ip key have independent buckets", async () => {
    const ipKey = resolveRateLimitKey({ userId: "", ip: "9.9.9.9", route: ROUTE });
    const userKey = resolveRateLimitKey({ userId: "user-123", ip: "9.9.9.9", route: ROUTE });
    expect(ipKey).not.toBe(userKey);
    for (let i = 0; i < RATE_MAX; i++) {
      await checkRateLimit({ key: ipKey, limit: RATE_MAX, windowMs: RATE_WINDOW_MS });
    }
    expect((await checkRateLimit({ key: ipKey })).limited).toBe(true);
    expect((await checkRateLimit({ key: userKey })).limited).toBe(false);
  });

  test("fail-closed on Redis error (no silent bypass)", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("redis down"));
    const r = await checkRateLimit({ key: "fail-closed-key" });
    expect(globalThis.fetch).toHaveBeenCalled();
    expect(r.limited).toBe(true);
    expect(r.retryAfter).toBeGreaterThan(0);
  });

  test("fail-closed on malformed Redis response shape (no silent bypass)", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    // Fresh Response per call: reusing one instance would throw Body-used
    // and pass for the wrong reason.
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ result: "weird-shape" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    const r = await checkRateLimit({ key: "weird-shape-key" });
    expect(globalThis.fetch).toHaveBeenCalled();
    expect(r.limited).toBe(true);
    expect(r.retryAfter).toBeGreaterThan(0);
  });

  test("POST as the 11th request in the window returns 429 {error, retryAfter} with Retry-After header", async () => {
    const { POST } = await import("@/app/api/agent/route");
    const key = resolveRateLimitKey({ userId: "", ip: TEST_IP, route: ROUTE });
    // First 10 requests fill the sliding window (same key POST will compute:
    // no auth in test env -> falls back to ip+route key).
    for (let i = 0; i < RATE_MAX; i++) {
      await checkRateLimit({ key, limit: RATE_MAX, windowMs: RATE_WINDOW_MS });
    }
    const res = await POST(makeAgentReq(TEST_IP));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).not.toBeNull();
    const body = (await res.json()) as { error: string; retryAfter: number };
    expect(typeof body.error).toBe("string");
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(res.headers.get("Retry-After")).toBe(String(body.retryAfter));
  });
});

describe("cost (Task 5)", () => {
  test("checkBudget allows a fresh workspace", async () => {
    const b = await checkBudget("ws-fresh");
    expect(b.allowed).toBe(true);
    expect(b.spentUsd).toBe(0);
    expect(b.limitUsd).toBe(BUDGET.MAX_COST_USD);
  });

  test("checkBudget blocks after recorded spend exceeds the cap", async () => {
    recordSpend("ws-hot", BUDGET.MAX_COST_USD);
    const b = await checkBudget("ws-hot");
    expect(b.allowed).toBe(false);
    expect(b.retryAfter).toBeGreaterThan(0);
  });

  test("extractUsageCost prefers usageMetadata, falls back to COST_TABLE", async () => {
    expect(COST_TABLE.gemini_call).toBeGreaterThan(0);
    const fallback = extractUsageCost(undefined, "gemini_call");
    expect(fallback).toBe(COST_TABLE.gemini_call);
    const metered = extractUsageCost({ totalTokenCount: 5_000 }, "gemini_call");
    expect(metered).toBeGreaterThan(0);
    expect(metered).not.toBe(COST_TABLE.gemini_call);
  });
});

describe("agent route wiring (Task 5, static)", () => {
  const routePath = path.resolve(process.cwd(), "src/app/api/agent/route.ts");
  const src = fs.readFileSync(routePath, "utf8");

  test("wires distributed checkRateLimit + cost.checkBudget with 429 + Retry-After + rate_limited trace", () => {
    expect(src).toMatch(/checkRateLimit/);
    expect(src).toMatch(/checkBudget/);
    expect(src).toMatch(/Retry-After/);
    expect(src).toMatch(/rate_limited/);
    expect(src).toMatch(/status:\s*429/);
  });

  test("old per-instance Map limiter and stale comment are removed", () => {
    expect(src).not.toMatch(/new Map<string,\s*\{\s*count/);
    expect(src).not.toMatch(/use Redis\/Upstash in prod/);
  });
});
