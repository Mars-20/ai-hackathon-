// Shared Playwright helpers for human-gated dashboard automation.
// The browser profile lives OUTSIDE the repo (Temp dir) so login cookies
// are never at risk of being committed. Secrets are read from
// apps/web/.env.local in-process and never printed — only SET/MISSING.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

export const REPO_ROOT = path.resolve(
  new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  "..",
  "..",
  "..",
  "..",
  ".."
);

export const CHROME_EXE =
  process.env.PW_CHROME_EXE ??
  path.join(
    process.env.USERPROFILE ?? "C:\\Users\\Marslino",
    "AppData",
    "Local",
    "ms-playwright",
    "chromium-1247",
    "chrome-win64",
    "chrome.exe"
  );

// Outside the repo on purpose (holds login cookies).
export const PROFILE_DIR =
  process.env.PW_PROFILE_DIR ??
  "C:\\Users\\Marslino\\AppData\\Local\\Temp\\opencode\\pw-profile";

export const SHOT_DIR =
  process.env.PW_SHOT_DIR ??
  "C:\\Users\\Marslino\\AppData\\Local\\Temp\\opencode\\pw-shots";

export function arg(name, fallback = undefined) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf("=");
  return eq === -1 ? "1" : hit.slice(eq + 1);
}

export function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

export async function launchPersistent({ headless = false } = {}) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: CHROME_EXE,
    headless,
    viewport: { width: 1400, height: 950 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  return context;
}

// Read KEY=VALUE pairs from apps/web/.env.local. Returns a Map.
// NEVER log values — callers must only report key presence.
export function readLocalEnv() {
  const p = path.join(REPO_ROOT, "apps", "web", ".env.local");
  const out = new Map();
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m || line.trim().startsWith("#")) continue;
    out.set(m[1], m[2].trim());
  }
  return out;
}

export function isPlaceholder(v) {
  return !v || /your_|here$|localhost/i.test(v);
}

// Poll every open page until one matches (OAuth hops across vercel.com →
// github.com → back, sometimes in popups). Survives page closes: if the
// user closes all tabs, a fresh dashboard page is opened for them.
export async function waitForLogin(context, { match, homepage, timeoutMs = 600_000 }) {
  const start = Date.now();
  let tick = 0;
  while (Date.now() - start < timeoutMs) {
    let pages = [];
    try {
      pages = context.pages();
    } catch {
      throw new Error("Browser was closed. Re-run the script and keep the window open.");
    }
    const urls = [];
    for (const p of pages) {
      try {
        const u = p.url();
        urls.push(u.length > 120 ? `${u.slice(0, 120)}…` : u);
        if (match(u)) return p;
      } catch {
        // dead page — ignore
      }
    }
    tick += 1;
    if (tick % 15 === 1) {
      const mins = ((Date.now() - start) / 60000).toFixed(1);
      console.log(`…still waiting (${mins} min). Open pages: ${urls.join(" | ") || "(none)"}`);
    }
    if (!pages.length) {
      try {
        const p = await context.newPage();
        await p.goto(homepage).catch(() => {});
      } catch {
        throw new Error("Browser was closed. Re-run the script and keep the window open.");
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Login wait timed out after 10 minutes.");
}

export async function shot(page, name) {
  const p = path.join(SHOT_DIR, `${Date.now()}-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}
