import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Assistant float widget e2e — REAL backend, REAL data, no stubs.
//
// Live regression (2026-10-07): a signed-in user with float_enabled=true saw
// NO floating button on /dashboard. Root cause: the widget renders on every
// page via RootLayout, but its positioning styles
// (.assistant-float-btn → position:fixed) lived in route-scoped
// app/assistant/assistant.css, loaded only on /assistant. On /dashboard the
// button rendered as an unstyled element at the end of <body>, below the
// fold — effectively invisible.
//
// Auth pattern: same family as companion.spec.ts — one fresh throwaway user
// via the Supabase Auth Admin API (service-role), prefs seeded via
// service-role REST, real /login UI so `page` carries genuine @supabase/ssr
// session cookies.
// ─────────────────────────────────────────────────────────────────────────────

type ServiceEnv = { url: string; anon: string; service: string };

function loadServiceEnv(): ServiceEnv {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return {
      url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
      service: process.env.SUPABASE_SERVICE_ROLE_KEY,
    };
  }
  const here =
    typeof __dirname !== "undefined" ? __dirname : path.join(process.cwd(), "e2e");
  for (const p of [path.join(process.cwd(), ".env.local"), path.join(here, "..", ".env.local")]) {
    try {
      const out: Record<string, string> = {};
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const i = t.indexOf("=");
        if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
      }
      if (out.NEXT_PUBLIC_SUPABASE_URL && out.SUPABASE_SERVICE_ROLE_KEY) {
        return {
          url: out.NEXT_PUBLIC_SUPABASE_URL,
          anon: out.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
          service: out.SUPABASE_SERVICE_ROLE_KEY,
        };
      }
    } catch {
      /* try next candidate */
    }
  }
  throw new Error("assistant-float e2e: Supabase env not found (.env.local or process env)");
}

const env = loadServiceEnv();
const svcHeaders = {
  apikey: env.service,
  Authorization: `Bearer ${env.service}`,
  "Content-Type": "application/json",
};

type FloatUser = { id: string; email: string; password: string };
let floatUser: FloatUser | null = null;

async function loginAs(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#auth-email-input").fill(email);
  await page.locator("#auth-password-input").fill(password);
  await page.locator("#auth-submit-btn").click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
}

test.describe.serial("assistant float widget on dashboard (real backend)", () => {
  test.beforeAll(async () => {
    const email = `e2e-float-${Date.now().toString(36)}@example.com`;
    const password = `E2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
    const res = await fetch(`${env.url}/auth/v1/admin/users`, {
      method: "POST",
      headers: svcHeaders,
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: "E2E Float" },
      }),
    });
    if (!res.ok) throw new Error(`admin user create failed: ${res.status}`);
    const created = (await res.json()) as { id?: string };
    if (!created.id) throw new Error("admin user create returned no id");
    // Seed the float preference exactly as the /assistant toggle persists it.
    const prefs = await fetch(`${env.url}/rest/v1/assistant_prefs`, {
      method: "POST",
      headers: { ...svcHeaders, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        user_id: created.id,
        float_enabled: true,
        active_conversation_id: null,
      }),
    });
    if (!prefs.ok) throw new Error(`prefs seed failed: ${prefs.status}`);
    floatUser = { id: created.id, email, password };
  });

  test.afterAll(async () => {
    if (!floatUser) return;
    const userId = floatUser.id;
    try {
      await fetch(`${env.url}/rest/v1/assistant_prefs?user_id=eq.${userId}`, {
        method: "DELETE",
        headers: svcHeaders,
      });
    } catch (err) {
      console.warn("[e2e] prefs cleanup failed (best-effort):", err);
    }
    try {
      await fetch(`${env.url}/auth/v1/admin/users/${userId}`, {
        method: "DELETE",
        headers: svcHeaders,
      });
    } catch (err) {
      console.warn(`[e2e] cleanup delete failed for ${floatUser.email}:`, err);
    }
  });

  test("button appears right after UI login without a reload", async ({ page }) => {
    // Live report: "دخلت لكن الزر لا يعمل" — login does router.push (no
    // reload), but the provider snapshots the session once on mount, so a
    // post-login widget never appears until a full page refresh.
    if (!floatUser) throw new Error("float user not created (beforeAll failed)");
    await loginAs(page, floatUser.email, floatUser.password);
    // No reload: login lands on /dashboard via client-side navigation.
    const btn = page.locator("[data-assistant-float] .assistant-float-btn");
    await expect(btn, "float button appears after login without reload").toHaveCount(1, {
      timeout: 15_000,
    });
  });

  test("enabled float button is fixed-positioned on /dashboard", async ({ page }) => {
    if (!floatUser) throw new Error("float user not created (beforeAll failed)");
    await loginAs(page, floatUser.email, floatUser.password);
    await page.goto("/dashboard");
    const btn = page.locator("[data-assistant-float] .assistant-float-btn");
    await expect(btn, "float button renders for enabled user").toHaveCount(1);
    await expect(btn, "float button is visible").toBeVisible();
    const position = await btn.evaluate((el) => getComputedStyle(el).position);
    expect(position, "float button must be fixed-positioned (styles loaded globally)").toBe(
      "fixed"
    );
    const box = await btn.boundingBox();
    expect(box, "float button has a real on-screen box").not.toBeNull();
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    expect(
      box!.x >= 0 && box!.y >= 0 && box!.x + box!.width <= viewport.width + 1,
      "float button sits inside the viewport (not below the fold)"
    ).toBe(true);
  });
});
