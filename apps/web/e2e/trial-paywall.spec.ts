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
//   dashboard modal → plans request → owner approve → subscribed + unfrozen.
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

// ── Owner session (journey 6) ────────────────────────────────────────────────
// The platform owner pre-exists (real Google user, real `platform_admins`
// grant, email in the dev server's PLATFORM_OWNER_EMAILS), so there is no
// password to log in with. Same auth family as the user journeys — genuine
// Supabase Auth, no mocks — via a one-time magiclink minted with the
// service-role Admin API and exchanged server-side for a session; the session
// is then planted as @supabase/ssr cookies (default `base64url` encoding,
// `sb-<ref>-auth-token`, 3180-char chunks — the installed @supabase/ssr
// 0.6.1 layout) on a SEPARATE browser context, so the trial user's session in
// `page` is untouched. The Site URL redirect fallback makes navigating the
// magiclink itself unusable against the dev server, hence the cookie route.
const SUPABASE_REF = new URL(env.url).host.split(".")[0] ?? "";
const SSR_COOKIE_CHUNK = 3180;

function ownerEmailFromEnv(): string {
  const fromProc = (process.env.PLATFORM_OWNER_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)[0];
  if (fromProc) return fromProc;
  const here =
    typeof __dirname !== "undefined" ? __dirname : path.join(process.cwd(), "e2e");
  for (const p of [path.join(process.cwd(), ".env.local"), path.join(here, "..", ".env.local")]) {
    try {
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#") || !t.startsWith("PLATFORM_OWNER_EMAILS")) continue;
        const email = t
          .slice(t.indexOf("=") + 1)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)[0];
        if (email) return email;
      }
    } catch {
      /* try next candidate */
    }
  }
  throw new Error("trial-paywall e2e: PLATFORM_OWNER_EMAILS has no entry (owner cannot approve)");
}

function ssrSessionCookies(session: unknown): Array<{ name: string; value: string }> {
  const key = `sb-${SUPABASE_REF}-auth-token`;
  const encoded = "base64-" + Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  // base64url output is encodeURIComponent-stable ASCII, so plain slicing
  // reproduces the chunker layout (key / key.0, key.1, …) exactly.
  if (encoded.length <= SSR_COOKIE_CHUNK) return [{ name: key, value: encoded }];
  const chunks: Array<{ name: string; value: string }> = [];
  for (let i = 0; i * SSR_COOKIE_CHUNK < encoded.length; i++) {
    chunks.push({
      name: `${key}.${i}`,
      value: encoded.slice(i * SSR_COOKIE_CHUNK, (i + 1) * SSR_COOKIE_CHUNK),
    });
  }
  return chunks;
}

