import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Project progress e2e — REAL backend, REAL data, no stubs.
//
// Covers the hybrid advancement journey: a Go decision raises a suggestion
// card on /validate, confirming advances the stage (dashboard stepper
// follows), and dismissing hides the card persistently.
//
// Auth + seeding pattern: same family as assistant-float.spec.ts — one fresh
// throwaway user via the Supabase Auth Admin API (service-role), rows seeded
// via service-role REST, real /login UI for genuine session cookies.
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
  throw new Error("project-progress e2e: Supabase env not found (.env.local or process env)");
}

const env = loadServiceEnv();
const svcHeaders = {
  apikey: env.service,
  Authorization: `Bearer ${env.service}`,
  "Content-Type": "application/json",
};

type ProgUser = { id: string; email: string; password: string };
let progUser: ProgUser | null = null;
let startupId = "";
let workspaceId = "";

async function loginAs(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#auth-email-input").fill(email);
  await page.locator("#auth-password-input").fill(password);
  await page.locator("#auth-submit-btn").click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
}

// The seeded workspace may not be the dashboard default (bootstrap can add a
// personal workspace first), so switch explicitly before asserting.
async function ensureSeedWorkspace(page: Page): Promise<void> {
  await page.goto("/dashboard");
  const switcher = page.locator("#workspace-switcher-btn");
  await expect(switcher).toBeVisible({ timeout: 15_000 });
  const stepper = page.locator(`[data-stage-stepper="${startupId}"]`);
  if ((await stepper.count()) > 0) return;
  await switcher.click();
  await page.getByRole("button", { name: /E2E Progress WS/ }).click();
  await expect(stepper).toHaveCount(1, { timeout: 15_000 });
}

