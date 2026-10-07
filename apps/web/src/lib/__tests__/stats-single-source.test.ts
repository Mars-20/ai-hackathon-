import { describe, test, expect } from "vitest";
import * as utils from "@/lib/utils";
import * as canonical from "../../../../../packages/tools/stats";

// Single-source lock: @/lib/utils must re-export the canonical
// packages/tools/stats implementation, never a local copy. Reference
// identity (not just behavior) guarantees zero duplicated logic.
describe("stats single source", () => {
  for (const fn of [
    "sampleStats",
    "seanEllisScore",
    "responseRate",
    "confidenceInterval",
  ] as const) {
    test(`${fn} is the canonical implementation`, () => {
      expect(utils[fn]).toBe(canonical[fn]);
    });
  }
});
