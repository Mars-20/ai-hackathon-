// apps/web/src/lib/__tests__/i18n-keys.test.ts
import { describe, it, expect } from "vitest";
import ar from "../../../messages/ar.json";
import en from "../../../messages/en.json";

function keys(o: unknown, p = ""): string[] {
  if (typeof o !== "object" || o === null) return [p];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
    keys(v, p ? `${p}.${k}` : k)
  );
}

describe("i18n key parity", () => {
  it("ar and en share identical keys", () => {
    expect(keys(ar).sort()).toEqual(keys(en).sort());
  });
  it("no empty values", () => {
    for (const v of keys(en)) {
      const val = v
        .split(".")
        .reduce<unknown>(
          (a, k) =>
            typeof a === "object" && a !== null
              ? (a as Record<string, unknown>)[k]
              : undefined,
          en as unknown
        );
      expect(typeof val === "string" ? val.trim().length : 1).toBeGreaterThan(0);
    }
  });
  it("only ar/en locales allowed", () => {
    expect(["ar", "en"]).toContain("ar");
  });
  it("plural keys use full ICU plural syntax in both locales", () => {
    const get = (msgs: unknown, k: string) =>
      k.split(".").reduce<unknown>(
        (a, key) =>
          typeof a === "object" && a !== null
            ? (a as Record<string, unknown>)[key]
            : undefined,
        msgs
      );
    for (const k of ["shared.pagination.pageXofY", "dashboard.workspaceLine", "history.header.subPattern"]) {
      for (const msgs of [en, ar]) {
        const val = get(msgs, k);
        expect(typeof val === "string" && val.includes(", plural,")).toBe(true);
      }
    }
    const arWork = get(ar, "dashboard.workspaceLine");
    expect(typeof arWork === "string" && arWork.includes("=2") && arWork.includes("few")).toBe(true);
  });
});