test.describe.serial("project progress journey (real backend)", () => {
  test.beforeAll(async () => {
    const email = `e2e-prog-${Date.now().toString(36)}@example.com`;
    const password = `E2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
    const res = await fetch(`${env.url}/auth/v1/admin/users`, {
      method: "POST",
      headers: svcHeaders,
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: "E2E Progress" },
      }),
    });
    if (!res.ok) throw new Error(`admin user create failed: ${res.status}`);
    const created = (await res.json()) as { id?: string };
    if (!created.id) throw new Error("admin user create returned no id");
    progUser = { id: created.id, email, password };

    // Workspace bootstrap runs on first dashboard visit; create the
    // workspace row directly so seeding never depends on UI timing.
    const ws = await fetch(`${env.url}/rest/v1/workspaces`, {
      method: "POST",
      headers: { ...svcHeaders, Prefer: "return=representation" },
      body: JSON.stringify({
        name: "E2E Progress WS",
        slug: `e2e-prog-${Date.now().toString(36)}`,
        owner_id: created.id,
      }),
    });
    if (!ws.ok) throw new Error(`workspace seed failed: ${ws.status}`);
    const wsRows = (await ws.json()) as Array<{ id: string }>;
    workspaceId = wsRows[0].id;
    const mem = await fetch(`${env.url}/rest/v1/workspace_members`, {
      method: "POST",
      headers: svcHeaders,
      body: JSON.stringify({
        workspace_id: workspaceId,
        user_id: created.id,
        role: "owner",
      }),
    });
    if (!mem.ok) throw new Error(`membership seed failed: ${mem.status}`);

    // Startup on the default track at stage idea.
    const st = await fetch(`${env.url}/rest/v1/startups`, {
      method: "POST",
      headers: { ...svcHeaders, Prefer: "return=representation" },
      body: JSON.stringify({
        owner_id: created.id,
        workspace_id: workspaceId,
        name: "E2E Progress Startup",
        one_liner: "widgets for testing",
        domain: "general",
        stage: "idea",
      }),
    });
    if (!st.ok) throw new Error(`startup seed failed: ${st.status}`);
    const stRows = (await st.json()) as Array<{ id: string }>;
    startupId = stRows[0].id;

    // A Go decision → R1 fires a suggestion toward prototype.
    const dec = await fetch(`${env.url}/rest/v1/decisions`, {
      method: "POST",
      headers: svcHeaders,
      body: JSON.stringify({
        startup_id: startupId,
        workspace_id: workspaceId,
        verdict: "go",
        confidence: "high",
        rationale: "ship the prototype",
      }),
    });
    if (!dec.ok) throw new Error(`decision seed failed: ${dec.status}`);
  });

  test.afterAll(async () => {
    if (!progUser) return;
    const userId = progUser.id;
    for (const [table, col, val] of [
      ["stage_suggestion_dismissals", "startup_id", startupId],
      ["startup_stage_history", "startup_id", startupId],
      ["decisions", "startup_id", startupId],
      ["startups", "id", startupId],
      ["workspace_members", "workspace_id", workspaceId],
      ["workspaces", "id", workspaceId],
    ] as Array<[string, string, string]>) {
      try {
        await fetch(`${env.url}/rest/v1/${table}?${col}=eq.${val}`, {
          method: "DELETE",
          headers: svcHeaders,
        });
      } catch (err) {
        console.warn(`[e2e] cleanup ${table} failed (best-effort):`, err);
      }
    }
    try {
      await fetch(`${env.url}/auth/v1/admin/users/${userId}`, {
        method: "DELETE",
        headers: svcHeaders,
      });
    } catch (err) {
      console.warn(`[e2e] cleanup delete failed for ${progUser.email}:`, err);
    }
  });

  test("dashboard shows the stage stepper at the current stage", async ({ page }) => {
    if (!progUser) throw new Error("progress user not created (beforeAll failed)");
    await loginAs(page, progUser.email, progUser.password);
    await ensureSeedWorkspace(page);
    const stepper = page.locator(`[data-stage-stepper="${startupId}"]`);
    await expect(stepper, "stage stepper renders for the seeded startup").toHaveCount(1, {
      timeout: 15_000,
    });
    await expect(stepper).toContainText("فكرة");
  });

  test("validate page raises the suggestion card after a Go", async ({ page }) => {
    if (!progUser) throw new Error("progress user not created (beforeAll failed)");
    await loginAs(page, progUser.email, progUser.password);
    await page.goto(`/validate?startup_id=${startupId}`);
    const card = page.locator('[data-testid="stage-suggestion"]');
    await expect(card, "suggestion card appears").toHaveCount(1, { timeout: 15_000 });
    await expect(card).toContainText("نموذج أولي");
  });

  test("confirming advances the stage and the stepper follows", async ({ page }) => {
    if (!progUser) throw new Error("progress user not created (beforeAll failed)");
    await loginAs(page, progUser.email, progUser.password);
    await page.goto(`/validate?startup_id=${startupId}`);
    const card = page.locator('[data-testid="stage-suggestion"]');
    await expect(card).toHaveCount(1, { timeout: 15_000 });
    await card.locator('[data-testid="stage-confirm"]').click();
    await expect(card, "card clears after confirm").toHaveCount(0, { timeout: 15_000 });
    await ensureSeedWorkspace(page);
    const stepper = page.locator(`[data-stage-stepper="${startupId}"]`);
    await expect(stepper).toHaveCount(1, { timeout: 15_000 });
    await expect(stepper).toContainText("نموذج أولي");
  });

  test("dismissing hides the suggestion persistently", async ({ page }) => {
    if (!progUser) throw new Error("progress user not created (beforeAll failed)");
    // The confirm in the previous test consumed the seeded Go, so raise a
    // fresh one — only decisions newer than the last advancement can fire.
    const dec = await fetch(`${env.url}/rest/v1/decisions`, {
      method: "POST",
      headers: svcHeaders,
      body: JSON.stringify({
        startup_id: startupId,
        workspace_id: workspaceId,
        verdict: "go",
        confidence: "high",
        rationale: "keep shipping",
      }),
    });
    if (!dec.ok) throw new Error(`decision re-seed failed: ${dec.status}`);
    await loginAs(page, progUser.email, progUser.password);
    await page.goto(`/validate?startup_id=${startupId}`);
    const card = page.locator('[data-testid="stage-suggestion"]');
    await expect(card).toHaveCount(1, { timeout: 15_000 });
    await card.locator('[data-testid="stage-dismiss"]').click();
    await expect(card, "card clears after dismiss").toHaveCount(0, { timeout: 15_000 });
    await page.reload();
    await expect(
      page.locator('[data-testid="stage-suggestion"]'),
      "dismissed suggestion stays hidden after reload",
    ).toHaveCount(0, { timeout: 15_000 });
  });
});
