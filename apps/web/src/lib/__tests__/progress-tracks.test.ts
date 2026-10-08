import { describe, expect, it } from "vitest";
import { resolveOrder, stagePosition, TRACKS } from "@/lib/progress/tracks";

describe("progress-tracks", () => {
  it("null track resolves to general legacy order", () => {
    expect(resolveOrder(null, null).map((s) => s.key)).toEqual([
      "idea",
      "prototype",
      "live",
      "scaling",
    ]);
  });

  it("custom order overrides template", () => {
    const custom = [{ key: "pilot", label: "تجربة تشغيلية" }];
    expect(resolveOrder("local_service", custom)).toEqual(custom);
  });

  it("unknown track falls back to general", () => {
    expect(resolveOrder("nope", null)[0].key).toBe("idea");
  });

  it("position is -1 off-track", () => {
    expect(stagePosition(resolveOrder("general", null), "beta")).toBe(-1);
  });

  it("keys normalize (trim + lowercase) before compare", () => {
    expect(stagePosition(resolveOrder("general", null), "  Idea ")).toBe(0);
  });

  it("TRACKS carries version + thresholds per template", () => {
    expect(TRACKS.general.version).toBe(1);
    expect(TRACKS.general.thresholds.idea).toBeGreaterThan(0);
  });
});
