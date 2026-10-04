import { describe, test, expect } from "vitest";
import fs from "fs";
import path from "path";

function repoRoot(): string {
  const cwd = process.cwd();
  if (path.basename(cwd) === "web" && fs.existsSync(path.join(cwd, "package.json"))) {
    return path.resolve(cwd, "..", "..");
  }
  return path.resolve(cwd);
}

describe("secrets guard", () => {
  test("mcp_config not tracked with plaintext keys", () => {
    const gitignore = fs.readFileSync(path.join(repoRoot(), ".gitignore"), "utf8");
    expect(gitignore).toMatch(/\.agents\/mcp_config\.json/);
  });
  test("env.example has placeholders only", () => {
    const ex = fs.readFileSync(path.join(repoRoot(), "apps", "web", ".env.example"), "utf8");
    expect(ex).not.toMatch(/gsk_[A-Za-z0-9]{10,}/);
    expect(ex).not.toMatch(/AQ\.Ab8/);
  });
});
