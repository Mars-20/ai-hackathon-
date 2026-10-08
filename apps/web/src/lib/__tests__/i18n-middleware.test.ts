// apps/web/src/lib/__tests__/i18n-middleware.test.ts
import { describe, it, expect } from "vitest";
import { stripLocale } from "@/lib/i18n-path";

describe("stripLocale", () => {
  it("strips ar prefix", () => {
    expect(stripLocale("/ar/validate")).toEqual({ locale: "ar", rest: "/validate" });
  });
  it("keeps root slash", () => {
    expect(stripLocale("/ar")).toEqual({ locale: "ar", rest: "/" });
  });
  it("leaves plain paths", () => {
    expect(stripLocale("/validate")).toEqual({ locale: null, rest: "/validate" });
  });
  it("auth guard sees stripped path", () => {
    const { rest } = stripLocale("/ar/dashboard");
    expect(["/validate", "/dashboard", "/history", "/assistant", "/workspace", "/admin"].some((r) => rest.startsWith(r))).toBe(true);
  });
});
