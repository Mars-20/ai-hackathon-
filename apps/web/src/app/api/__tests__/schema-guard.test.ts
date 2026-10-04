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

describe("schema guard", () => {
  test("unified hashes differ without gate documentation", () => {
    const ci = fs.readFileSync(path.join(repoRoot(), ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toMatch(/schema-hash|sha256/);
  });
  test("docs schema marked superseded", () => {
    const doc = fs
      .readFileSync(path.join(repoRoot(), "docs", "supabase-schema.sql"), "utf8")
      .slice(0, 500);
    expect(doc).toMatch(/SUPERSEDED|do not run/i);
  });
});
