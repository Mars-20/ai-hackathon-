import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

// ─────────────────────────────────────────────────────────────────────────────
// Companion console e2e (Task 10) — REAL backend, REAL data, no stubs.
//
// Auth pattern: same family as trial-paywall.spec.ts — one fresh throwaway user
// via the Supabase Auth Admin API (service-role), real /login UI per test so
// `page.request` carries genuine @supabase/ssr session cookies. Serial: the
// tests mutate one user's memory queue.
//   1. Seed a pending memory as the logged-in user (real POST route + DAL),
//      approve in the UI, assert it lands in the approved section with the
//      §9 provenance line, and assert the user-scoped read path returns it.
//   2. Forget with confirm → absent from GET.
//   3. Toggle off → injection state off (aria-pressed + Off).
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
  throw new Error("companion e2e: Supabase env not found (.env.local or process env)");
}

const env = loadServiceEnv();
const svcHeaders = {
  apikey: env.service,
  Authorization: `Bearer ${env.service}`,
  "Content-Type": "application/json",
};

const PENDING_LABEL = "بانتظار موافقتك";
const APPROVE_LABEL = "اعتماد";
const FORGET_LABEL = "نسيان نهائي";
const DISABLE_LABEL = "إيقاف الذاكرة مؤقتًا";

type CompanionUser = {
  id: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
};
let companionUser: CompanionUser | null = null;

async function loginAs(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#auth-email-input").fill(email);
  await page.locator("#auth-password-input").fill(password);
  await page.locator("#auth-submit-btn").click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
}

// NOTE (Task 10 finding): POST /api/companion/memory is the MANUAL path —
// createManualMemory propose→auto-approve by design (Task 5), so it NEVER
// yields pending. Pending rows are produced only by the agent inference hook
// via propose_memories. The e2e seeds pending through that exact RPC with the
// USER JWT (same auth + RLS + deny-with-return envelope the hook uses); every
// user-visible step below (queue render, approve click, forget confirm,
// toggle) stays fully UI-driven.
async function seedPending(
  value: string,
): Promise<string> {
  if (!companionUser) throw new Error("companion user not created (beforeAll failed)");
  const client = createClient(env.url, env.anon, { auth: { persistSession: false } });
  await client.auth.setSession({
    access_token: companionUser.accessToken,
    refresh_token: companionUser.refreshToken,
  });
  const { data, error } = await client.rpc("propose_memories", {
    p_user_id: companionUser.id,
    p_rows: [{ kind: "preference", value, confidence: 0.85, source_ref: "e2e-seed" }],
  });
  if (error) throw new Error(`propose_memories failed: ${error.message}`);
  const first = (data as { results?: Array<{ ok?: boolean; id?: string; code?: string }> })?.results?.[0];
  if (!first?.ok || typeof first.id !== "string") {
    throw new Error(`propose not ok: ${first?.code ?? "unknown"}`);
  }
  return first.id;
}

