import { describe, test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// No live DB: static SQL-text assertions for Task 4 RLS hardening.
// Repo root resolved from apps/web cwd (vitest runs with cwd=apps/web).
const repoRoot = path.resolve(process.cwd(), "..", "..");
const migrationPath = path.join(
  repoRoot,
  "supabase",
  "migrations",
  "20240101000002_hardening.sql",
);
const unifiedPath = path.join(repoRoot, "packages", "db", "schema-unified.sql");
const basePath = path.join(
  repoRoot,
  "supabase",
  "migrations",
  "20240101000000_schema_unified.sql",
);

function read(p: string): string {
  return fs.readFileSync(p, "utf8");
}

describe("trace RLS hardening (Task 4, no live DB)", () => {
  test("base 0000 documents the pre-hardening weakness (guard: test is real)", () => {
    const base = read(basePath);
    // Pre-hardening: authenticated trace_insert is wide-open.
    expect(base).toMatch(/trace_insert/i);
    expect(base).toMatch(/with\s+check\s*\(\s*true\s*\)/i);
  });

  test("0002 migration exists and removes open trace insert for authenticated", () => {
    const sql = read(migrationPath);
    // Must recreate trace_insert without open CHECK (true) for authenticated.
    // A service_role-only policy may legitimately use WITH CHECK (true);
    // forbid the authenticated + CHECK(true) combination specifically.
    const authenticatedCheckTrue =
      /for\s+insert\s+to\s+authenticated[\s\S]{0,300}?with\s+check\s*\(\s*true\s*\)/i;
    expect(sql).not.toMatch(authenticatedCheckTrue);
    // Tightened replacement: authenticated insert gated on startup link + membership.
    expect(sql).toMatch(/trace_insert/i);
    expect(sql).toMatch(/private\.(is_workspace_member|workspace_role)/i);
  });

  test("0002 tightens trace_select: no startup_id IS NULL bypass for authenticated", () => {
    const sql = read(migrationPath);
    expect(sql).toMatch(/trace_select/i);
    // The old bypass `startup_id is null or ...` must not appear in the
    // authenticated trace_select replacement.
    expect(sql).not.toMatch(/startup_id\s+is\s+null\s+or/i);
  });

  test("0002 moves helpers to private with fixed search_path + REVOKE", () => {
    const sql = read(migrationPath);
    expect(sql).toMatch(/create\s+schema\s+if\s+not\s+exists\s+private/i);
    expect(sql).toMatch(/private\.is_workspace_member/i);
    expect(sql).toMatch(/private\.workspace_role/i);
    expect(sql).toMatch(/set\s+search_path\s*=\s*(''|"")/i);
    expect(sql).toMatch(/revoke/i);
    expect(sql).toMatch(/anon/i);
    expect(sql).toMatch(/authenticated/i);
    // Qualified table refs inside SECURITY DEFINER helpers.
    expect(sql).toMatch(/public\.workspace_members/i);
  });

  test("0002 hardens update_updated_at + documents workspace_id NOT NULL follow-up", () => {
    const sql = read(migrationPath);
    expect(sql).toMatch(/update_updated_at/i);
    expect(sql).toMatch(/set\s+search_path/i);
    expect(sql).toMatch(/backfill/i);
    expect(sql).toMatch(/workspace_id/i);
  });

  test("unified source matches migration intent", () => {
    const unified = read(unifiedPath);
    // Private-helpers note + hardened trigger + tightened trace + superseded doc.
    expect(unified).toMatch(/private/i);
    expect(unified).toMatch(/update_updated_at[\s\S]{0,200}?set\s+search_path/i);
    expect(unified).not.toMatch(
      /for\s+insert\s+to\s+authenticated[\s\S]{0,300}?with\s+check\s*\(\s*true\s*\)/i,
    );
    expect(unified).toMatch(/private\.(is_workspace_member|workspace_role)/i);
    expect(unified).toMatch(/docs\/supabase-schema\.sql/i);
  });
});
