import { defineConfig } from "@playwright/test";
import path from "node:path";

// Reuse the pre-installed Playwright Chromium (no browser download needed).
// Override with PW_CHROME_EXE if your build differs.
const CHROME_EXE =
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

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    launchOptions: { executablePath: CHROME_EXE },
  },
  // Serves the production build (run `npm run build` first).
  // Set E2E_BASE_URL to point at an already-running server instead.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run start -- --port 3100",
        url: "http://127.0.0.1:3100",
        reuseExistingServer: true,
        timeout: 180_000,
      },
});
