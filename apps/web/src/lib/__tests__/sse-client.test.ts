import { describe, test, expect } from "vitest";
import { createSseParser } from "@/lib/sse-client";

// Fix 2 (systematic-debugging RC2): the validate page decoded each TCP
// chunk standalone and split on single "\n" — an event (e.g. `done`)
// straddling two chunks threw in JSON.parse, died in a silent `catch {}`,
// and the stream ended with no verdict and no error (frozen UI, prod
// 2026-10-05). The buffered parser reassembles frames; RED-first.

describe("createSseParser", () => {
  test("parses a single complete event", () => {
    const p = createSseParser();
    const events = p.push('data: {"type":"phase","phase":"mapping"}\n\n');
    expect(events).toEqual([{ type: "phase", phase: "mapping" }]);
    expect(p.hasTerminalEvent()).toBe(false);
  });

  test("reassembles an event split across chunks (the lost-done bug)", () => {
    const p = createSseParser();
    const first = p.push('data: {"type":"done","decision":{"verdict":"test');
    expect(first).toEqual([]);
    const second = p.push('_more"}}\n\n');
    expect(second).toEqual([{ type: "done", decision: { verdict: "test_more" } }]);
    expect(p.hasTerminalEvent()).toBe(true);
  });

  test("parses multiple events arriving in one chunk", () => {
    const p = createSseParser();
    const events = p.push(
      'data: {"type":"phase","phase":"research"}\n\ndata: {"type":"error","message":"boom"}\n\n'
    );
    expect(events.length).toBe(2);
    expect(p.hasTerminalEvent()).toBe(true);
  });

  test("abrupt stream end without done/error is detectable", () => {
    const p = createSseParser();
    p.push('data: {"type":"phase","phase":"research"}\n\n');
    expect(p.hasTerminalEvent()).toBe(false);
  });

  test("skips malformed lines but keeps parsing (and counts them)", () => {
    const p = createSseParser();
    const events = p.push('data: not-json\n\ndata: {"type":"phase","phase":"intake"}\n\n');
    expect(events).toEqual([{ type: "phase", phase: "intake" }]);
    expect(p.droppedCount()).toBe(1);
  });
});
