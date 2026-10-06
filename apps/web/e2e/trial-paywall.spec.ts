import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Trial-paywall e2e (Task 9) — REAL backend, REAL data, no stubs.
//
// Auth pattern (repo-first: no authenticated storageState fixture existed —
// only unauthenticated smoke.spec.ts — so this file defines the pattern):
//   1. beforeAll creates ONE fresh throwaway user via the Supabase Auth Admin
//      API (service-role). The 0010 `handle_new_user` trigger provisions the
//      profile + personal workspace + `trial_active` entitlement for real.
//   2. beforeEach logs that user in through the REAL /login UI
//      (email + password), so every test runs with genuine @supabase/ssr
//      session cookies; `page.request` shares the page context's cookies.
//   3. afterAll deletes the user via the Admin API (FK cascades wipe the
//      entitlement / startups / requests / claims rows).
// Journeys run serially because they mutate one user's trial state:
//   fresh → first memo consumes trial → second project denied → frozen UX →
//   dashboard modal → plans request → (admin approve skipped: no owner grant).
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
  throw new Error("trial-paywall e2e: Supabase env not found (.env.local or process env)");
}

const env = loadServiceEnv();
const svcHeaders = {
  apikey: env.service,
  Authorization: `Bearer ${env.service}`,
  "Content-Type": "application/json",
};

type TrialUser = { id: string; email: string; password: string };
let trialUser: TrialUser | null = null;
let trialStartupId: string | null = null;

async function loginAs(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#auth-email-input").fill(email);
  await page.locator("#auth-password-input").fill(password);
  await page.locator("#auth-submit-btn").click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
}

function parseSseFrames(text: string): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  for (const chunk of text.split("\n\n")) {
    for (const line of chunk.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      try {
        const v: unknown = JSON.parse(t.slice("data:".length));
        if (typeof v === "object" && v !== null) frames.push(v as Record<string, unknown>);
      } catch {
        // Non-JSON SSE keep-alive / padding — ignore.
      }
    }
  }
  return frames;
}

