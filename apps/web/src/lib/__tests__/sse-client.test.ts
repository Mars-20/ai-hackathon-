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

  test("reassembles a prod-shaped leads event fed in small TCP-like chunks", () => {
    // Prod 2026-10-05: /api/agent sends a ~17KB `leads` frame (Snov emails,
    // em dash + smart quotes in message). The UI showed no leads while the
    // trace proved the server sent them — rule out the parser dropping the
    // frame when it straddles many TCP chunks.
    const leads = [1, 2, 3, 4].map((n) => ({
      id: `lead-${n}`,
      name: "Omar Qari",
      title: "ceo",
      company: "Logicbroker",
      email: "oqari@Logicbroker.com",
      linkedin_url: "https://www.linkedin.com/in/oqari",
      city: null,
      country: "New York, New York, United States",
      seniority: null,
      headline: null,
    }));
    const payload = {
      type: "leads",
      leads,
      message:
        'Found 4 potential interviewees matching "startup founders and CEOs" — reach out to validate your assumptions with real people.',
      trace: [],
    };
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    const p = createSseParser();
    const out = [];
    for (let i = 0; i < frame.length; i += 53) out.push(...p.push(frame.slice(i, i + 53)));
    expect(out.length).toBe(1);
    const data = out[0] as unknown as { type: string; leads: unknown[]; message: unknown };
    expect(data.type).toBe("leads");
    expect(Array.isArray(data.leads)).toBe(true);
    expect(data.leads).toHaveLength(4);
    expect(typeof data.message).toBe("string");
    expect(p.droppedCount()).toBe(0);
  });
});
