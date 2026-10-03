// Vercel dashboard assistant — lists projects (--discover) and fills the
// 7 known env vars from apps/web/.env.local into a project's
// Settings → Environment Variables (--project=<slug|url> --apply).
//
// The 2 Upstash vars are NOT in .env.local: the script reports them as
// MISSING for you to paste once. NEXT_PUBLIC_APP_URL is derived from the
// project's production deployment URL after the first deploy (or passed
// via --app-url=) and is reported, not guessed.
//
// Usage:
//   node scripts/pw/vercel-env.mjs --discover
//   node scripts/pw/vercel-env.mjs --project=<slug-or-full-url> [--apply] [--app-url=https://...]
// Without --apply this is a dry run: it shows which vars exist vs missing.
import { arg, hasFlag, isPlaceholder, launchPersistent, readLocalEnv, shot } from "./common.mjs";

const KNOWN_KEYS = [
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "APOLLO_API_KEY",
];
const MANUAL_KEYS = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];
const APP_URL_KEY = "NEXT_PUBLIC_APP_URL";
const ENVS = ["Production", "Preview", "Development"];

async function ensureLoggedIn(page) {
  await page.goto("https://vercel.com/dashboard", { waitUntil: "domcontentloaded" });
  if (/vercel\.com\/login/.test(page.url())) {
    console.log("LOGIN NEEDED: sign in to Vercel in the opened browser window.");
    console.log("The script waits up to 10 minutes, then continues automatically.");
    await page.waitForURL((u) => !/vercel\.com\/login/.test(u.href), { timeout: 600_000 });
  }
  await page.waitForURL(/vercel\.com\/[^/]+\/[^/]+|vercel\.com\/dashboard/, { timeout: 60_000 });
}

async function discover(context) {
  const page = await context.newPage();
  try {
    await ensureLoggedIn(page);
    await page.goto("https://vercel.com/dashboard", { waitUntil: "networkidle" }).catch(() => {});
    const links = await page.$$eval('a[href^="/"]', (as) =>
      as
        .map((a) => ({ text: (a.textContent || "").trim().slice(0, 80), href: a.getAttribute("href") || "" }))
        .filter((l) => /^\/[^/]+\/[^/]+\/?$/.test(l.href) && l.text)
    );
    const seen = new Map();
    for (const l of links) if (!seen.has(l.href)) seen.set(l.href, l.text);
    console.log("PROJECTS:");
    for (const [href, text] of seen) console.log(`  https://vercel.com${href}  :: ${text}`);
    if (!seen.size) console.log("  (none found — screenshot saved for inspection)");
    else console.log("\nRe-run with: --project=<slug-or-full-url> [--apply]");
  } finally {
    await page.close();
  }
}

async function readExistingKeys(page) {
  // Env var rows render each key as visible text; collect candidates.
  const texts = await page.$$eval("main, [role='main'], body", (roots) =>
    (roots[0]?.innerText || "").split("\n").map((t) => t.trim())
  );
  const found = new Set();
  for (const k of [...KNOWN_KEYS, ...MANUAL_KEYS, APP_URL_KEY]) {
    if (texts.some((t) => t === k)) found.add(k);
  }
  return found;
}

async function addVar(page, key, value) {
  // Tolerant flow: Add New → Key/Value fields → tick envs → Save.
  const addBtn = page
    .getByRole("button", { name: /add new/i })
    .or(page.getByRole("button", { name: /add environment variable/i }));
  await addBtn.first().click({ timeout: 15_000 });
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 15_000 });
  const keyBox = dialog.getByPlaceholder(/key|name/i).or(dialog.locator('input[name="key"]'));
  const valBox = dialog.getByPlaceholder(/value/i).or(dialog.locator('input[name="value"], textarea[name="value"]'));
  await keyBox.first().fill(key, { timeout: 15_000 });
  await valBox.first().fill(value, { timeout: 15_000 });
  for (const env of ENVS) {
    const box = dialog.getByRole("checkbox", { name: new RegExp(env, "i") });
    if ((await box.count()) && !(await box.first().isChecked().catch(() => true))) {
      await box.first().check().catch(() => {});
    }
  }
  const save = dialog.getByRole("button", { name: /^(save|add|create)$/i });
  await save.first().click({ timeout: 15_000 });
  await page.waitForTimeout(1500);
}

