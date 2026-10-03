/**
 * Admin access-matrix check (Task 8, spec §§2,6,7 + plan Task 8 Step 1).
 *
 * Covers the route-level contracts of every /api/admin/* route:
 *   - platform tier: full access
 *   - workspace admin/owner: scoped to own workspaceIds (out-of-scope → 403)
 *   - member: read-only where specced (overview/users/content/analytics/ops
 *     reads EXCEPT ops/audit which is admin/owner-only per spec §7 S7-strict;
 *     member-write denied on screen/email-resend/settings*)
 *   - viewer: denied everywhere (rejected at the requireAdmin gate)
 *   - logged-out: 401 with the { error, code } envelope
 *   - NULL-workspace legacy rows: excluded from every workspace-tier
 *     aggregation (platform path uses .not(workspace_id is null);
 *     workspace path uses the scoped .in(workspace_id) predicate, which
 *     never matches NULL)
 *   - C1 bootstrap: fresh DB grants 403 until the seed row exists;
 *     seed script is idempotent + case-insensitive
 *
 * Method: static contract assertions over the shipped source (the plan
 * explicitly sanctions grep-based static checks for the scoping
 * predicates) + LIVE behavioral checks that import the real
 * packages/admin/* TypeScript modules via a --experimental-strip-types
 * child process (anon 401, viewer 403, member/workspace tier, platform
 * tier, scopedQuery 403 + predicate, escaper, pagination).
 *
 * Run: node eval/admin-access-check.mjs   (plain node, no deps)
 * Exit: 0 when every check PASSes, 1 otherwise.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN_API = path.join(ROOT, "apps/web/src/app/api/admin");
const PKG_ADMIN = path.join(ROOT, "packages/admin");

let passed = 0;
let failed = 0;
const failures = [];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function check(name, fn) {
  try {
    const detail = fn();
    passed += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    failed += 1;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(name);
    console.log(`  FAIL  ${name} — ${msg}`);
  }
}

function assertContains(src, needle, label, file) {
  if (!src.includes(needle)) {
    throw new Error(`${label} missing in ${file}: «${needle}»`);
  }
}

function assertNotContains(src, needle, label, file) {
  if (src.includes(needle)) {
    throw new Error(`${label} must be absent in ${file}: «${needle}»`);
  }
}

const ROUTES = [
  "me/route.ts",
  "overview/route.ts",
  "users/route.ts",
  "users/[id]/route.ts",
  "users/[id]/suspend/route.ts",
  "users/[id]/unsuspend/route.ts",
  "workspaces/route.ts",
  "workspaces/[id]/route.ts",
  "content/startups/route.ts",
  "content/flag/route.ts",
  "content/screen/route.ts",
  "content/details/route.ts",
  "analytics/route.ts",
  "analytics/experiments/route.ts",
  "agent/route.ts",
  "ops/limits/route.ts",
  "ops/audit/route.ts",
  "ops/email/route.ts",
  "ops/admins/route.ts",
];

console.log("=".repeat(70));
console.log("Admin access-matrix check (Task 8 — spec ss2,6,7)");
console.log("=".repeat(70));

console.log("\n[A] Route inventory + authoritative gate (every route starts with requireAdmin)");
for (const rel of ROUTES) {
  const file = `apps/web/src/app/api/admin/${rel}`;
  check(`${rel} exists`, () => {
    if (!exists(file)) throw new Error("file missing");
    return `${read(file).split("\n").length} lines`;
  });
  check(`${rel} gates on requireAdminFromSupabase()`, () => {
    assertContains(read(file), "requireAdminFromSupabase()", "admin gate", file);
  });
  check(`${rel} normalizes via toEnvelope()`, () => {
    assertContains(read(file), "toEnvelope", "error envelope", file);
  });
}

console.log("\n[B] Tier matrix — platform full / workspace scoped / member read-only");
check("overview: workspace scoped + NULL excluded + spend estimated", () => {
  const f = "apps/web/src/app/api/admin/overview/route.ts";
  const s = read(f);
  assertContains(s, "scopedAdminQuery", "scoped read", f);
  assertContains(s, '.not("workspace_id", "is", null)', "NULL exclusion", f);
  assertContains(s, "estimated: true", "estimated spend label", f);
});
check("users GET: scoped + prefix email search + sort allowlist", () => {
  const f = "apps/web/src/app/api/admin/users/route.ts";
  const s = read(f);
  assertContains(s, "scopedAdminQuery", "scope discovery", f);
  assertContains(s, "escapePostgrest(search)", "canonical escaper", f);
  assertContains(s, '"email", "created_at"', "sort allowlist", f);
});
check("users PATCH: ROLE_RANK max-own + out-of-scope 403 + RPC role_change", () => {
  const f = "apps/web/src/app/api/admin/users/[id]/route.ts";
  const s = read(f);
  assertContains(s, "ROLE_RANK", "rank guard", f);
  assertContains(s, "Workspace out of scope", "scope 403", f);
  assertContains(s, '"role_change"', "audit-atomic RPC", f);
});
check("users DELETE: revoke via RPC revoke_membership + last-owner 409", () => {
  const f = "apps/web/src/app/api/admin/users/[id]/route.ts";
  const s = read(f);
  assertContains(s, '"revoke_membership"', "RPC revoke branch", f);
  assertContains(s, "Cannot remove the last owner", "last-owner 409", f);
  assertNotContains(s, ".delete()", "direct delete (forbidden on this path)", f);
});
check("suspend: self 400 + last-platform-admin 409 + ban 8760h via RPC", () => {
  const f = "apps/web/src/app/api/admin/users/[id]/suspend/route.ts";
  const s = read(f);
  assertContains(s, "Cannot suspend your own account", "self-suspend 400", f);
  assertContains(s, "last_platform_admin", "last-admin 409", f);
  assertContains(s, '"8760h"', "ban_duration contract", f);
  assertContains(s, '"suspend"', "audit-atomic RPC", f);
});
check("unsuspend: ban none + audit-atomic RPC", () => {
  const f = "apps/web/src/app/api/admin/users/[id]/unsuspend/route.ts";
  const s = read(f);
  assertContains(s, '"none"', "ban lift contract", f);
  assertContains(s, '"unsuspend"', "audit-atomic RPC", f);
});
check("workspaces GET: scope-restricted + usage capped to page ids", () => {
  const f = "apps/web/src/app/api/admin/workspaces/route.ts";
  const s = read(f);
  assertContains(s, "scopedAdminQuery", "scope discovery", f);
  assertContains(s, '.in("id", scopeIds)', "in-scope filter", f);
  assertContains(s, ".in('workspace_id', pageIds)", "batched usage scoping", f);
});
check("workspaces [id] GET: out-of-scope 403 + chunked profile read", () => {
  const f = "apps/web/src/app/api/admin/workspaces/[id]/route.ts";
  const s = read(f);
  assertContains(s, "Workspace out of scope", "scope 403", f);
  assertContains(s, '.in("user_id", chunk)', "IN-filter profile read", f);
});
check("workspaces PATCH: platform-only 403 + denied trail + update_workspace", () => {
  const f = "apps/web/src/app/api/admin/workspaces/[id]/route.ts";
  const s = read(f);
  assertContains(s, 'admin.tier !== "platform"', "platform-only guard", f);
  assertContains(s, 'trailClient.rpc("admin_action"', "denied trail", f);
  assertContains(s, '"update_workspace"', "audit-atomic RPC", f);
});
check("content queue: scoped + verdict/confidence + escaper + NULL excluded", () => {
  const f = "apps/web/src/app/api/admin/content/startups/route.ts";
  const s = read(f);
  assertContains(s, "scopedAdminQuery", "scoped read", f);
  assertContains(s, "escapePostgrest", "canonical escaper", f);
  assertContains(s, '.not("workspace_id", "is", null)', "NULL exclusion", f);
});
check("content flag: member+ rank + out-of-scope 403 + RPC flag_startup", () => {
  const f = "apps/web/src/app/api/admin/content/flag/route.ts";
  const s = read(f);
  assertContains(s, 'ROLE_RANK["member"]', "member+ guard", f);
  assertContains(s, "Startup out of scope", "scope 403", f);
  assertContains(s, '"flag_startup"', "audit-atomic RPC", f);
});
check("content screen: admin+ only (member read-only) + RPC screen_decision", () => {
  const f = "apps/web/src/app/api/admin/content/screen/route.ts";
  const s = read(f);
  assertContains(s, 'ROLE_RANK["admin"]', "admin+ floor (member read-only)", f);
  assertContains(s, '"screen_decision"', "audit-atomic RPC", f);
  assertContains(s, "invalid_workspace_id", "NULL-workspace 400", f);
});
check("content details: scoped both tiers + NULL excluded + 404 no-leak", () => {
  const f = "apps/web/src/app/api/admin/content/details/route.ts";
  const s = read(f);
  assertContains(s, "scopedAdminQuery", "scoped read", f);
  assertContains(s, '.not("workspace_id", "is", null)', "NULL exclusion", f);
});
check("analytics: windowed + truncated flag + NULL excluded", () => {
  const f = "apps/web/src/app/api/admin/analytics/route.ts";
  const s = read(f);
  assertContains(s, "parseAdminWindow", "window parsing", f);
  assertContains(s, "truncated", "truncation flag", f);
  assertContains(s, '.not("workspace_id", "is", null)', "NULL exclusion", f);
  assertContains(s, "scopedAdminQuery", "scoped read", f);
});
check("experiments: sort allowlist + CSV + truncation flag", () => {
  const f = "apps/web/src/app/api/admin/analytics/experiments/route.ts";
  const s = read(f);
  assertContains(s, "SORT_ALLOWLIST", "sort allowlist", f);
  assertContains(s, "text/csv", "CSV export", f);
  assertContains(s, "truncated", "truncation flag", f);
});
check("agent settings: GET-only read view (no write path, no secrets)", () => {
  const f = "apps/web/src/app/api/admin/agent/route.ts";
  const s = read(f);
  assertContains(s, "export async function GET()", "GET read view", f);
  assertNotContains(s, "export async function PUT", "PUT write path", f);
  assertNotContains(s, "export async function POST", "POST write path", f);
  assertNotContains(s, "process.env", "secret materialization", f);
  assertContains(s, "readOnly: true", "read-only meta", f);
});
check("ops limits: windowed + truncated + read-only BUDGET echo", () => {
  const f = "apps/web/src/app/api/admin/ops/limits/route.ts";
  const s = read(f);
  assertContains(s, "parseAdminWindow", "window parsing", f);
  assertContains(s, "truncated", "truncation flag", f);
  assertContains(s, '.not("workspace_id", "is", null)', "NULL exclusion", f);
});
check("ops audit: S7-strict admin+ only + scoped + safe columns + actor/action filters (no stacks)", () => {
  const f = "apps/web/src/app/api/admin/ops/audit/route.ts";
  const s = read(f);
  assertContains(s, "scopedAdminQuery", "scoped read", f);
  assertContains(s, "AUDIT_COLUMNS", "safe column list", f);
  assertContains(s, "no stack traces", "no-stack-trace contract comment", f);
  assertContains(s, 'ROLE_RANK["admin"]', "admin+ floor (S7-strict, member 403)", f);
  assertContains(s, "workspace_members", "role lookup", f);
  assertContains(s, "Audit log requires an admin role or higher", "member 403 message", f);
  assertContains(s, '"FORBIDDEN"', "403 code", f);
  if (/err\.stack|\.stack\b/.test(s)) throw new Error("stack-trace leak in code");
});
check("ops email GET: scoped queue, invite token never selected", () => {
  const f = "apps/web/src/app/api/admin/ops/email/route.ts";
  const s = read(f);
  assertContains(s, "scopedAdminQuery", "scoped read", f);
  assertContains(s, "PENDING_COLUMNS", "safe column list", f);
  if (/\.select\([^)]*token/i.test(s)) throw new Error("token selected");
});
check("ops email POST: platform-only 403 + denied trail + RPC email_resend", () => {
  const f = "apps/web/src/app/api/admin/ops/email/route.ts";
  const s = read(f);
  assertContains(s, 'admin.tier !== "platform"', "platform-only guard", f);
  assertContains(s, '"email_resend"', "audit-atomic RPC", f);
});
check("ops admins GET/POST/DELETE: platform-only 403 + RPC grants + last-admin 409", () => {
  const f = "apps/web/src/app/api/admin/ops/admins/route.ts";
  const s = read(f);
  assertContains(s, 'admin.tier !== "platform"', "platform-only guard", f);
  assertContains(s, '"grant_platform"', "grant RPC", f);
  assertContains(s, '"revoke_platform"', "revoke RPC", f);
  assertContains(s, "Cannot revoke the last platform admin", "last-admin 409", f);
  assertContains(s, "getUserById", "target existence 404", f);
});
check("me: tier only (no PII, no secrets)", () => {
  const f = "apps/web/src/app/api/admin/me/route.ts";
  const s = read(f);
  assertContains(s, "{ tier: admin.tier }", "tier-only response", f);
  assertNotContains(s, "auth.admin", "auth admin surface", f);
});

console.log("\n[C] Gate semantics — logged-out 401 / viewer 403 (static)");
check("requireAdmin: 401 UNAUTHORIZED on null user", () => {
  const f = "packages/admin/requireAdmin.ts";
  const s = read(f);
  assertContains(s, "401", "401 status", f);
  assertContains(s, "UNAUTHORIZED", "401 code", f);
});
check("requireAdmin: viewers excluded from eligible roles, 403 FORBIDDEN", () => {
  const f = "packages/admin/requireAdmin.ts";
  const s = read(f);
  assertContains(s, 'new Set(["member", "admin", "owner"])', "eligible roles", f);
  if (/new Set\(\[[^\]]*"viewer"/.test(s)) throw new Error("viewer in eligible set");
  assertContains(s, "403", "403 status", f);
  assertContains(s, "FORBIDDEN", "403 code", f);
});
check("requireAdmin: platform via is_platform_admin, fail-closed RPC error", () => {
  const f = "packages/admin/requireAdmin.ts";
  const s = read(f);
  assertContains(s, "checkPlatformAdmin", "platform check", f);
  assertContains(s, "failing closed", "fail-closed comment", f);
});

console.log("\n[D] C1 bootstrap — seed script + pre-bootstrap 403");
check("seed script exists and documents the BOOTSTRAP_EMAIL flow", () => {
  const f = "scripts/seed-platform-admin.sql";
  if (!exists(f)) throw new Error("seed script missing");
  const s = read(f);
  assertContains(s, "<BOOTSTRAP_EMAIL>", "runbook placeholder", f);
  assertContains(s, "BOOTSTRAP_EMAIL", "operator flow docs", f);
});
check("seed is idempotent (ON CONFLICT DO NOTHING on the PK)", () => {
  const f = "scripts/seed-platform-admin.sql";
  assertContains(read(f), "ON CONFLICT (user_id) DO NOTHING", "idempotency guard", f);
});
check("seed lookup is case-insensitive (lower(email) = lower(...))", () => {
  const f = "scripts/seed-platform-admin.sql";
  assertContains(read(f), "lower(u.email) = lower(", "case-insensitive match", f);
});
check("seed carries no hardcoded email (placeholder only)", () => {
  const f = "scripts/seed-platform-admin.sql";
  const lines = read(f).split("\n").filter((l) => !l.trim().startsWith("--"));
  if (lines.some((l) => /@/.test(l))) throw new Error("hardcoded email in statement");
});
check("migration: pre-bootstrap grants 403 (platform-only grant/revoke)", () => {
  const f = "packages/db/admin-migration.sql";
  const s = read(f);
  assertContains(s, "grant_platform", "grant branch", f);
  assertContains(s, "revoke_platform", "revoke branch", f);
  assertContains(s, "forbidden", "deny code", f);
});
check("settings write: no v1 write path exists, so no audit-trail gap", () => {
  const mig = read("packages/db/admin-migration.sql");
  const agent = read("apps/web/src/app/api/admin/agent/route.ts");
  assertContains(mig, "settings_change", "deferral ruling note", mig && "packages/db/admin-migration.sql");
  if (/when 'settings_change'/.test(mig)) throw new Error("unexpected settings_change RPC branch");
  assertNotContains(agent, "export async function PUT", "PUT write path", "apps/web/src/app/api/admin/agent/route.ts");
});

console.log("\n[E] Hygiene — envelope, no demo-user, strict TS, deleted dead UI");
check("toEnvelope emits { error, code } only (admin scope)", () => {
  const f = "packages/admin/errors.ts";
  const s = read(f);
  assertContains(s, "error:", "error field", f);
  assertContains(s, "code:", "code field", f);
});
check("no demo-user in admin routes, packages/admin, seed", () => {
  const roots = ["apps/web/src/app/api/admin", "packages/admin", "scripts"];
  for (const root of roots) {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx|mjs|sql)$/.test(e.name)) {
          const s = fs.readFileSync(p, "utf8");
          if (s.includes("demo-user") || s.includes("demo_user")) {
            throw new Error(`demo-user string in ${path.relative(ROOT, p)}`);
          }
        }
      }
    };
    walk(path.join(ROOT, root));
  }
});
check("no explicit any in admin routes or packages/admin", () => {
  const roots = ["apps/web/src/app/api/admin", "packages/admin"];
  for (const root of roots) {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name)) {
          const s = fs.readFileSync(p, "utf8");
          if (/: any\b/.test(s) || /as any\b/.test(s)) {
            throw new Error(`explicit any in ${path.relative(ROOT, p)}`);
          }
        }
      }
    };
    walk(path.join(ROOT, root));
  }
});
check("unused WorkspacePlanForm.tsx deleted (plan UI is read-only in v1)", () => {
  if (exists("apps/web/src/components/admin/WorkspacePlanForm.tsx")) {
    throw new Error("dead plan-write island still present");
  }
});

console.log("\n[F] LIVE gate checks — real packages/admin/* modules with stub deps");
check("live: requireAdmin/escape/pagination/scopedQuery behave per contract", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "admin-live-"));
  const harness = path.join(tmp, "live-check.ts");
  const u = (rel) => pathToFileURL(path.join(PKG_ADMIN, rel)).href;
  fs.writeFileSync(
    harness,
    [
      `import { requireAdmin } from ${JSON.stringify(u("requireAdmin.ts"))};`,
      `import { escapePostgrest } from ${JSON.stringify(u("escape.ts"))};`,
      `import { getPagination } from ${JSON.stringify(u("pagination.ts"))};`,
      `import { scopedQuery } from ${JSON.stringify(u("scopedQuery.ts"))};`,
      "",
      "let n = 0;",
      "function ok(name: string, cond: boolean): void {",
      "  n += 1;",
      "  if (!cond) { console.error(`LIVE_FAIL ${name}`); process.exit(1); }",
      "  console.log(`LIVE_PASS ${name}`);",
      "}",
      "function statusOf(e: unknown): number {",
      "  if (typeof e === \"object\" && e !== null) {",
      "    const r = e as Record<string, unknown>;",
      "    if (typeof r[\"status\"] === \"number\") return r[\"status\"] as number;",
      "  }",
      "  return -1;",
      "}",
      "const anon = { getUser: () => Promise.resolve({ data: { user: null } }),",
      "  checkPlatformAdmin: (_id: string) => Promise.resolve(false),",
      "  listMemberships: (_id: string) => Promise.resolve([]) };",
      "try { await requireAdmin(anon); ok(\"anon-throws\", false); }",
      "catch (e: unknown) { ok(\"anon-401\", statusOf(e) === 401); }",
      "const viewer = { getUser: () => Promise.resolve({ data: { user: { id: \"u1\" } } }),",
      "  checkPlatformAdmin: (_id: string) => Promise.resolve(false),",
      "  listMemberships: (_id: string) => Promise.resolve([{ workspace_id: \"w1\", role: \"viewer\" }]) };",
      "try { await requireAdmin(viewer); ok(\"viewer-throws\", false); }",
      "catch (e: unknown) { ok(\"viewer-403\", statusOf(e) === 403); }",
      "const member = { getUser: () => Promise.resolve({ data: { user: { id: \"u2\" } } }),",
      "  checkPlatformAdmin: (_id: string) => Promise.resolve(false),",
      "  listMemberships: (_id: string) => Promise.resolve([",
      "    { workspace_id: \"w1\", role: \"member\" },",
      "    { workspace_id: \"w2\", role: \"viewer\" }]) };",
      "const m = await requireAdmin(member);",
      "ok(\"member-workspace-tier\", m.tier === \"workspace\");",
      "ok(\"member-scoped-own-only\", m.workspaceIds.length === 1 && m.workspaceIds[0] === \"w1\");",
      "const owner = { getUser: () => Promise.resolve({ data: { user: { id: \"u3\" } } }),",
      "  checkPlatformAdmin: (_id: string) => Promise.resolve(false),",
      "  listMemberships: (_id: string) => Promise.resolve(",
      "    [{ workspace_id: \"w9\", role: \"owner\" }, { workspace_id: \"w1\", role: \"admin\" }]) };",
      "const o = await requireAdmin(owner);",
      "ok(\"owner-workspace-tier\", o.tier === \"workspace\" && o.workspaceIds.length === 2);",
      "const plat = { getUser: () => Promise.resolve({ data: { user: { id: \"u4\" } } }),",
      "  checkPlatformAdmin: (_id: string) => Promise.resolve(true),",
      "  listMemberships: (_id: string) => Promise.resolve([{ workspace_id: \"w1\", role: \"member\" }]) };",
      "const p = await requireAdmin(plat);",
      "ok(\"platform-tier-full\", p.tier === \"platform\");",
      "const stub = { from: (_t: string) => ({}) };",
      "try { await scopedQuery(stub, \"trace_events\", [], (b: object) => b as never); ok(\"scoped-throws\", false); }",
      "catch (e: unknown) { ok(\"scoped-empty-403\", statusOf(e) === 403); }",
      "let seen: unknown = null;",
      "const rec = { from: (_t: string) => ({ in: (c: string, v: string[]) => { seen = [c, v];",
      "  return Promise.resolve({ data: [], error: null }); } }) };",
      "await scopedQuery(rec, \"trace_events\", [\"w1\", \"w2\"], (b: { in(c: string, v: string[]): PromiseLike<unknown> }) => b);",
      "ok(\"scoped-predicate\", Array.isArray(seen) && (seen as unknown[])[0] === \"workspace_id\");",
      "const esc = escapePostgrest(\"a,b(c)%_\");",
      "const stripped = esc.replace(/\\\\./g, \"\");",
      "ok(\"escaper-no-raw-specials\", !/[,()\\%_]/.test(stripped));",
      "const pg = getPagination({});",
      "ok(\"pagination-defaults\", pg.page === 1 && pg.limit === 20);",
      "const clamped = getPagination({ limit: \"9999\" });",
      "ok(\"pagination-clamp-100\", clamped.limit === 100);",
      "console.log(`LIVE_DONE ${n} checks`);",
      "",
    ].join("\n"),
  );
  let out;
  try {
    out = execFileSync(process.execPath, ["--experimental-strip-types", harness], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const stderr = (err && typeof err === "object" && "stderr" in err) ? String(err.stderr) : "";
    throw new Error(`live harness failed: ${stderr.slice(0, 800) || err}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const livePass = (out.match(/LIVE_PASS/g) || []).length;
  if (out.includes("LIVE_FAIL") || !out.includes("LIVE_DONE")) {
    throw new Error(`live harness incomplete:\n${out.slice(0, 800)}`);
  }
  return `${livePass} live assertions green`;
});

console.log("\n" + "=".repeat(70));
console.log(`SUMMARY: ${passed} PASSED / ${failed} FAILED`);
console.log("=".repeat(70));
if (failed > 0) {
  console.log(`Failing checks: ${failures.join("; ")}`);
  process.exit(1);
}
