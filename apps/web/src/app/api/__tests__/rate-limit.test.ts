import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import {
  checkRateLimit,
  resolveRateLimitKey,
  getClientIp,
  RATE_MAX,
  RATE_WINDOW_MS,
  RATE_KEY_PREFIX,
  RATE_LIMIT_LUA_SCRIPT,
  resetRateLimitForTests,
} from "@/lib/rate-limit";
import {
  checkBudget,
  recordSpend,
  recordSpendAsync,
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

// ── Atomic-Upstash mock: emulates the Lua script server-side in one step ─────
// Because the mock applies ZREMRANGEBYSCORE+ZCARD+ZADD+PEXPIRE atomically per
// EVAL call, a concurrent burst can never overshoot — mirroring real Redis
// Lua atomicity. Returns fresh Response per call.
function mockAtomicUpstash() {
  const buckets = new Map<string, number[]>();
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: unknown, _init?: unknown) => {
    const body = JSON.parse(((_init as { body?: string })?.body as string) ?? "[]") as unknown[];
    // EVAL shape: ["EVAL", script, 1, key, cutoff, now, member, windowMs, limit]
    const key = String(body[3] ?? "");
    const cutoff = Number(body[4]);
    const now = Number(body[5]);
    const windowMs = Number(body[7]);
    const limit = Number(body[8]);
    const hits = (buckets.get(key) ?? []).filter((t) => t > cutoff);
    let result: [number, number];
    if (hits.length >= limit) {
      const oldest = hits[0] ?? now;
      result = [1, Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))];
      buckets.set(key, hits);
    } else {
      hits.push(now);
      buckets.set(key, hits);
      result = [0, 0];
    }
    return new Response(JSON.stringify({ result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { buckets, spy };
}

beforeEach(() => {
  resetRateLimitForTests();
  resetCostForTests();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
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

describe("rate-limit R1/5 hardening — atomic Lua + key hygiene", () => {
  test("keys carry the ratelimit: prefix; user key preferred over ip", () => {
    expect(RATE_KEY_PREFIX).toBe("ratelimit:");
    expect(resolveRateLimitKey({ userId: "u1", ip: "1.2.3.4", route: ROUTE })).toBe("ratelimit:user:u1");
    const anon = resolveRateLimitKey({ userId: "", ip: "1.2.3.4", route: ROUTE });
    expect(anon.startsWith("ratelimit:ip:")).toBe(true);
  });

  test("getClientIp uses first XFF entry (trusted-proxy note applies)", () => {
    const h = new Headers({ "x-forwarded-for": "9.9.9.9, 10.0.0.1, 172.16.0.1" });
    expect(getClientIp(h)).toBe("9.9.9.9");
    expect(getClientIp(new Headers())).toBe("unknown");
  });

  test("Redis path is a SINGLE atomic EVAL with the Lua sliding-window script", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    const { spy } = mockAtomicUpstash();
    const key = resolveRateLimitKey({ userId: "u-eval", ip: "1.1.1.1", route: ROUTE });
    const r = await checkRateLimit({ key, limit: 10, windowMs: 60_000 });
    expect(r.limited).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const init = spy.mock.calls[0]?.[1] as { body?: string };
    const body = JSON.parse(init.body ?? "[]") as unknown[];
    expect(body[0]).toBe("EVAL");
    expect(typeof body[1]).toBe("string");
    const script = String(body[1]);
    expect(script).toContain("ZREMRANGEBYSCORE");
    expect(script).toContain("ZCARD");
    expect(script).toContain("ZADD");
    expect(script).toContain("PEXPIRE");
    expect(body[3]).toBe(key);
    // Library script matches the asserted shape.
    expect(RATE_LIMIT_LUA_SCRIPT).toContain("ZREMRANGEBYSCORE");
  });

  test("concurrent burst (memory) never admits more than limit", async () => {
    const key = resolveRateLimitKey({ userId: "", ip: "7.7.7.7", route: ROUTE });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => checkRateLimit({ key, limit: 10, windowMs: 60_000 }))
    );
    expect(results.filter((r) => !r.limited)).toHaveLength(10);
    expect(results.filter((r) => r.limited)).toHaveLength(10);
  });

  test("concurrent burst (atomic Redis mock) never admits more than limit, one roundtrip each", async () => {
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    const { spy } = mockAtomicUpstash();
    const key = resolveRateLimitKey({ userId: "", ip: "8.8.8.8", route: ROUTE });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => checkRateLimit({ key, limit: 10, windowMs: 60_000 }))
    );
    expect(results.filter((r) => !r.limited)).toHaveLength(10);
    expect(results.filter((r) => r.limited)).toHaveLength(10);
    // Atomicity = exactly one fetch per check (vs 4+ roundtrips before).
    expect(spy).toHaveBeenCalledTimes(20);
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

describe("cost R1/5 hardening — atomic RPC + fail-closed", () => {
  test("recordSpendAsync calls atomic add_workspace_spend RPC when Supabase env present", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(0.012), { status: 200, headers: { "Content-Type": "application/json" } })
      )
    );
    const total = await recordSpendAsync("ws-rpc", 0.012);
    expect(total).toBeCloseTo(0.012, 6);
    expect(spy).toHaveBeenCalledTimes(1);
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain("/rest/v1/rpc/add_workspace_spend");
    const init = spy.mock.calls[0]?.[1] as { body?: string };
    const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    expect(body.p_key).toBe("ws-rpc");
    expect(body.p_amount).toBe(0.012);
  });

  test("checkBudget falls back to memory ONLY when RPC is absent (dev)", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response("Could not find the function", { status: 404 }))
    );
    const b = await checkBudget("ws-dev-fallback");
    expect(b.allowed).toBe(true);
    expect(b.spentUsd).toBe(0);
  });

  test("checkBudget fail-closed on ledger error (never bypass)", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ledger down"));
    const b = await checkBudget("ws-ledger-down");
    expect(b.allowed).toBe(false);
    expect(b.retryAfter).toBeGreaterThan(0);
  });

  test("agent route enforces anon budget guard + fail-closed + single-source extractor", () => {
    const routePath = path.resolve(process.cwd(), "src/app/api/agent/route.ts");
    const src = fs.readFileSync(routePath, "utf8");
    // Anon fallback: unauthenticated callers ledger under the rate key.
    expect(src).toMatch(/\|\| rateKey/);
    // Fail-closed: budget-store error returns explicit 429, no silent bypass.
    expect(src).toMatch(/Budget check unavailable/);
    expect(src).toMatch(/status:\s*429/);
    // Single source: no direct COST_TABLE.* accounting in the route.
    expect(src).not.toMatch(/COST_TABLE\./);
    expect(src).toMatch(/extractUsageCost\(undefined/);
    // Atomic ledger wiring present.
    expect(src).toMatch(/recordSpendAsync/);
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
