import { test, expect } from "@playwright/test";

// Unauthenticated smoke coverage. Authenticated flows are covered by vitest
// unit/integration tests + manual live gates (Supabase session required).

test("homepage renders a headline", async ({ page }) => {
  const resp = await page.goto("/");
  expect(resp?.status()).toBe(200);
  await expect(page.locator("h1").first()).toBeVisible();
});

for (const path of ["/validate", "/dashboard", "/history"]) {
  test(`protected route ${path} redirects to login`, async ({ page }) => {
    await page.goto(path);
    // Middleware redirects unauthenticated users to /login?next=<path>
    // (the slash in `next` arrives URL-encoded as %2F).
    const slug = path.slice(1);
    await expect(page).toHaveURL(new RegExp(`/login\\?next=(%2F|/)${slug}`));
  });
}

test("login page shows the email auth form", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator('input[type="email"]')).toBeVisible();
});

// ── Option-B routing: every public entry CTA lands on /dashboard ──────────
// (middleware bounces logged-out visitors to /login?next=/dashboard, so one
// target serves both states; the hero "Validate Now" keeps its deep link to
// /validate?idea=... because it carries the typed idea payload.)
for (const [name, selector] of [
  ["navbar Launch App", 'nav a:has-text("Launch App")'],
  ["hero dashboard link", 'a:has-text("open the full dashboard")'],
  ["bottom Start Validation CTA", "#cta-dashboard-btn"],
] as const) {
  test(`landing ${name} points to /dashboard`, async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(selector).first()).toHaveAttribute("href", "/dashboard");
  });
}

test("logged-out Launch App ends at login preserving next=/dashboard", async ({ page }) => {
  await page.goto("/");
  await page.locator('nav a:has-text("Launch App")').first().click();
  await expect(page).toHaveURL(/\/login\?next=(%2F|\/)dashboard/);
});

test("history API rejects unauthenticated callers", async ({ request }) => {
  const r = await request.get("/api/history");
  expect([400, 401]).toContain(r.status());
});

test("agent API rejects unauthenticated callers before the SSE stream", async ({ request }) => {
  // POST /api/agent enforces auth pre-flight: anon callers get JSON 401
  // {code:"UNAUTHENTICATED"}, never the 200 SSE stream.
  const r = await request.post("/api/agent", { data: { nope: true } });
  expect(r.status()).toBe(401);
  await expect(r.text()).resolves.toContain("UNAUTHENTICATED");
});
