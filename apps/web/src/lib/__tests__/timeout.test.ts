import { describe, test, expect } from "vitest";
import { withTimeout, resolveTimeoutMs } from "@/lib/timeout";

// Fix 1 (systematic-debugging RC1): upstream LLM calls had no per-request
// timeout — one hung provider call ate the whole 90s run budget (intake
// 209.2s in prod). withTimeout bounds every call; RED-first.

describe("withTimeout", () => {
  test("fast work resolves with its value", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 50, "probe")).resolves.toBe("ok");
  });

  test("hung work rejects with label + budget after the deadline", async () => {
    const hanging = new Promise<string>(() => {});
    await expect(withTimeout(hanging, 50, "gemini:intake")).rejects.toThrow(
      /gemini:intake timed out after 50ms/
    );
  });

  test("propagates the work's own rejection, not a timeout", async () => {
    const failing = Promise.reject(new Error("provider 503"));
    await expect(withTimeout(failing, 50, "groq:router")).rejects.toThrow("provider 503");
  });
});

describe("resolveTimeoutMs", () => {
  test("falls back to default on missing/invalid env values", () => {
    expect(resolveTimeoutMs(undefined, 45_000)).toBe(45_000);
    expect(resolveTimeoutMs("not-a-number", 45_000)).toBe(45_000);
    expect(resolveTimeoutMs("-5", 45_000)).toBe(45_000);
    expect(resolveTimeoutMs("0", 45_000)).toBe(45_000);
  });

  test("honors a positive env override", () => {
    expect(resolveTimeoutMs("10_000", 45_000)).toBe(45_000); // underscores are not numeric
    expect(resolveTimeoutMs("10000", 45_000)).toBe(10_000);
  });
});
