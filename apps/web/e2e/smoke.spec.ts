import { test, expect } from "@playwright/test";

// Unauthenticated smoke coverage. Authenticated flows are covered by vitest
// unit/integration tests + manual live gates (Supabase session required).

test("homepage renders a headline", async ({ page }) => {
  const resp = await page.goto("/");
  expect(resp?.status()).toBe(200);
  await expect(page.locator("h1").first()).toBeVisible();
});

for (const path of ["/validate", "/dashboard"]) {
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

test("history API rejects unauthenticated callers", async ({ request }) => {
  const r = await request.get("/api/history");
  expect([400, 401]).toContain(r.status());
});

test("agent API reports missing idea inside the SSE stream", async ({ request }) => {
  // POST /api/agent always answers 200 + text/event-stream; validation
  // failures arrive as {type:"error"} frames, not HTTP 4xx.
  const r = await request.post("/api/agent", { data: { nope: true } });
  expect(r.status()).toBe(200);
  await expect(r.text()).resolves.toContain("Idea is required");
});