test.describe.serial("trial paywall journeys (real backend)", () => {
  test.beforeAll(async () => {
    const email = `e2e-trial-${Date.now().toString(36)}@example.com`;
    const password = `E2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
    const res = await fetch(`${env.url}/auth/v1/admin/users`, {
      method: "POST",
      headers: svcHeaders,
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: "E2E Trial" },
      }),
    });
    if (!res.ok) throw new Error(`admin user create failed: ${res.status}`);
    const body = (await res.json()) as { id?: string };
    if (!body.id) throw new Error("admin user create returned no id");
    trialUser = { id: body.id, email, password };
  });

  test.afterAll(async () => {
    if (!trialUser) return;
    try {
      await fetch(`${env.url}/auth/v1/admin/users/${trialUser.id}`, {
        method: "DELETE",
        headers: svcHeaders,
      });
    } catch (err) {
      console.warn(`[e2e] cleanup delete failed for ${trialUser.email}:`, err);
    }
  });

  test.beforeEach(async ({ page }) => {
    if (!trialUser) throw new Error("trial user not created (beforeAll failed)");
    await loginAs(page, trialUser.email, trialUser.password);
  });

  test("journey 1 — fresh user runs first memo (200) and trial becomes consumed", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    // Sanity: brand-new user starts trial_active.
    const pre = await page.request.get("/api/entitlements/me");
    expect(pre.ok()).toBe(true);
    expect((await pre.json()) as { status?: string }).toMatchObject({ status: "trial_active" });

    const idea =
      "AI tutoring app for Egyptian high school students preparing for Thanaweyya Amma: " +
      "personalized study plans and past-paper drills, B2C subscription at 200 EGP/month.";
    const res = await page.request.post("/api/agent", {
      data: { idea },
      timeout: 280_000,
    });
    expect(res.status()).toBe(200);
    const frames = parseSseFrames(await res.text());
    const done = frames.find((f) => f["type"] === "done");
    if (!done) {
      // CI diagnostics: frame-type sequence + the terminal error (truncated).
      const types = frames.map((f) => String(f["type"] ?? "?")).join(">");
      const errFrame = frames.filter((f) => f["type"] === "error").pop();
      console.log(`[e2e journey 1] frames(${frames.length}): ${types}`.slice(0, 2000));
      console.log(
        `[e2e journey 1] error frame: ${JSON.stringify(errFrame ?? null).slice(0, 1000)}`,
      );
    }
    expect(done, "expected a done frame in the agent SSE stream").toBeTruthy();
    const startup = done?.["startup"] as { id?: string } | undefined;
    expect(typeof startup?.id).toBe("string");
    trialStartupId = startup?.id ?? null;

    // Entitlement flips to trial_consumed once the run persists + consumes.
    let status = "";
    for (let i = 0; i < 20; i++) {
      const r = await page.request.get("/api/entitlements/me");
      if (r.ok()) {
        status = ((await r.json()) as { status?: string }).status ?? "";
        if (status === "trial_consumed") break;
      }
      await page.waitForTimeout(1000);
    }
    expect(status).toBe("trial_consumed");
  });

  test("journey 2 — second project denied with TRIAL_CONSUMED (save + agent)", async ({
    page,
  }) => {
    const save = await page.request.post("/api/startups/save", {
      data: { startup: { name: "E2E Second Project", stage: "idea", domain: "edtech" } },
    });
    expect(save.status()).toBe(402);
    expect((await save.json()) as { code?: string }).toMatchObject({ code: "TRIAL_CONSUMED" });

    const agent = await page.request.post("/api/agent", {
      data: { idea: "A second validation attempt after the trial was consumed." },
    });
    expect(agent.status()).toBe(402);
    expect((await agent.json()) as { code?: string }).toMatchObject({ code: "TRIAL_CONSUMED" });
  });

  test("journey 3 — frozen project validate page shows banner, CTA, locked run", async ({
    page,
  }) => {
    if (!trialStartupId) throw new Error("journey 1 did not capture a startup id");
    await page.goto(`/validate?startup_id=${trialStartupId}`);
    await expect(page.getByText("انتهت تجربتك المجانية")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#paywall-cta")).toHaveAttribute("href", "/plans");
    // Fill the idea so the disabled state proves the frozen lock (not the
    // empty-composer lock).
    await page.locator("#idea-textarea").fill("An idea typed after the trial was consumed.");
    await expect(page.locator("#run-agent-btn")).toBeDisabled();
  });

  test("journey 4 — dashboard New validation opens the paywall modal (no redirect)", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    const trigger = page.locator("#new-startup-btn");
    await expect(trigger).toBeVisible({ timeout: 20_000 });
    await trigger.click();
    await expect(page.locator("#paywall-modal-title")).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/dashboard\/?$/);
    await expect(page.locator("#paywall-modal-cta")).toHaveAttribute("href", "/plans");
  });

  test("journey 5 — plans request form 201, duplicate 409 DUPLICATE_PENDING", async ({
    page,
  }) => {
    await page.goto("/plans");
    await page.locator("#req-full-name").fill("E2E Tester");
    await page.locator("#req-phone").fill("01001234567");
    await page.locator('#request-form button[type="submit"], form button[type="submit"]').first().click();
    await expect(page.getByText("طلبك وصل")).toBeVisible({ timeout: 20_000 });

    const dup = await page.request.post("/api/subscription-requests", {
      data: { plan: "pro", full_name: "E2E Tester", phone: "01001234567" },
    });
    expect(dup.status()).toBe(409);
    expect((await dup.json()) as { code?: string }).toMatchObject({ code: "DUPLICATE_PENDING" });
  });

  test("journey 6 — admin approve unfreezes the startup", async ({ page }) => {
    test.skip(
      true,
      "No owner session available: marslino.work@gmail.com has no auth.users row and no " +
        "platform_admins grant, so approve-as-owner cannot run. Re-run after the owner " +
        "signs in once (trigger + manual grant), then unskip.",
    );
    // (Unskip path: as the owner, POST /api/admin/requests
    // {request_id, action:"approve"} → startup is_frozen=false, agent 200 again.)
    expect(page).toBeTruthy();
  });

  test("journey 6 (real denial) — non-owner admin queue read is 403 FORBIDDEN", async ({
    page,
  }) => {
    const res = await page.request.get("/api/admin/requests");
    expect(res.status()).toBe(403);
    expect((await res.json()) as { code?: string }).toMatchObject({ code: "FORBIDDEN" });
  });
});
