import { describe, expect, it } from "vitest";
import { resolveHtmlLocale } from "@/components/HtmlLocaleSync";

describe("resolveHtmlLocale", () => {
  it.each([
    ["/ar/dashboard", "ar"],
    ["/en", "en"],
    ["/", "en"],
    [null, "en"],
    ["/arabic", "en"],
    ["/en/ar", "en"],
  ] as const)("maps %s to %s", (pathname, expected) => {
    expect(resolveHtmlLocale(pathname)).toBe(expected);
  });
});
