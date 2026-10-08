import { describe, expect, it } from "vitest";
import {
  isStageInOrder,
  resolveOrder,
} from "@/lib/progress/tracks";
import { historyStageSchema, startupSaveSchema } from "@/lib/validation";

describe("progress-validation", () => {
  it("legacy stages are in the default order", () => {
    expect(isStageInOrder(null, null, "idea")).toBe(true);
    expect(isStageInOrder(null, null, "scaling")).toBe(true);
  });

  it("custom in-track key passes", () => {
    expect(isStageInOrder("local_service", null, "pilot")).toBe(true);
  });

  it("out-of-track key fails", () => {
    expect(isStageInOrder("local_service", null, "beta")).toBe(false);
    expect(isStageInOrder(null, null, "beta")).toBe(false);
  });

  it("custom order array governs membership", () => {
    const custom = [{ key: "pilot", label: "تجربة تشغيلية" }];
    expect(isStageInOrder("general", custom, "pilot")).toBe(true);
    expect(isStageInOrder("general", custom, "idea")).toBe(false);
  });

  it("comparison is case- and space-insensitive", () => {
    expect(isStageInOrder(null, null, "  Idea ")).toBe(true);
  });

  it("save schema accepts a custom stage string", () => {
    const parsed = startupSaveSchema.safeParse({
      name: "x",
      stage: "pilot",
    });
    expect(parsed.success).toBe(true);
  });

  it("save schema still defaults missing stage to idea", () => {
    const parsed = startupSaveSchema.safeParse({ name: "x" });
    expect(parsed.success && parsed.data.stage).toBe("idea");
  });

  it("history stage schema accepts a custom stage string", () => {
    expect(historyStageSchema.safeParse("pilot").success).toBe(true);
    expect(historyStageSchema.safeParse("idea").success).toBe(true);
  });

  it("resolveOrder still feeds the membership check", () => {
    expect(resolveOrder("saas_tech", null).length).toBe(5);
  });
});
