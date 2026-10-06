import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// server-only resolves to empty.js under the react-server export condition;
// neutralize it for the node test env (companion-dal.test.ts precedent).
vi.mock("server-only", () => ({}));
import {
  executePostSessionHook,
  schedulePostSessionHook,
  type PostSessionCapture,
} from "../companion/hook";
import { extractUsageCost } from "@/lib/cost";

// Task 8 — agent wiring: after() dispatcher + infer spend (H5).

const CAP: PostSessionCapture = {
  userId: "user-hook-1",
  userEmail: "hook@example.com",
  memoText: "قررنا استهداف السوق",
  startupName: "HookCo",
  budgetKey: "ws-hook-1",
};

describe("schedulePostSessionHook dispatcher", () => {
  it("calls after synchronously in POST scope (C4)", () => {
    const seen: Array<() => void> = [];
    schedulePostSessionHook(CAP, {
      afterImpl: ((cb: () => void) => {
        seen.push(cb);
      }) as never,
    });
    // Synchronous: already called before this assertion runs.
    expect(seen).toHaveLength(1);
  });

  it("wired exactly once in POST scope, never in the background IIFE (static)", () => {
    const src = readFileSync(join(__dirname, "..", "..", "app", "api", "agent", "route.ts"), "utf8");
    const hits = src.match(/schedulePostSessionHook\(/g) ?? [];
    expect(hits).toHaveLength(1);
    expect(src.indexOf("schedulePostSessionHook(")).toBeLessThan(src.indexOf("(async () => {"));
  });
});

describe("executePostSessionHook spend (H5)", () => {
  it("records infer spend once + inserts one companion_infer trace", async () => {
    const recorded: Array<[string, number]> = [];
    const traces: Array<{ event_type: string }> = [];
    await executePostSessionHook(CAP, {
      getApprovedValues: async () => [],
      runInference: (async () => ({
        proposed: { results: [], dropped: [] },
        usage: { totalTokenCount: 1500 },
      })) as never,
      recordSpend: async (key: string, usd: number) => {
        recorded.push([key, usd]);
        return usd;
      },
      insertTrace: (async (row: { event_type: string }) => {
        traces.push(row);
      }) as never,
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0][0]).toBe("ws-hook-1");
    expect(recorded[0][1]).toBe(extractUsageCost({ totalTokenCount: 1500 }, "gemini_call"));
    expect(traces).toHaveLength(1);
    expect(traces[0].event_type).toBe("companion_infer");
  });

  it("ledgers spend even when propose fails (review #9)", async () => {
    const recorded: Array<[string, number]> = [];
    const warned: unknown[][] = [];
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation((...a: unknown[]) => void warned.push(a));
    try {
      await executePostSessionHook(CAP, {
        getApprovedValues: async () => [],
        runInference: (async () => ({
          proposed: { results: [], dropped: [] },
          usage: { totalTokenCount: 1500 },
          proposeError: "MEMORY_FULL at RPC",
        })) as never,
        recordSpend: (async (key: string, usd: number) => {
          recorded.push([key, usd]);
          return usd;
        }) as never,
        insertTrace: (async () => {}) as never,
      });
    } finally {
      warnSpy.mockRestore();
    }
    expect(recorded).toHaveLength(1);
    expect(recorded[0][0]).toBe("ws-hook-1");
    expect(warned.some((a) => String(a[0]).includes("propose failed"))).toBe(true);
  });

  it("inference failure never breaks the run (warn + resolve)", async () => {
    const recorded: Array<[string, number]> = [];
    await expect(
      executePostSessionHook(CAP, {
        getApprovedValues: async () => [],
        runInference: (async () => {
          throw new Error("provider down");
        }) as never,
        recordSpend: (async (key: string, usd: number) => {
          recorded.push([key, usd]);
          return usd;
        }) as never,
        insertTrace: (async () => {}) as never,
      }),
    ).resolves.toBeUndefined();
    expect(recorded).toHaveLength(0);
  });
});
