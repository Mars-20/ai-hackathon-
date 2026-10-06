import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// server-only resolves to empty.js under the react-server export condition;
// neutralize it for the node test env (companion-dal.test.ts precedent).
vi.mock("server-only", () => ({}));
import { composePrompt } from "../companion/prompt";
import { findUnsupportedFactualClaims } from "@/lib/utils";

// Task 8 — agent wiring: composePrompt concatenation + H2 verifier exclusion.

describe("composePrompt (concatenation ONLY)", () => {
  it("empty ctx returns the base byte-identical", () => {
    const base = "Extract structured information.\nIDEA: السوق\nwith unicode + $5B";
    expect(composePrompt(base, "")).toBe(base);
  });

  it("non-empty ctx concatenates with fixed delimiters, values untouched", () => {
    const ctx = "[fact] <untrusted>يفضل الدفع عند الاستلام</untrusted>";
    const out = composePrompt("BASE", ctx);
    expect(out.startsWith("BASE")).toBe(true);
    expect(out).toContain(ctx);
    // No re-wrapping: the compile-time <untrusted> shield appears exactly once.
    expect(out.match(/<untrusted>/g)).toHaveLength(1);
  });
});

describe("H2: companion block is NEVER evidence", () => {
  // Numeric + length>12 → trips the utils factual gate; supported ONLY by a
  // companion row, so with memory-free evidence it MUST stay flagged.
  const line = "السوق 5B دولار والقنوات";

  it("companion-only-supported claim is flagged without memory evidence", () => {
    expect(findUnsupportedFactualClaims(line, [])).toEqual([line]);
    expect(
      findUnsupportedFactualClaims(line, [
        { claim: "unrelated claim", source_url: "https://example.com/x" },
      ]),
    ).toEqual([line]);
  });

  it("verifier prompt is composed with empty ctx (static wiring)", () => {
    const src = readFileSync(join(__dirname, "..", "..", "app", "api", "agent", "route.ts"), "utf8");
    const start = src.indexOf("async function runVerifier(");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("export async function POST", start);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).toMatch(/composePrompt\([\s\S]*?""\s*\)/);
    expect(block).toMatch(/H2/);
  });
});
