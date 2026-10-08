import { test, expect } from "@playwright/test";

const cases = [
  { start: "/en/dashboard", btn: "العربية", url: /\/ar\/dashboard/, dir: "rtl" },
  { start: "/ar/dashboard", btn: "English", url: /\/en\/dashboard/, dir: "ltr" },
  { start: "/en/login", btn: "العربية", url: /\/ar\/login/, dir: "rtl" },
] as const;

for (const c of cases) {
  test(`switch ${c.start}`, async ({ page }) => {
    await page.goto(c.start);
    await page.getByRole("button", { name: c.btn }).click();
    // R5 auth gate: /dashboard is protected — middleware redirects
    // unauthenticated runs to the locale login page (locale prefix kept,
    // `?next=<original>`), so a seeded session lands on c.url while an
    // anonymous run lands on the locale /login twin. Widen only the
    // dashboard segment to (dashboard|login): the locale segment stays
    // strict, so a switch that drops the locale still fails. (Task-3
    // e2e/i18n-switch.spec.ts pins the seeded-session /en/dashboard case;
    // this matrix complements it, it doesn't replace it.)
    // R11 Secure flag on the server-set NEXT_LOCALE cookie is CI-owned:
    // middleware sets `secure` only when NODE_ENV=production and the
    // client switcher cookie never carries it — nothing to assert without
    // a server (R10: e2e deferred to CI, no local serve).
    const tolerant = new RegExp(c.url.source.replace("dashboard", "(dashboard|login)"));
    await expect(page).toHaveURL(tolerant);
    await expect(page.locator("html")).toHaveAttribute("dir", c.dir);
  });
}