async function fillProject(context, projectRef, apply, appUrlOverride) {
  const page = await context.newPage();
  try {
    await ensureLoggedIn(page);
    const base = projectRef.startsWith("http") ? projectRef.replace(/\/$/, "") : null;
    if (base) {
      await page.goto(base, { waitUntil: "networkidle" }).catch(() => {});
    } else {
      // Resolve slug → full URL from the dashboard listing.
      await page.goto("https://vercel.com/dashboard", { waitUntil: "networkidle" }).catch(() => {});
      const slug = projectRef.toLowerCase();
      const href = await page.evaluate((s) => {
        const as = Array.from(document.querySelectorAll('a[href^="/"]'));
        const hit = as
          .map((a) => a.getAttribute("href") || "")
          .find((h) => h.toLowerCase().split("?")[0].replace(/\/$/, "").endsWith(`/${s}`));
        return hit || null;
      }, slug).catch(() => null);
      if (!href) {
        console.log(`Could not auto-resolve slug "${projectRef}". Re-run with the full project URL:`);
        console.log("  node scripts/pw/vercel-env.mjs --project=https://vercel.com/<team>/<slug> --apply");
        return;
      }
      await page.goto(`https://vercel.com${href}`, { waitUntil: "networkidle" }).catch(() => {});
      const resolved = page.url().split("?")[0].replace(/\/$/, "");
      console.log(`Resolved project: ${resolved}`);
      await page.goto(`${resolved}/settings/environment-variables`, { waitUntil: "networkidle" });
      await page.waitForTimeout(2500);
      await runPlan(page, appUrlOverride, apply);
      return;
    }
    await page.goto(`${base}/settings/environment-variables`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2500);
    await runPlan(page, appUrlOverride, apply);
    return;

  async function runPlan(page, appUrlOverride, apply) {
    const local = readLocalEnv();
    const plan = [];
    for (const k of KNOWN_KEYS) {
      const v = local.get(k) ?? "";
      plan.push({ key: k, status: isPlaceholder(v) ? "MISSING-LOCALLY" : "READY", value: v });
    }
    for (const k of MANUAL_KEYS) plan.push({ key: k, status: "NEEDS-YOU", value: "" });
    const appUrl = appUrlOverride ?? "";
    plan.push({ key: APP_URL_KEY, status: appUrl ? "READY" : "NEEDS-PROD-URL", value: appUrl });

    const existing = await readExistingKeys(page).catch(() => new Set());
    console.log("PLAN (existing vars on Vercel are skipped):");
    for (const p of plan) {
      const skip = existing.has(p.key) ? "SKIP-exists" : p.status;
      console.log(`  ${p.key}: ${skip}`);
    }

    if (!apply) {
      console.log("\nDry run only. Re-run with --apply to create the READY vars.");
      return;
    }
    for (const p of plan) {
      if (existing.has(p.key) || p.status !== "READY") continue;
      try {
        await addVar(page, p.key, p.value);
        console.log(`  ADDED ${p.key}`);
      } catch (e) {
        const s = await shot(page, `vercel-${p.key}-failed`);
        console.log(`  FAILED ${p.key}: ${(e.message || e).toString().slice(0, 200)} (screenshot: ${s})`);
      }
    }
    console.log("Done. Fill NEEDS-YOU / NEEDS-PROD-URL vars in the dashboard, then Redeploy.");
  }
  } finally {
    await page.close();
  }
}

const context = await launchPersistent();
try {
  if (hasFlag("discover")) await discover(context);
  else if (arg("project")) await fillProject(context, arg("project"), hasFlag("apply"), arg("app-url", ""));
  else console.log("Usage: --discover | --project=<slug-or-url> [--apply] [--app-url=https://...]");
} finally {
  await context.close();
}