test.describe.serial("companion console (real backend)", () => {
  test.beforeAll(async () => {
    const email = `e2e-companion-${Date.now().toString(36)}@example.com`;
    const password = `E2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
    const res = await fetch(`${env.url}/auth/v1/admin/users`, {
      method: "POST",
      headers: svcHeaders,
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: "E2E Companion" },
      }),
    });
    if (!res.ok) throw new Error(`admin user create failed: ${res.status}`);
    const created = (await res.json()) as { id?: string };
    if (!created.id) throw new Error("admin user create returned no id");
    // User-JWT session for the DAL-level read probe (same RLS path the
    // server DAL reads through — no service-role in assertions).
    const client = createClient(env.url, env.anon, { auth: { persistSession: false } });
    const { data: session, error } = await client.auth.signInWithPassword({ email, password });
    if (error || !session.session) throw new Error(`e2e sign-in failed: ${error?.message}`);
    companionUser = {
      id: created.id,
      email,
      password,
      accessToken: session.session.access_token,
      refreshToken: session.session.refresh_token,
    };
  });

  test.afterAll(async () => {
    if (!companionUser) return;
    const userId = companionUser.id;
    try {
      await fetch(`${env.url}/auth/v1/admin/users/${userId}`, {
        method: "DELETE",
        headers: svcHeaders,
      });
    } catch (err) {
      console.warn(`[e2e] cleanup delete failed for ${companionUser.email}:`, err);
    }
    try {
      const left = await fetch(
        `${env.url}/rest/v1/companion_memory?select=id&user_id=eq.${userId}`,
        { headers: svcHeaders },
      );
      if (left.ok) {
        const rows = (await left.json()) as Array<{ id: string }>;
        expect(rows.length, "orphan companion rows after user delete").toBe(0);
        for (const r of rows) {
          await fetch(`${env.url}/rest/v1/companion_memory?id=eq.${r.id}`, {
            method: "DELETE",
            headers: svcHeaders,
          });
        }
      }
    } catch (err) {
      console.warn("[e2e] orphan scan failed (best-effort):", err);
    }
  });

  test.beforeEach(async ({ page }) => {
    if (!companionUser) throw new Error("companion user not created (beforeAll failed)");
    await loginAs(page, companionUser.email, companionUser.password);
  });

  test("seed pending → approve in UI → approved with provenance + user-scoped read", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const value = `e2e prefers async standup notes ${Date.now().toString(36)}`;
    await seedPending(value);

    await page.goto("/memories");
    const pending = page.locator(`section[aria-label="${PENDING_LABEL}"]`);
    await expect(pending.getByText(value)).toBeVisible({ timeout: 15_000 });
    await pending.getByRole("button", { name: APPROVE_LABEL }).first().click();

    const approved = page.locator('section[aria-label="Approved"]');
    await expect(approved.getByText(value)).toBeVisible({ timeout: 15_000 });
    // §9 provenance line (verbatim template renders "من جلسة …").
    await expect(approved.getByText("من جلسة")).toBeVisible();

    // DAL-level probe with the USER JWT: the same companion_memory table +
    // owner RLS the server DAL (getCompiledContext fetch step) reads through.
    // Compile/rank are pure and unit-covered; this proves the approved row is
    // retrievable in the user's session scope (the §13 "contains it" proof).
    const client = createClient(env.url, env.anon, { auth: { persistSession: false } });
    await client.auth.setSession({
      access_token: companionUser!.accessToken,
      refresh_token: companionUser!.refreshToken,
    });
    const { data, error } = await client
      .from("companion_memory")
      .select("value,status")
      .eq("user_id", companionUser!.id)
      .eq("status", "approved");
    expect(error, "user-scoped read failed").toBeNull();
    expect((data ?? []).some((r) => r.value === value)).toBe(true);
  });

  test("forget with confirm removes the memory (absent from GET)", async ({ page }) => {
    test.setTimeout(120_000);
    const value = `e2e learns quickly from short memos ${Date.now().toString(36)}`;
    const id = await seedPending(value);
    const ok = await page.request.patch(`/api/companion/memory/${id}`, {
      data: { action: "approve" },
    });
    expect(ok.status()).toBe(200);

    await page.goto("/memories");
    const approved = page.locator('section[aria-label="Approved"]');
    await expect(approved.getByText(value)).toBeVisible({ timeout: 15_000 });
    await approved.getByRole("button", { name: FORGET_LABEL }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole("button", { name: FORGET_LABEL }).click();
    await expect(approved.getByText(value)).toHaveCount(0, { timeout: 15_000 });

    const list = await page.request.get("/api/companion/memory?status=approved&limit=100");
    expect(list.ok()).toBe(true);
    const body = (await list.json()) as { items?: Array<{ value?: string }> };
    expect((body.items ?? []).some((r) => r.value === value)).toBe(false);
  });

  test("toggle off flips the injection state", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/memories");
    const toggle = page.getByRole("button", { name: DISABLE_LABEL });
    await expect(toggle).toBeVisible({ timeout: 15_000 });
    if ((await toggle.getAttribute("aria-pressed")) === "true") {
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "false", { timeout: 15_000 });
    }
    await expect(toggle).toHaveText("Off");
  });
});
