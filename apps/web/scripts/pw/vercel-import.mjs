// Vercel project import assistant — creates the project from GitHub,
// configures Root Directory + env vars, and Deploys.
//
// Flow: https://vercel.com/new → Import Mars-20/ai-hackathon- →
// Root Directory apps/web → add env vars → Deploy → capture prod URL.
//
// Usage:
//   PW_CHANNEL=msedge node scripts/pw/vercel-import.mjs [--apply]
// Without --apply: walks to the configure page and prints the plan only.
// NOTE: if the repo is not listed, grant the Vercel GitHub App access in
// the opened window (Configure link) — the script waits up to 10 minutes
// for the repo row to appear.
import { hasFlag, isPlaceholder, launchPersistent, readLocalEnv, shot, waitForLogin } from "./common.mjs";

const REPO_NEEDLE = "ai-hackathon";
const REPO_FULL = "Mars-20/ai-hackathon-";
const ROOT_DIR = "apps/web";
const KNOWN_KEYS = [
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "APOLLO_API_KEY",
];

async function ensureLoggedIn(context) {
  const probe = await context.newPage();
  await probe.goto("https://vercel.com/dashboard", { waitUntil: "domcontentloaded" }).catch(() => {});
  if (!/vercel\.com\/login/.test(probe.url())) return probe;
  console.log("LOGIN NEEDED: complete sign-in in the opened browser window (session may have expired).");
  const logged = await waitForLogin(context, {
    homepage: "https://vercel.com/dashboard",
    match: (u) => /vercel\.com/.test(u) && !/vercel\.com\/login/.test(u),
  });
  await probe.close().catch(() => {});
  return logged;
}

async function findRepoRow(page) {
  // Search box first (import list can be long).
  const search = page.getByPlaceholder(/search/i).first();
  if (await search.count()) {
    await search.fill(REPO_NEEDLE).catch(() => {});
    await page.waitForTimeout(2500);
  }
  const row = page.locator("li, div", { hasText: REPO_FULL }).last();
  return row;
}

async function waitForRepo(page, timeoutMs = 600_000) {
  const start = Date.now();
  let announced = false;
  while (Date.now() - start < timeoutMs) {
    const row = await findRepoRow(page);
    if ((await row.count()) > 0) return row;
    if (!announced) {
      console.log(`Repo "${REPO_FULL}" not listed. If needed, click "Configure"/"Adjust GitHub App Permissions"`);
      console.log("in the window to grant access, then come back — waiting up to 10 minutes…");
      announced = true;
    }
    await page.waitForTimeout(5000);
  }
  return null;
}

async function setRootDirectory(page) {
  // Root Directory row → Edit → type apps/web → Save.
  const editBtn = page
    .locator("div", { hasText: "Root Directory" })
    .locator("..")
    .getByRole("button", { name: /edit/i })
    .first();
  if (!(await editBtn.count())) {
    console.log("Root Directory Edit button not found — leaving default (will fix after import if needed).");
    return false;
  }
  await editBtn.click();
  const input = page.locator('input[value="./"], input[placeholder*="directory" i]').first();
  await input.waitFor({ timeout: 15_000 });
  await input.fill(ROOT_DIR);
  const save = page.getByRole("button", { name: /^(save|continue|done)$/i }).first();
  if (await save.count()) await save.click().catch(() => {});
  await page.waitForTimeout(1500);
  console.log(`Root Directory set to ${ROOT_DIR}.`);
  return true;
}

async function addEnvOnConfigurePage(page, key, value) {
  // New-project env UI: Key + Value inputs + Add button (envs default to all).
  const section = page.locator("section, div", { hasText: "Environment Variables" }).first();
  const keyBox = section.locator('input[placeholder*="key" i], input[name="key"]').first();
  await keyBox.waitFor({ timeout: 15_000 });
  await keyBox.fill(key);
  const valBox = section.locator('input[placeholder*="value" i], input[name="value"], input[type="password"]').first();
  await page.evaluate((text) => navigator.clipboard.writeText(text), value);
  await valBox.click();
  await page.keyboard.press("ControlOrMeta+v");
  const add = section.getByRole("button", { name: /^add$/i }).first();
  await add.click({ timeout: 10_000 });
  await page.waitForTimeout(1200);
}

async function deployAndCaptureUrl(page, timeoutMs = 900_000) {
  const deploy = page.getByRole("button", { name: /^deploy$/i }).first();
  await deploy.waitFor({ timeout: 30_000 });
  await deploy.click();
  console.log("Deploy clicked — waiting for the build (up to 15 min)…");
  // Success state shows the production domain + "Visit" / confetti.
  await page
    .waitForURL(/vercel\.com\/[^/]+\/[^/]+\/\S*success|vercel\.com\/[^/]+\/[^/]+$/, { timeout: timeoutMs })
    .catch(() => {});
  await page.waitForTimeout(5000);
  const links = await page.$$eval('a[href^="https://"]', (as) => {
    const out = [];
    for (const a of as) {
      const h = a.getAttribute("href") || "";
      const host = h.split("/")[2] || "";
      if (/vercel\.app$/.test(host) && !out.includes(h)) out.push(h);
    }
    return out;
  }).catch(() => []);
  return links;
}

const apply = hasFlag("apply");
const context = await launchPersistent();
const page = await ensureLoggedIn(context);
try {
  await page.goto("https://vercel.com/new", { waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  const row = await waitForRepo(page);
  if (!row) {
    const s = await shot(page, "vercel-import-norepo");
    console.log(`Repo row never appeared (screenshot: ${s}).`);
    process.exitCode = 2;
  } else {
    console.log(`Found repo row for ${REPO_FULL}.`);
    const importBtn = row.getByRole("button", { name: /^import$/i }).first();
    const count = await importBtn.count();
    console.log(`Import button present: ${count > 0}. apply=${apply}`);
    if (!apply || !count) {
      if (!count) {
        const s = await shot(page, "vercel-import-nobutton");
        console.log(`Import button not found in row (screenshot: ${s}).`);
      } else console.log("Dry run — re-run with --apply to click Import and continue.");
    } else {
      await importBtn.click();
      await page.waitForTimeout(4000);
      console.log(`Configure page: ${page.url()}`);
      await setRootDirectory(page).catch(async (e) => {
        console.log(`Root-dir step issue: ${String(e.message || e).slice(0, 160)}`);
      });
      const local = readLocalEnv();
      for (const k of KNOWN_KEYS) {
        const v = local.get(k) ?? "";
        if (isPlaceholder(v)) {
          console.log(`  SKIP ${k}: not set locally`);
          continue;
        }
        try {
          await addEnvOnConfigurePage(page, k, v);
          console.log(`  ADDED ${k}`);
        } catch (e) {
          const s = await shot(page, `vercel-import-env-${k}`);
          console.log(`  ENV-FAILED ${k}: ${String(e.message || e).slice(0, 160)} (screenshot: ${s})`);
        }
      }
      console.log("NOTE: UPSTASH_* + NEXT_PUBLIC_APP_URL are added after the first deploy (APP_URL needs the prod domain).");
      const urls = await deployAndCaptureUrl(page);
      console.log(`Production URLs found: ${urls.length ? urls.join(", ") : "(none captured — check dashboard)"}`);
    }
  }
} finally {
  await context.close();
}
