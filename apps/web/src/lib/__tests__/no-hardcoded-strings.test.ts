// Fails on Arabic-script literals in COVERED files.
// Exempt: consent-checkbox.tsx (legal verbatim, permanent).
// R13: three permanent skips — src/lib/ + /api/ walk skips and the src/app/layout.tsx EXEMPT entry (spec-kept Arabic).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // src/lib/__tests__
const SRC = join(HERE, "..", ".."); // src

const EXEMPT = new Set([
  "src/components/consent-checkbox.tsx", // legal text stays Arabic (spec §6)
  "src/app/layout.tsx", // R13: root shell, locale-conditional metadata parked per spec
]);

const AR = /[\u0600-\u06FF]/;

describe("no hardcoded UI strings in covered files", () => {
  it("covered source files contain no Arabic-script literals", () => {
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        if (e === "node_modules" || e === ".next") continue;
        const p = join(dir, e);
        const rel = "src/" + p.slice(SRC.length + 1).replace(/\\/g, "/");
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.tsx?$/.test(e) || e.includes(".test.")) continue;
        if (rel.startsWith("src/lib/")) continue; // R13: lib copy keyed by id in components, lib never calls useTranslations (spec)
        if (rel.includes("/api/")) continue; // R13: API routes out of scope (spec §2)
        if (EXEMPT.has(rel)) continue;
        const src = readFileSync(p, "utf8");
        src.split("\n").forEach((ln, i) => {
          const trimmed = ln.trim();
          if (trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.includes("{/*")) return;
          const code = ln.split("//")[0];
          if (AR.test(code) && !code.includes("i18n-exempt")) bad.push(`${rel}:${i + 1}`);
        });
      }
    };
    walk(SRC);
    expect(bad).toEqual([]);
  });
});
