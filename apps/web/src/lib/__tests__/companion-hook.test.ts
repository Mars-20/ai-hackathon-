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

// Spec §5.1 (done ONLY): a finished run carries outcome.done=true; every
// other ending skips inference. Existing happy-path tests use CAP_DONE.
const CAP_DONE: PostSessionCapture = { ...CAP, outcome: { done: true } };

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

  it("returns a shared outcome token, initially not-done", () => {
    const seen: Array<() => void> = [];
    const token = schedulePostSessionHook(CAP, {
      afterImpl: ((cb: () => void) => {
        seen.push(cb);
      }) as never,
    });
    expect(token.outcome.done).toBe(false);
    // Shared by reference: the route flips it when SSE `done` is emitted.
    token.outcome.done = true;
    expect(token.outcome.done).toBe(true);
    expect(seen).toHaveLength(1);
  });
});

describe("executePostSessionHook done-gate (spec §5.1)", () => {
  it("skips inference when the run did not emit done (error paths)", async () => {
    let inferred = 0;
    const traces: Array<{ event_type: string; skipped?: string }> = [];
    await executePostSessionHook(
      { ...CAP, outcome: { done: false } },
      {
        getApprovedValues: async () => [],
        runInference: (async () => {
          inferred++;
          return { proposed: { results: [], dropped: [] }, usage: { totalTokenCount: 1 } };
        }) as never,
        recordSpend: (async () => 0) as never,
        insertTrace: (async (row: { event_type: string; skipped?: string }) => {
          traces.push(row);
        }) as never,
      },
    );
    expect(inferred).toBe(0);
    expect(traces).toHaveLength(1);
    expect(traces[0].event_type).toBe("companion_infer");
    expect(typeof traces[0].skipped).toBe("string");
  });

  it("skips safely when no outcome token is present (spec-strict default)", async () => {
    let inferred = 0;
    await executePostSessionHook(CAP, {
      getApprovedValues: async () => [],
      runInference: (async () => {
        inferred++;
        return { proposed: { results: [], dropped: [] }, usage: { totalTokenCount: 1 } };
      }) as never,
      recordSpend: (async () => 0) as never,
      insertTrace: (async () => {}) as never,
    });
    expect(inferred).toBe(0);
  });

  it("writes a skip-trace with the reason instead of returning silently (§13.4)", async () => {
    const recorded: Array<[string, number]> = [];
    const traces: Array<{ event_type: string; skipped?: string; proposed: number }> = [];
    await executePostSessionHook(CAP_DONE, {
      getApprovedValues: async () => [],
      runInference: (async () => ({ skipped: "disabled" })) as never,
      recordSpend: (async (key: string, usd: number) => {
        recorded.push([key, usd]);
        return usd;
      }) as never,
      insertTrace: (async (row: { event_type: string; skipped?: string; proposed: number }) => {
        traces.push(row);
      }) as never,
    });
    expect(recorded).toHaveLength(0);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ event_type: "companion_infer", skipped: "disabled", proposed: 0 });
  });

  it("runs inference when the run emitted done", async () => {
    let inferred = 0;
    await executePostSessionHook(CAP_DONE, {
      getApprovedValues: async () => [],
      runInference: (async () => {
        inferred++;
        return { proposed: { results: [], dropped: [] }, usage: { totalTokenCount: 1 } };
      }) as never,
      recordSpend: (async () => 0) as never,
      insertTrace: (async () => {}) as never,
    });
    expect(inferred).toBe(1);
  });
});

describe("executePostSessionHook spend (H5)", () => {
  it("records infer spend once + inserts one companion_infer trace", async () => {
    const recorded: Array<[string, number]> = [];
    const traces: Array<{ event_type: string }> = [];
    await executePostSessionHook(CAP_DONE, {
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
      await executePostSessionHook(CAP_DONE, {
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
      executePostSessionHook(CAP_DONE, {
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
