// apps/web/src/lib/__tests__/i18n-middleware.test.ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { stripLocale, isLocaleExemptPath } from "@/lib/i18n-path";

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

describe("isLocaleExemptPath", () => {
  it("exempts the OAuth callback route", () => {
    expect(isLocaleExemptPath("/auth/callback")).toBe(true);
  });
  it("exempts other functional auth routes", () => {
    expect(isLocaleExemptPath("/auth")).toBe(true);
    expect(isLocaleExemptPath("/auth/reset-password")).toBe(true);
  });
  it("does not exempt localizable pages", () => {
    expect(isLocaleExemptPath("/")).toBe(false);
    expect(isLocaleExemptPath("/dashboard")).toBe(false);
    expect(isLocaleExemptPath("/en/dashboard")).toBe(false);
    expect(isLocaleExemptPath("/login")).toBe(false);
  });
  it("does not exempt lookalike prefixes", () => {
    expect(isLocaleExemptPath("/author")).toBe(false);
    expect(isLocaleExemptPath("/authcallback")).toBe(false);
    expect(isLocaleExemptPath("/authentication/x")).toBe(false);
  });
});

describe("middleware OAuth callback guard", () => {
  const middlewareSrc = () =>
    fs.readFileSync(path.join(process.cwd(), "src", "middleware.ts"), "utf8");

  it("consults the locale exemption before the locale-prefix redirect", () => {
    const src = middlewareSrc();
    expect(src).toMatch(/isLocaleExemptPath\s*\(\s*pathname\s*\)/);
  });

  it("returns early for exempt paths instead of redirecting", () => {
    const src = middlewareSrc();
    const exemptIdx = src.indexOf("isLocaleExemptPath(pathname)");
    const redirectIdx = src.indexOf("`/${target}${pathname");
    expect(exemptIdx).toBeGreaterThanOrEqual(0);
    expect(redirectIdx).toBeGreaterThanOrEqual(0);
    expect(exemptIdx).toBeLessThan(redirectIdx);
  });
});
