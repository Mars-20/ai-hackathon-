import { describe, test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// RED: migration 0014 must create the prospects research table (spec §9),
// wire leads.source_prospect_id + prospect_manual_convert (§11.4), lock
// messages to email-only (P1), and enforce the L3 experiment-approval gate
// at the DB level (mirrors campaign.ts app gate). Static file assertions —
// no live DB required.
const repoRoot = path.resolve(process.cwd(), "..", "..");
const MIG = path.join(
  repoRoot,
  "supabase",
  "migrations",
  "20240101000014_prospects_l3.sql",
);

function src(): string {
  return fs.readFileSync(MIG, "utf8");
}

describe("prospects + L3 migration (static)", () => {
  test("migration file exists", () => {
    expect(fs.existsSync(MIG)).toBe(true);
  });

  test("creates prospects research table with match_reason + outreach_status", () => {
    const s = src();
    expect(s).toMatch(/create table if not exists prospects/i);
    expect(s).toMatch(/match_reason/);
    expect(s).toMatch(/outreach_status/);
    expect(s).toMatch(/apollo_id/);
  });

  test("prospects RLS enabled with per-operation authenticated policies", () => {
    const s = src();
    expect(s).toMatch(/prospects enable row level security/i);
    expect(s).toMatch(/create policy "prospects_select"/);
    expect(s).toMatch(/create policy "prospects_insert"/);
    expect(s).toMatch(/to authenticated/);
  });

  test("leads gains source_prospect_id + prospect_manual_convert source", () => {
    const s = src();
    expect(s).toMatch(/source_prospect_id/);
    expect(s).toMatch(/prospect_manual_convert/);
  });

  test("messages locked to email-only (P1) via trigger", () => {
    const s = src();
    expect(s).toMatch(/email/i);
    expect(s).toMatch(/trigger/i);
    expect(s).toMatch(/whatsapp|channel/i);
  });

  test("L3 experiment-approval enforced at DB level on messages", () => {
    const s = src();
    expect(s).toMatch(/approved_by/);
    expect(s).toMatch(/L3 approval required/);
  });

  test("no prospects→messages auto-write path documented", () => {
    const s = src();
    expect(s).toMatch(/prospects/i);
    expect(s).not.toMatch(/insert into (public\.)?messages.*prospect/i);
  });
});