async function mintOwnerSession(ownerEmail: string): Promise<unknown> {
  const gen = await fetch(`${env.url}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: svcHeaders,
    body: JSON.stringify({ type: "magiclink", email: ownerEmail }),
  });
  if (!gen.ok) throw new Error(`owner generate_link failed: ${gen.status}`);
  const genBody = (await gen.json()) as { action_link?: string };
  const tokenHash =
    typeof genBody.action_link === "string"
      ? new URL(genBody.action_link).searchParams.get("token")
      : null;
  if (!tokenHash) throw new Error("owner generate_link returned no token");
  const ver = await fetch(`${env.url}/auth/v1/verify`, {
    method: "POST",
    headers: { apikey: env.service, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "magiclink", token_hash: tokenHash }),
  });
  if (!ver.ok) throw new Error(`owner session verify failed: ${ver.status}`);
  const session = (await ver.json()) as { user?: { email?: string } };
  if (session.user?.email?.toLowerCase() !== ownerEmail.toLowerCase()) {
    throw new Error("owner session came back for the wrong email");
  }
  return session;
}

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
    const userId = trialUser.id;
    // Collect FK-orphan-prone row ids BEFORE the delete (unrecoverable after):
    // owner_alerts.ref_id has no FK, and workspace_spend is keyed by
    // workspace id with no FK — both survive the auth.users cascade.
    let requestIds: string[] = [];
    let workspaceIds: string[] = [];
    try {
      const rq = await fetch(
        `${env.url}/rest/v1/subscription_requests?select=id&user_id=eq.${userId}`,
        { headers: svcHeaders },
      );
      if (rq.ok) requestIds = ((await rq.json()) as Array<{ id: string }>).map((r) => r.id);
      const ws = await fetch(`${env.url}/rest/v1/workspaces?select=id&owner_id=eq.${userId}`, {
        headers: svcHeaders,
      });
      if (ws.ok) workspaceIds = ((await ws.json()) as Array<{ id: string }>).map((w) => w.id);
    } catch (err) {
      console.warn("[e2e] pre-delete orphan scan failed (best-effort):", err);
    }
    try {
      await fetch(`${env.url}/auth/v1/admin/users/${userId}`, {
        method: "DELETE",
        headers: svcHeaders,
      });
    } catch (err) {
      console.warn(`[e2e] cleanup delete failed for ${trialUser.email}:`, err);
    }
    // The app exposes no delete path for these; wipe this run's rows directly.
    for (const rid of requestIds) {
      try {
        await fetch(`${env.url}/rest/v1/owner_alerts?ref_id=eq.${rid}`, {
          method: "DELETE",
          headers: svcHeaders,
        });
      } catch (err) {
        console.warn(`[e2e] owner_alerts cleanup failed for request ${rid}:`, err);
      }
    }
    for (const wid of workspaceIds) {
      try {
        await fetch(`${env.url}/rest/v1/workspace_spend?key=eq.${wid}`, {
          method: "DELETE",
          headers: svcHeaders,
        });
      } catch (err) {
        console.warn(`[e2e] workspace_spend cleanup failed for workspace ${wid}:`, err);
      }
    }
    // Spend is also keyed by user id in some paths (see lib/cost.ts callers).
    try {
      await fetch(`${env.url}/rest/v1/workspace_spend?key=eq.${userId}`, {
        method: "DELETE",
        headers: svcHeaders,
      });
    } catch (err) {
      console.warn("[e2e] workspace_spend cleanup failed for user key:", err);
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
    // Dev-server first-compile of /validate is heavy (900+ modules); the
    // document is served fast but `load` stalls on client hydration, so sync
    // on DOM readiness — the expects below still gate on real content.
    await page.goto(`/validate?startup_id=${trialStartupId}`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
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

  test("journey 6 — owner approve unfreezes startup, agent 200 again, subscribed", async ({
    page,
    browser,
    baseURL,
  }) => {
    test.setTimeout(300_000);
    if (!trialUser) throw new Error("trial user not created (beforeAll failed)");
    if (!trialStartupId) throw new Error("journey 1 did not capture a startup id");
    const userId = trialUser.id;

    // (a) Owner session on a SEPARATE context — the trial user's `page`
    // session stays untouched. Approval goes through the REAL route.
    const ownerEmail = ownerEmailFromEnv();
    const session = await mintOwnerSession(ownerEmail);
    const ownerCtx = await browser.newContext({ baseURL });
    try {
      const host = new URL(baseURL ?? "http://127.0.0.1:3100").hostname;
      await ownerCtx.addCookies(
        ssrSessionCookies(session).map((c) => ({ ...c, domain: host, path: "/" })),
      );
      const queueRes = await ownerCtx.request.get("/api/admin/requests?status=pending");
      expect(queueRes.status()).toBe(200);
      const queue = (await queueRes.json()) as {
        requests?: Array<{ id: string; user_id: string; status: string }>;
      };
      const target = (queue.requests ?? []).find(
        (r) => r.user_id === userId && r.status === "pending",
      );
      expect(target, "expected this run's pending subscription request in the owner queue").toBeTruthy();

      // (b) Approve through the real API as the platform owner.
      const approve = await ownerCtx.request.post("/api/admin/requests", {
        data: { request_id: target!.id, action: "approve" },
      });
      expect(approve.status()).toBe(200);
      expect((await approve.json()) as { request?: unknown }).toMatchObject({
        request: { id: target!.id, status: "approved" },
      });
    } finally {
      await ownerCtx.close();
    }

    // (c) Entitlement flips to subscribed (the RPC applies it synchronously;
    // poll briefly for read-your-write safety).
    let status = "";
    for (let i = 0; i < 20; i++) {
      const r = await page.request.get("/api/entitlements/me");
      if (r.ok()) {
        status = ((await r.json()) as { status?: string }).status ?? "";
        if (status === "subscribed") break;
      }
      await page.waitForTimeout(1000);
    }
    expect(status).toBe("subscribed");

    // Startup unfrozen — real data read (no app read path exposes is_frozen
    // to the user client) plus the real UX: banner gone, run re-enabled.
    const frozenRes = await fetch(
      `${env.url}/rest/v1/startups?select=id,is_frozen&owner_id=eq.${userId}`,
      { headers: svcHeaders },
    );
    expect(frozenRes.ok).toBe(true);
    const frozenRows = (await frozenRes.json()) as Array<{ id: string; is_frozen: boolean }>;
    expect(frozenRows.length).toBeGreaterThan(0);
    for (const row of frozenRows) expect(row.is_frozen).toBe(false);

    await page.goto(`/validate?startup_id=${trialStartupId}`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
    await expect(page.locator("#idea-textarea")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("انتهت تجربتك المجانية")).toBeHidden({ timeout: 20_000 });
    await expect(page.locator("#paywall-cta")).toBeHidden();
    await page.locator("#idea-textarea").fill("A post-subscription validation idea after approval.");
    await expect(page.locator("#run-agent-btn")).toBeEnabled();

    // Agent 200 again — a second live run on the now-subscribed account.
    const idea =
      "Subscription-based car-maintenance tracker for Egyptian drivers: " +
      "service reminders, spare-part price comparison, B2C freemium at 100 EGP/month.";
    const res = await page.request.post("/api/agent", {
      data: { idea },
      timeout: 280_000,
    });
    expect(res.status()).toBe(200);
    const frames = parseSseFrames(await res.text());
    expect(frames.find((f) => f["type"] === "done"), "expected a done frame after approval").toBeTruthy();
  });

  test("journey 6 (real denial) — non-owner admin queue read is 403 FORBIDDEN", async ({
    page,
  }) => {
    const res = await page.request.get("/api/admin/requests");
    expect(res.status()).toBe(403);
    expect((await res.json()) as { code?: string }).toMatchObject({ code: "FORBIDDEN" });
  });
});
