// apps/web/src/lib/__tests__/ai-locale-contract.test.ts
import { describe, it, expect } from "vitest";
import { resolveLocale } from "@/lib/ai-locale";

describe("AI locale contract", () => {
  it("body wins over cookie", () => {
    expect(resolveLocale("ar", "en")).toBe("ar");
  });
  it("cookie wins over default", () => {
    expect(resolveLocale(undefined, "ar")).toBe("ar");
  });
  it("defaults to en", () => {
    expect(resolveLocale(undefined, undefined)).toBe("en");
  });
});
