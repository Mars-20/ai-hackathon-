import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  companionBudgetKey,
  companionCtxEntryKey,
  companionCtxGenKey,
  companionCtxKey,
  incrBudgetAtomic,
  queryFingerprint,
  redisDel,
  redisGet,
  redisSetex,
} from "../companion/redis";

const URL = "https://example.upstash.io";
const TOKEN = "test-token";

type FetchArgs = { url: string; init: RequestInit };

function stubFetchJson(json: unknown) {
  const calls: FetchArgs[] = [];
  vi.stubGlobal(
    "fetch",
    async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return { ok: true, json: async () => json } as Response;
    },
  );
  return calls;
}

function stubFetchReject() {
  vi.stubGlobal("fetch", async () => {
    throw new Error("boom");
  });
}

beforeEach(() => {
  vi.stubEnv("UPSTASH_REDIS_REST_URL", URL);
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", TOKEN);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("keys", () => {
  it("builds the exact ctx key", () => {
    expect(companionCtxKey("u1")).toBe("companion:ctx:v1:u1");
  });

  it("builds the UTC YYYYMMDD budget key with no dashes", () => {
    expect(companionBudgetKey("u1", Date.parse("2026-10-06T00:00:00Z"))).toBe(
      "companion:inferbudget:u1:20261006",
    );
  });

  it("builds the per-user cache generation key", () => {
    expect(companionCtxGenKey("u1")).toBe("companion:ctxgen:v1:u1");
  });

  it("fingerprints queries stably and order-insensitively", () => {
    expect(queryFingerprint("القهوة العربية")).toBe(queryFingerprint("العربية القهوة"));
    expect(queryFingerprint("القهوة")).not.toBe(queryFingerprint("الشاي"));
    expect(queryFingerprint("")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("builds the per-query entry key from user, gen, and fingerprint", () => {
    expect(companionCtxEntryKey("u1", "g1", "ab12cd34")).toBe(
      "companion:ctx:v1:u1:g1:ab12cd34",
    );
  });
});

describe("redisGet", () => {
  it("GETs the key and returns the cached block", async () => {
    const calls = stubFetchJson({ result: "cached-block" });
    await expect(redisGet("companion:ctx:v1:u1")).resolves.toBe("cached-block");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(URL);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toEqual(["GET", "companion:ctx:v1:u1"]);
  });

  it("miss returns null", async () => {
    stubFetchJson({ result: null });
    await expect(redisGet("k")).resolves.toBeNull();
  });

  it("fetch-reject degrades to null (fail-open read)", async () => {
    stubFetchReject();
    await expect(redisGet("k")).resolves.toBeNull();
  });

  it("missing env returns null without touching fetch", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    const calls = stubFetchJson({ result: "x" });
    await expect(redisGet("k")).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("redisSetex/redisDel", () => {
  it("SETEX posts value with EX ttl", async () => {
    const calls = stubFetchJson({ result: "OK" });
    await redisSetex("k", 3600, "v");
    expect(JSON.parse(calls[0].init.body as string)).toEqual(["SET", "k", "v", "EX", 3600]);
  });

  it("DEL posts the key", async () => {
    const calls = stubFetchJson({ result: 1 });
    await redisDel("k");
    expect(JSON.parse(calls[0].init.body as string)).toEqual(["DEL", "k"]);
  });

  it("throw swallows (best-effort writes)", async () => {
    stubFetchReject();
    await expect(redisSetex("k", 60, "v")).resolves.toBeUndefined();
    await expect(redisDel("k")).resolves.toBeUndefined();
  });
});

describe("incrBudgetAtomic", () => {
  it("sends ONE EVAL [lua, 1, key, 86400] and returns the counter", async () => {
    const calls = stubFetchJson({ result: 5 });
    await expect(incrBudgetAtomic("u1")).resolves.toBe(5);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].init.body as string) as unknown[];
    expect(body[0]).toBe("EVAL");
    expect(typeof body[1]).toBe("string");
    expect(body[1] as string).toContain("INCR");
    expect(body[2]).toBe(1);
    expect(body[3]).toMatch(/^companion:inferbudget:u1:\d{8}$/);
    expect(body[4]).toBe("86400");
    expect(body).toHaveLength(5);
  });

  it("fetch-reject throws (caller decides skip)", async () => {
    stubFetchReject();
    await expect(incrBudgetAtomic("u1")).rejects.toThrow();
  });
});
