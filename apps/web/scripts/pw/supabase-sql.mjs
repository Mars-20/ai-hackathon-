// Supabase dashboard assistant — lists projects (--discover) and runs the
// migration SQL files in order through the SQL editor
// (--project=<ref-or-url> --apply).
//
// Order (per docs/runbook-validation.md):
//   20240101000002_hardening.sql → 0003_workspace_spend → 0004_invites
//   → 0005_invites_fix → supabase/backfill.sql → supabase/constraint.sql
//
// Usage:
//   node scripts/pw/supabase-sql.mjs --discover
//   node scripts/pw/supabase-sql.mjs --project=<ref-or-full-url> [--apply]
// Without --apply this only verifies the editor opens (dry run).
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, arg, hasFlag, launchPersistent, shot } from "./common.mjs";

const MIGRATIONS = [
  "supabase/migrations/20240101000002_hardening.sql",
  "supabase/migrations/20240101000003_workspace_spend.sql",
  "supabase/migrations/20240101000004_workspace_invites.sql",
  "supabase/migrations/20240101000005_workspace_invites_fix.sql",
  "supabase/backfill.sql",
  "supabase/constraint.sql",
];

async function ensureLoggedIn(page) {
  await page.goto("https://supabase.com/dashboard/projects", { waitUntil: "domcontentloaded" });
  if (/supabase\.com\/dashboard\/sign-in|supabase\.com\/auth/.test(page.url()) || (await page.getByRole("button", { name: /sign in/i }).count())) {
    console.log("LOGIN NEEDED: sign in to Supabase in the opened browser window.");
    console.log("The script waits up to 10 minutes, then continues automatically.");
    await page.waitForURL((u) => /supabase\.com\/dashboard\/projects/.test(u.href), { timeout: 600_000 });
  }
}

async function discover(context) {
  const page = await context.newPage();
  try {
    await ensureLoggedIn(page);
    await page.goto("https://supabase.com/dashboard/projects", { waitUntil: "networkidle" }).catch(() => {});
    await page.waitForTimeout(3000);
    const links = await page.$$eval('a[href*="/dashboard/project/"]', (as) =>
      as
        .map((a) => ({ text: (a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80), href: a.getAttribute("href") || "" }))
        .filter((l) => l.text)
    );
    const seen = new Map();
    for (const l of links) if (!seen.has(l.href)) seen.set(l.href, l.text);
    console.log("PROJECTS:");
    for (const [href, text] of seen) console.log(`  https://supabase.com${href}  :: ${text}`);
    if (!seen.size) {
      const s = await shot(page, "supabase-discover-empty");
      console.log(`  (none found — screenshot: ${s})`);
    } else console.log("\nRe-run with: --project=<ref-or-full-url> [--apply]");
  } finally {
    await page.close();
  }
}

async function pasteAndRun(page, name, sql) {
  // Focus Monaco, replace-all, paste via clipboard, then run.
  const editor = page.locator(".monaco-editor").first();
  await editor.click({ timeout: 20_000 });
  await page.keyboard.press("ControlOrMeta+a");
  await page.evaluate((text) => navigator.clipboard.writeText(text), sql);
  await page.keyboard.press("ControlOrMeta+v");
  await page.waitForTimeout(800);
  const runBtn = page.getByRole("button", { name: /^run$/i }).first();
  if (await runBtn.count()) await runBtn.click({ timeout: 10_000 });
  else await page.keyboard.press("ControlOrMeta+Enter");
  // Wait for a result signal: success banner or error text.
  const signal = page.locator("text=/success|error|failed|permission denied|already exists|duplicate/i").first();
  await signal.waitFor({ timeout: 180_000 });
  const text = ((await signal.textContent().catch(() => "")) || "").trim().slice(0, 300);
  return text;
}

async function applyMigrations(context, projectRef, apply) {
  const page = await context.newPage();
  try {
    await ensureLoggedIn(page);
    let ref = projectRef;
    if (!/^https?:\/\//.test(ref)) {
      // Try to resolve a bare ref or name via the projects list.
      await page.goto("https://supabase.com/dashboard/projects", { waitUntil: "networkidle" }).catch(() => {});
      await page.waitForTimeout(2500);
      const hit = await page.evaluate((want) => {
        const as = Array.from(document.querySelectorAll('a[href*="/dashboard/project/"]'));
        const w = want.toLowerCase();
        const a = as.find((x) => (x.getAttribute("href") || "").toLowerCase().includes(w) || (x.textContent || "").toLowerCase().includes(w));
        return a ? a.getAttribute("href") : null;
      }, ref).catch(() => null);
      if (!hit) {
        console.log(`Could not resolve "${ref}". Re-run with the full project URL.`);
        return;
      }
      ref = `https://supabase.com${hit}`.split("/").slice(0, 6).join("/");
      console.log(`Resolved project: ${ref}`);
    }
    const base = ref.split("?")[0].replace(/\/$/, "").split("/").slice(0, 6).join("/");
    await page.goto(`${base}/sql/new`, { waitUntil: "networkidle" });
    await page.waitForTimeout(3000);

    console.log(apply ? "APPLYING migrations in order:" : "DRY RUN — editor opens, no SQL executed. Re-run with --apply.");
    for (const rel of MIGRATIONS) {
      const sql = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      console.log(`  ${rel} (${sql.length} chars)…`);
      if (!apply) continue;
      try {
        const result = await pasteAndRun(page, rel, sql);
        console.log(`    → ${result || "(no signal text captured — check editor)"}`);
      } catch (e) {
        const s = await shot(page, `supabase-${path.basename(rel)}-failed`);
        console.log(`    → FAILED: ${(e.message || e).toString().slice(0, 200)} (screenshot: ${s})`);
        console.log("    Stopping — fix the editor state, then re-run (already-applied files are idempotent).");
        break;
      }
    }
  } finally {
    await page.close();
  }
}

const context = await launchPersistent();
try {
  if (hasFlag("discover")) await discover(context);
  else if (arg("project")) await applyMigrations(context, arg("project"), hasFlag("apply"));
  else console.log("Usage: --discover | --project=<ref-or-url> [--apply]");
} finally {
  await context.close();
}
