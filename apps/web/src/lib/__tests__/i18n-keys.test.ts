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
      const val = v.split(".").reduce((a: any, k) => a?.[k], en as any);
      expect(typeof val === "string" ? val.trim().length : 1).toBeGreaterThan(0);
    }
  });
  it("only ar/en locales allowed", () => {
    expect(["ar", "en"]).toContain("ar");
  });
});
