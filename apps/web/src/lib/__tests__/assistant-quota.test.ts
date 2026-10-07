import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  consumeOne,
  getDailyQuota,
  refundOne,
  secondsToUtcMidnight,
} from "@/lib/assistant/quota";

// Fake admin client: captures rpc calls; consume semantics mirror the SQL
// (FOR UPDATE row-lock) via a serialized queue in the fake.
function makeAdmin(state: { used: number; max: number; failRpc?: string }) {
  const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  let chain: Promise<unknown> = Promise.resolve();
  const client = {
    rpc: (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params });
      if (state.failRpc === name) {
        return Promise.resolve({ data: null, error: { message: "boom" } });
      }
      if (name === "consume_assistant_message") {
        const run = chain.then(() => {
          if (state.used >= state.max) {
            return { data: [{ allowed: false, used: state.used, remaining: 0 }], error: null };
          }
          state.used += 1;
          return {
            data: [{ allowed: true, used: state.used, remaining: state.max - state.used }],
            error: null,
          };
        });
        chain = run;
        return run;
      }
      if (name === "refund_assistant_message") {
        state.used = Math.max(0, state.used - 1);
        return Promise.resolve({ data: null, error: null });
      }
      return Promise.resolve({ data: null, error: { message: `unknown rpc ${name}` } });
    },
  } as unknown as SupabaseClient;
  return { client, calls, state };
}

const UID = "11111111-1111-4111-8111-111111111111";

describe("assistant-quota", () => {
  it("defaults 50 and honors env", () => {
    expect(getDailyQuota({})).toBe(50);
    expect(getDailyQuota({ ASSISTANT_DAILY_QUOTA: "7" })).toBe(7);
    expect(getDailyQuota({ ASSISTANT_DAILY_QUOTA: "junk" })).toBe(50);
    expect(getDailyQuota({ ASSISTANT_DAILY_QUOTA: "-3" })).toBe(50);
    expect(getDailyQuota({ ASSISTANT_DAILY_QUOTA: "0" })).toBe(50);
  });

  it("quota-atomic-parallel: 60 concurrent consumes at max 50 allow exactly 50", async () => {
    const { client, state } = makeAdmin({ used: 0, max: 50 });
    const results = await Promise.all(
      Array.from({ length: 60 }, () => consumeOne(client, UID, 50))
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(50);
    expect(state.used).toBe(50);
    expect(results.filter((r) => !r.allowed)).toHaveLength(10);
  });

  it("consumeOne passes user + max to the RPC", async () => {
    const { client, calls } = makeAdmin({ used: 0, max: 50 });
    const res = await consumeOne(client, UID, 50);
    expect(res).toEqual({ allowed: true, used: 1, remaining: 49 });
    expect(calls).toEqual([
      { name: "consume_assistant_message", params: { p_user: UID, p_max: 50 } },
    ]);
  });

  it("quota-refund-on-outage: refund decrements and RPC failure fail-closes", async () => {
    const { client, state } = makeAdmin({ used: 5, max: 50 });
    await refundOne(client, UID);
    expect(state.used).toBe(4);
    const bad = makeAdmin({ used: 0, max: 50, failRpc: "consume_assistant_message" });
    await expect(consumeOne(bad.client, UID, 50)).rejects.toThrow("boom");
  });

  it("secondsToUtcMidnight counts down to midnight UTC", () => {
    // 2026-10-07T23:00:00Z → 3600s to midnight.
    expect(secondsToUtcMidnight(Date.parse("2026-10-07T23:00:00.000Z"))).toBe(3600);
    expect(secondsToUtcMidnight(Date.parse("2026-10-07T00:00:00.000Z"))).toBe(86400);
  });
});
