import { describe, test, expect } from "vitest";
import fs from "fs";
import path from "path";

function loginPageSrc(): string {
  // vitest cwd = apps/web
  return fs.readFileSync(
    path.join(process.cwd(), "src", "app", "[locale]", "login", "page.tsx"),
    "utf8"
  );
}

describe("login OAuth guard — GitHub option removed (unsupported)", () => {
  test("no GitHub OAuth button in login page", () => {
    const src = loginPageSrc();
    expect(src).not.toMatch(/oauth-github-btn/);
    expect(src).not.toMatch(/handleOAuth\("github"\)/);
    expect(src).not.toMatch(/signInWithOAuth[\s\S]*?github/);
  });

  test("no github provider type or Github icon wiring", () => {
    const src = loginPageSrc();
    expect(src).not.toMatch(/"google" \| "github"/);
    expect(src).not.toMatch(/provider:\s*"github"/);
    // Lucide Github icon must be gone (case-sensitive component import)
    expect(src).not.toMatch(/\{[^}]*\bGithub\b[^}]*\}\s*from\s*"lucide-react"/);
    expect(src).not.toMatch(/<Github\b/);
  });

  test("Google OAuth button still present and full-width", () => {
    const src = loginPageSrc();
    expect(src).toMatch(/oauth-google-btn/);
    expect(src).toMatch(/handleOAuth\("google"\)/);
    expect(src).toMatch(/signInWithOAuth/);
  });
});
