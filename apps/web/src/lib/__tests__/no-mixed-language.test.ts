// apps/web/src/lib/__tests__/no-mixed-language.test.ts
import { describe, it, expect } from "vitest";
import ar from "@/../messages/ar.json";
import en from "@/../messages/en.json";

describe("no mixed language", () => {
  it("ar messages contain no latin-only nav strings", () => {
    // NOTE (Task 6): the brief drafted this as `common.nav`, but the
    // committed messages shape (Tasks 1-5, pinned by i18n-keys parity +
    // `useTranslations("nav")` consumers) keeps `nav` top-level.
    const nav = (ar as { nav: Record<string, string> }).nav;
    for (const v of Object.values(nav)) {
      expect(/^[A-Za-z0-9 _-]+$/.test(v)).toBe(false);
    }
  });
  it("en messages contain no arabic script outside native language names", () => {
    // NOTE (Task 6): the brief drafted a whole-file scan, but en.json
    // intentionally carries `common.switchToArabic: "العربية"` — language
    // switchers show each language's native name in BOTH locales (the e2e
    // matrix clicks "العربية" on /en pages). That single key is allow-
    // listed and pinned; every other string must be arabic-script-free.
    const { common } = en as { common: Record<string, string> };
    const { switchToArabic: nativeName, arabicShort: nativeAbbr, ...commonRest } = common;
    const flat = JSON.stringify({ ...(en as Record<string, unknown>), common: commonRest });
    expect(/[\u0600-\u06FF]/.test(flat)).toBe(false);
    expect(nativeName).toBe("العربية");
    expect(nativeAbbr).toBe("ع");
  });
});
