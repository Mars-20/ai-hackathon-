# Evidence Grounding Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop ungrounded synthesis output from being stored, cited, and displayed as evidence, quarantine the 150 contaminated prod rows reversibly, and add the guardrails that make a repeat structurally impossible.

**Architecture:** Defense in depth on the existing market-research flow: tag grounding state at creation (pure helpers, TDD), exclude ungrounded rows from the memo prompt and the verifier support set, add a persistence safety net, quarantine history via a reversible additive migration, surface grounding state in the UI, and emit per-run grounding counts on the trace. No flow restructuring, no new subsystem, no breaking schema change (expand-only migration).

**Tech Stack:** Next.js route handler (`apps/web/src/app/api/agent/route.ts`), pure helpers (`apps/web/src/lib/skills-helpers.ts`, `apps/web/src/lib/utils.ts`), Supabase Postgres (SQL migration, Management API for prod verification), Vitest (`node node_modules/vitest/vitest.mjs run`), tsc (`node node_modules/typescript/bin/tsc --noEmit` from `apps/web`).

**Spec:** Diagnosis-driven fix on an existing flow — no separate spec doc. Design brief is §0 below; the normative grounding contract is `packages/skills/evidence-quality-coach/playbook.md` (100% citation rule for market numbers) plus the in-code contracts cited per task. Executors read this plan plus the cited file regions.

## Global Constraints

- Arabic discussion, English code/prompts/UI — user-facing copy stays English.
- TDD (RED → GREEN), DRY/YAGNI, frequent commits on `main` (main-only workflow; no feature branches, no worktrees for this plan).
- Best-effort persistence rule: DB writes never break the SSE stream (existing try/catch around persistence in `route.ts:2594+` stays intact; new code adds no throwing path into the stream).
- Additive migration only: new nullable columns with defaults; no CHECK change on existing columns; every migration ships a down script and is idempotent (`WHERE grounding_status IS NULL`).
- Quarantine, never hard-delete, user-visible history (decision B, approved default; reversible at all times).
- Windows commands: Vitest via `node node_modules/vitest/vitest.mjs run <path>`; tsc via `node node_modules/typescript/bin/tsc --noEmit` with `workdir` = `apps/web`; build via `npm.cmd run build` with `workdir` = `apps/web`.

## Review Focus

- Arabic-Indic digits (`٢٠٢٥`, `٥٠٪`) bypass a `\d`-only numeric detector, so a numeric market claim in Arabic slips the creation gate — the detector must cover `0-9`, `٠-٩`, `%`, `٪`, `$`, `B/M/K`, `billion|million|trillion|مليار|مليون`.
- Citation markers (`[S1]`, `[E3]`) contain digits that must never trip the numeric detector (established pattern: `CITATION_MARKER_RE` strip-first in `utils.ts:268`).
- `source_url` empty-string vs NULL: the fallback path writes `?? null`, but a future provider may return `""` — grounding checks must treat `""`, whitespace-only, and non-http(s) values as ungrounded (established pattern: `isHttpUrl` in `route.ts:1190`).
- Prod backfill blast radius: the quarantine UPDATE must touch exactly the fallback-path signature (`source_url IS NULL AND source_type IS NULL AND evidence_type = 'secondary'`); a dry-run `SELECT count(*)` with the identical predicate gates the write, and the count must equal the forensically confirmed 150 before proceeding.
- SSE/UI consumers of evidence counts (`validate/page.tsx`, history route) must keep rendering when `grounding_status` is NULL (pre-migration rows, local dev without migration) — NULL means "legacy, treat as grounded for display, excluded from memo grounding".

---

## §0 Design brief (what the forensics proved)

- Creation hole — `route.ts:1202-1219`: the `else` branch (ungrounded search result) pushes an `Evidence` row with no `source_type`/`source_url` and `strength: "opinion"`, even when `r.claim` contains market numbers (`$216.5B`, `18-20% CAGR`). The trace warning at `route.ts:1212-1218` observes but gates nothing.
- Prompt hole — `route.ts:1690-1693`: `evidenceSummary` formats every row as `[type/strength] claim` with no grounding marker, so the memo model treats sourceless claims as evidence.
- Verifier hole — `route.ts:1760` + `utils.ts:339-349`: `combineVerifierWithMemoScan(memoText, allEvidence)` checks memo lines against `allEvidence`, which *contains* the sourceless claims; `claimHasUrlSupport` (`utils.ts:242-262`) requires `e.source_url`, so memo lines paraphrasing a sourceless claim match nothing → flagged; but memo lines *quoting numbers that appear in a sourceless claim* also match nothing → flagged as well. Net effect observed in prod: memos stayed qualitative (`low`/`test_more`) while 150 numeric rows sat in the DB unflagged — the verifier guards the memo, nobody guards the rows.
- Persistence hole — `route.ts:2640-2649`: verbatim insert, no quality gate.
- Schema facts (`docs/supabase-schema.sql:101-104`): `source_type TEXT CHECK (source_type IN ('web_search','interview','survey','preorder','usage_data'))` (nullable), `strength TEXT NOT NULL CHECK (strength IN ('opinion','intent','time_given','contact_shared','commitment'))`. New enum values would need CHECK rewrites → the plan uses a new nullable `grounding_status` column instead (expand-only).
- Prod scope (2026-10-09, Supabase Management API): `evidence` 258 rows, 150 with `source_type IS NULL AND source_url IS NULL` (all secondary, numeric market claims, `strength='opinion'`); 108 grounded `web_search`. `decisions` 19 × `test_more/low`. `assumptions` 135 healthy. `experiments` 19 × `interview/draft`.

---

## File structure

- Modify: `apps/web/src/lib/skills-helpers.ts` — add `isGroundedEvidence`, `splitEvidenceByGrounding`, `claimHasNumericContent` (pure, unit-tested).
- Test: `apps/web/src/lib/__tests__/evidence-grounding.test.ts` — new, covers the four helpers.
- Modify: `apps/web/src/app/api/agent/route.ts` — creation tagging (`runMarketResearchSkill` else-branch), memo `evidenceSummary` + verifier support set (`runDecisionMemoSkill`), persistence safety net (insert block), per-run trace counts.
- Modify: `apps/web/src/lib/utils.ts` — `VerifierEvidence` input type gains optional `grounding_status`; `claimHasUrlSupport` skips `grounding_status !== 'grounded'` rows (NULL = legacy grounded).
- Create: `supabase/migrations/20261009_add_evidence_grounding_status.sql` — additive columns + idempotent quarantine backfill + down script (comment block, single file per repo convention; confirm convention in Task 2 Step 1 — if the repo uses applied-migration tooling instead of files, follow the tool).
- Modify: `apps/web/src/app/[locale]/validate/page.tsx` — unverified badge near `e.source_url` render (`:289` region); grounded-count line (`:1356` region) keeps NULL-safe behavior.
- Modify: `apps/web/src/app/api/history/route.ts:88` — select list gains `grounding_status, quarantined_at`.
- Modify: `packages/skills/evidence-quality-coach/playbook.md` — append the grounding persistence rule (methodology alignment, 3-5 lines, no restructure).
- Test: extend `apps/web/src/app/api/__tests__/verifier-gate.test.ts` — memo-scan exclusion of ungrounded rows (append-only new cases).

---

### Task 1: Grounding helpers + unit tests (TDD)

**Files:**
- Modify: `apps/web/src/lib/skills-helpers.ts`
- Test: `apps/web/src/lib/__tests__/evidence-grounding.test.ts` (new)

**Interfaces:**
- Consumes: `Evidence` type (existing import in `skills-helpers.ts` — verify name in Step 1; if the file imports from a types module, reuse it, do not redefine), `isHttpUrl` (already used in `route.ts:1190`; if it lives in `route.ts`, move-or-duplicate a copy into `skills-helpers.ts` — check first, single canonical location preferred).
- Produces: `isGroundedEvidence(e: { source_url?: string | null; source_type?: string | null; grounding_status?: string | null }): boolean` — true iff `grounding_status` is `'grounded'` or NULL (legacy) AND `source_url` is a non-empty http(s) URL AND `source_type` is non-null. Any other `grounding_status` (`'unverified'`, `'quarantined'`) → false even with a URL.
- Produces: `splitEvidenceByGrounding<T extends { source_url?: string | null; source_type?: string | null; grounding_status?: string | null }>(rows: T[]): { grounded: T[]; ungrounded: T[] }` — stable-order partition via `isGroundedEvidence`.
- Produces: `claimHasNumericContent(claim: string): boolean` — strips `CITATION_MARKER_RE`-style markers (`\[[SAEDMW]\d+\]`) first, then tests `NUMERIC_CLAIM_RE = /(\d|٠-٩|%|٪|\$|million|billion|trillion|مليار|مليون|CAGR)/i`.
- Produces: `ungroundedCount(rows): number` — `splitEvidenceByGrounding(rows).ungrounded.length` (convenience for trace metrics).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import {
  claimHasNumericContent,
  isGroundedEvidence,
  splitEvidenceByGrounding,
} from "../skills-helpers";

describe("isGroundedEvidence", () => {
  it("accepts a grounded web_search row", () => {
    expect(
      isGroundedEvidence({ source_type: "web_search", source_url: "https://example.com/report", grounding_status: "grounded" })
    ).toBe(true);
  });
  it("treats NULL grounding_status with URL as legacy grounded", () => {
    expect(
      isGroundedEvidence({ source_type: "web_search", source_url: "https://example.com/report", grounding_status: null })
    ).toBe(true);
  });
  it("rejects the fallback-path signature (null source, null url)", () => {
    expect(isGroundedEvidence({ source_type: null, source_url: null, grounding_status: null })).toBe(false);
  });
  it("rejects empty-string and non-http URLs", () => {
    expect(isGroundedEvidence({ source_type: "web_search", source_url: "  ", grounding_status: null })).toBe(false);
    expect(isGroundedEvidence({ source_type: "web_search", source_url: "ftp://example.com/x", grounding_status: null })).toBe(false);
  });
  it("rejects quarantined rows even when a URL is present", () => {
    expect(
      isGroundedEvidence({ source_type: "web_search", source_url: "https://example.com/report", grounding_status: "quarantined" })
    ).toBe(false);
  });
});

describe("claimHasNumericContent", () => {
  it("detects market numbers and ignores citation markers", () => {
    expect(claimHasNumericContent("Global market valued at $216.5B in 2024")).toBe(true);
    expect(claimHasNumericContent("CAGR of 18-20% through 2030")).toBe(true);
    expect(claimHasNumericContent("Founders struggle with landing pages [S1]")).toBe(false);
    expect(claimHasNumericContent("السوق ينمو بمعدل ٢٠٪ سنويا")).toBe(true);
  });
});

describe("splitEvidenceByGrounding", () => {
  it("partitions stably", () => {
    const rows = [
      { id: "a", source_type: "web_search", source_url: "https://a.example", grounding_status: null },
      { id: "b", source_type: null, source_url: null, grounding_status: null },
    ];
    const { grounded, ungrounded } = splitEvidenceByGrounding(rows);
    expect(grounded.map((r) => r.id)).toEqual(["a"]);
    expect(ungrounded.map((r) => r.id)).toEqual(["b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (workdir `apps/web`): `node node_modules/vitest/vitest.mjs run src/lib/__tests__/evidence-grounding.test.ts`
Expected: FAIL with "isGroundedEvidence is not defined" (or import error).

- [ ] **Step 3: Write minimal implementation** in `apps/web/src/lib/skills-helpers.ts` (append a `// ── Evidence grounding ──` section; reuse the file's existing `Evidence`-ish structural types — do not introduce a second canonical `Evidence` interface):

```ts
const CITATION_MARKER_STRIP_RE = /\[[SAEDMW]\d+\]/g;
const NUMERIC_CLAIM_RE = /(\d|%|\$|million|billion|trillion|CAGR|مليار|مليون)/i;
// Note: \d in JS without /u ASCII flag matches ASCII 0-9 only; Arabic-Indic
// digits are matched explicitly below.
const ARABIC_INDIC_DIGIT_RE = /[٠-٩]/;

function isHttpUrlStrict(url: string | null | undefined): boolean {
  if (!url) return false;
  const t = url.trim();
  return t.startsWith("http://") || t.startsWith("https://");
}

export interface Groundable {
  source_url?: string | null;
  source_type?: string | null;
  grounding_status?: string | null;
}

export function isGroundedEvidence(e: Groundable): boolean {
  if (e.grounding_status !== undefined && e.grounding_status !== null && e.grounding_status !== "grounded") return false;
  if (!e.source_type) return false;
  return isHttpUrlStrict(e.source_url);
}

export function splitEvidenceByGrounding<T extends Groundable>(rows: T[]): { grounded: T[]; ungrounded: T[] } {
  const grounded: T[] = [];
  const ungrounded: T[] = [];
  for (const r of rows) (isGroundedEvidence(r) ? grounded : ungrounded).push(r);
  return { grounded, ungrounded };
}

export function claimHasNumericContent(claim: string): boolean {
  const stripped = claim.replace(CITATION_MARKER_STRIP_RE, "");
  return NUMERIC_CLAIM_RE.test(stripped) || ARABIC_INDIC_DIGIT_RE.test(stripped);
}

export function ungroundedCount<T extends Groundable>(rows: T[]): number {
  return splitEvidenceByGrounding(rows).ungrounded.length;
}
```

(If `isHttpUrl` already exists as an exported helper, import and reuse it instead of `isHttpUrlStrict` — check in Step 1 and delete the duplicate.)

- [ ] **Step 4: Run test to verify it passes**

Run (workdir `apps/web`): `node node_modules/vitest/vitest.mjs run src/lib/__tests__/evidence-grounding.test.ts`
Expected: PASS (all 10 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/skills-helpers.ts apps/web/src/lib/__tests__/evidence-grounding.test.ts
git commit -m "feat(evidence): grounding helpers with numeric-claim detector"
```

**Acceptance:** 10/10 new tests pass; `node node_modules/typescript/bin/tsc --noEmit` (workdir `apps/web`) clean; no other file touched.

---

### Task 2: Additive migration — `grounding_status` + `quarantined_at`

**Files:**
- Create: `supabase/migrations/20261009_add_evidence_grounding_status.sql`

**Interfaces:**
- Consumes: live prod schema introspection (Step 1 queries — read-only).
- Produces: migration file with UP (additive DDL + idempotent backfill) and DOWN (comment block; exact statements) that the repo's migration tooling applies.

- [ ] **Step 1: Confirm prod schema + repo migration convention (read-only)**

Run via Supabase Management API (`POST https://api.supabase.com/v1/projects/qgolznxdfokbggsdmxlu/database/query`, token from operator at execution time — never committed):
1. `select column_name, data_type, is_nullable from information_schema.columns where table_schema='public' and table_name='evidence' order by ordinal_position;`
2. `select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid='public.evidence'::regclass and contype='c';`
3. Dry-run predicate count: `select count(*) as n, count(*) filter (where claim ~ '[0-9]' or claim ~ '[$%]') as numeric_n from public.evidence where source_url is null and source_type is null and evidence_type='secondary' and grounding_status is null;` — record both numbers; proceed to Step 3 only if `n` equals the forensic 150 (any drift → stop, re-forensicate, update this plan).

Also confirm how migrations ship in this repo (Step 1b): check `supabase/` dir for applied-migration tooling vs raw files, and mirror the last applied migration's header style exactly.

- [ ] **Step 2: Write the migration file** (UP + DOWN in one file per repo convention; statements below are exact):

```sql
-- UP: expand-only. Nullable columns; existing rows read as NULL = legacy.
alter table public.evidence
  add column if not exists grounding_status text
    check (grounding_status in ('grounded', 'unverified', 'quarantined')),
  add column if not exists quarantined_at timestamptz;

-- Backfill (idempotent): quarantine exactly the fallback-path signature.
-- Dry-run first: the SELECT in Task 2 Step 1 must return n = 150.
update public.evidence
   set grounding_status = 'quarantined',
       quarantined_at = now()
 where source_url is null
   and source_type is null
   and evidence_type = 'secondary'
   and grounding_status is null;

-- DOWN (rollback): restores pre-migration state, no data loss.
-- update public.evidence set grounding_status = null, quarantined_at = null where grounding_status = 'quarantined';
-- alter table public.evidence drop column if exists quarantined_at;
-- alter table public.evidence drop column if exists grounding_status;
```

- [ ] **Step 3: Apply to prod via the repo's migration tooling, then verify**

Run: apply per repo convention (record the exact command used in the commit message body). Verify with:
1. `select grounding_status, count(*) from public.evidence group by 1;` — expect `quarantined` = Step-1 `n`, rest NULL.
2. `select count(*) from public.evidence where grounding_status='quarantined' and (source_url is not null or source_type is not null);` — expect 0 (no grounded row mis-quarantined).

- [ ] **Step 4: Commit the migration file**

```bash
git add supabase/migrations/20261009_add_evidence_grounding_status.sql
git commit -m "feat(db): evidence grounding_status + reversible quarantine backfill"
```

**Acceptance:** prod `group by` shows exactly `n` quarantined / 0 mis-quarantined; DOWN script present and syntactically valid; app code untouched (code tasks read the new columns only after this task is green — contract dependency for Tasks 3-5).

---

### Task 3: Creation tagging + persistence safety net (`route.ts`)

**Files:**
- Modify: `apps/web/src/app/api/agent/route.ts` (two regions: `runMarketResearchSkill` else-branch ~`:1202-1219`; persist block ~`:2640-2649`)
- Test: existing suite regression only (new pure logic lives in Task 1; here assert trace shape via a route-level test only if the repo has a harness for `runMarketResearchSkill` — check `apps/web/src/app/api/__tests__/` first; if no harness exists, YAGNI: skip new route test, rely on trace-event assertion in Task 6 prod verification).

**Interfaces:**
- Consumes: `isGroundedEvidence`, `splitEvidenceByGrounding`, `claimHasNumericContent` (Task 1), `makeTrace` (existing).
- Produces: every `Evidence` object pushed in the ungrounded branch carries `grounding_status: "unverified"`; grounded branch carries `grounding_status: "grounded"`; persist block partitions and emits one `skill:market-research/verification` trace event `{ action: "persistence_gate", grounded: <n>, unverified: <n>, numeric_unverified_dropped_from_memo: <n> }`.

- [ ] **Step 1: Tag the creation branches**

In the grounded push (`route.ts:1191-1201`) add `grounding_status: "grounded"`. In the ungrounded push (`route.ts:1203-1211`) keep the shape identical to today (no `source_type`/`source_url` keys) and add only `grounding_status: "unverified"` — creation stays a faithful record of what the tool returned; the numeric distinction is enforced downstream in Task 4, not here. Extend the existing `trace.push({... warning: "ungrounded" ...})` payload with `numeric: claimHasNumericContent(r.claim)`. Also add `grounding_status?: string | null` to the `Evidence` interface (find it via the `allResults: Evidence[]` declaration at `route.ts:1150` and follow its import — one canonical edit, reused by Tasks 4-5).

- [ ] **Step 2: Persistence safety net**

Replace the verbatim evidence insert (`route.ts:2640-2649`) with a partitioned insert:

```ts
if (allEvidence.length > 0) {
  const gate = splitEvidenceByGrounding(allEvidence);
  trace.push(
    makeTrace("skill:market-research", "verification", {
      action: "persistence_gate",
      grounded: gate.grounded.length,
      unverified: gate.ungrounded.length,
    })
  );
  await supabase.from("evidence").insert(
    allEvidence.map((e) => ({
      id: e.id, startup_id: startup.id, workspace_id: workspaceId || null,
      assumption_id: e.assumption_id ?? null, evidence_type: e.evidence_type,
      source_type: e.source_type ?? null, source_url: e.source_url ?? null,
      grounding_status: isGroundedEvidence(e) ? "grounded" : "unverified",
      claim: e.claim, strength: e.strength, sample_size: e.sample_size ?? null,
    }))
  );
}
```

(Type note: `Evidence` interface needs the optional `grounding_status?: string | null` field — add it to the interface wherever it is declared; find via the `allResults: Evidence[]` declaration at `route.ts:1150` and follow its import. If `Evidence` is a shared type, the same field covers `utils.ts` consumers in Task 4.)

- [ ] **Step 3: Run regression battery**

Run (workdir `apps/web`): `node node_modules/vitest/vitest.mjs run src/lib/__tests__/evidence-grounding.test.ts src/app/api/__tests__/verifier-gate.test.ts src/app/api/__tests__/threshold.test.ts`
Expected: PASS. Then `node node_modules/typescript/bin/tsc --noEmit` — clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/api/agent/route.ts
git commit -m "feat(agent): tag evidence grounding at creation + persistence safety net"
```

**Acceptance:** ungrounded rows can no longer reach the DB without `grounding_status='unverified'`; every run emits a `persistence_gate` trace event; battery green.

---

### Task 4: Memo prompt + verifier support set exclusion

**Files:**
- Modify: `apps/web/src/app/api/agent/route.ts` (`runDecisionMemoSkill` evidenceSummary ~`:1690-1693`; verifier call ~`:2553` and memo rescan ~`:1760`)
- Modify: `apps/web/src/lib/utils.ts` (`claimHasUrlSupport` ~`:242-262`, `combineVerifierWithMemoScan` ~`:339-349`: extend row type with `grounding_status?`, skip non-grounded rows)
- Test: append cases to `apps/web/src/app/api/__tests__/verifier-gate.test.ts`

**Interfaces:**
- Consumes: `splitEvidenceByGrounding`, `Groundable` (Task 1 — reuse it as the row type in `utils.ts`, do not define a second interface).
- Produces: memo prompt sees grounded rows only (+ a withheld-count line); verifier support set = grounded rows only; ungrounded rows can no longer corroborate any memo line.

- [ ] **Step 1: Write the failing tests** (append to `verifier-gate.test.ts`):

```ts
it("ignores ungrounded rows in URL support even when the claim text matches", () => {
  const line = "The market is worth $216.5B according to analysts";
  const rows = [
    { claim: "Global market valued at $216.5B in 2024", source_url: undefined, grounding_status: "unverified" },
  ];
  expect(claimHasUrlSupport(line, rows)).toBe(false);
});
it("treats NULL grounding_status with URL as legacy grounded", () => {
  const line = "The market is worth $216.5B according to analysts";
  const rows = [
    { claim: "Global market valued at $216.5B in 2024", source_url: "https://example.com/r", grounding_status: null },
  ];
  expect(claimHasUrlSupport(line, rows)).toBe(true);
});
```

- [ ] **Step 2: Run to verify they fail**

Run (workdir `apps/web`): `node node_modules/vitest/vitest.mjs run src/app/api/__tests__/verifier-gate.test.ts`
Expected: FAIL (first case returns true today).

- [ ] **Step 3: Implement**

`utils.ts` — change the row parameter type of `claimHasUrlSupport` (and any sibling verifier helper taking `{ claim?; source_url? }`) to `Groundable & { claim?: string }`, and add as the first check inside `.some()`: `if (e.grounding_status !== undefined && e.grounding_status !== null && e.grounding_status !== "grounded") return false;`. Same guard in `claimHasOwnedRowSupport`? No — owned rows (assistant critic) are a different provenance system; out of scope, do not touch.

`route.ts` — in `runDecisionMemoSkill`, replace the summary construction with:

```ts
const { grounded: groundedEvidence, ungrounded: withheldEvidence } = splitEvidenceByGrounding(allEvidence);
const evidenceSummary = groundedEvidence
  .slice(0, 10)
  .map((e) => `[${e.evidence_type}/${e.strength}] ${toUntrusted(e.claim)} (${e.source_url})`)
  .join("\n");
```

and extend the prompt header after `EVIDENCE (${...} items):` with:

```ts
`GROUNDED EVIDENCE (${groundedEvidence.length} items, all URL-backed):`
```

plus, when `withheldEvidence.length > 0`, a line: `WITHHELD: ${withheldEvidence.length} unverified item(s) excluded — never cite, restate, or rely on them; if the grounded evidence is thin, output "test_more".` Pass `groundedEvidence` (not `allEvidence`) to `runVerifier` at `:2553` and to `combineVerifierWithMemoScan` at `:1760`. Keep `evidence_ids: allEvidence.map(...)` at `:1805` unchanged (decision audit trail still references everything citable-or-not — the memo text simply cannot draw on withheld rows).

- [ ] **Step 4: Run battery**

Run (workdir `apps/web`): full `node node_modules/vitest/vitest.mjs run src/app/api/__tests__/verifier-gate.test.ts src/lib/__tests__/evidence-grounding.test.ts` + `node node_modules/typescript/bin/tsc --noEmit`.
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/api/agent/route.ts apps/web/src/lib/utils.ts apps/web/src/app/api/__tests__/verifier-gate.test.ts
git commit -m "feat(agent): memo + verifier draw on grounded evidence only"
```

**Acceptance:** a memo run with only-unverified input produces `test_more` with the WITHHELD line in trace; verifier flags memo lines that echo withheld numeric claims; battery green.

---

### Task 5: UI transparency + history columns

**Files:**
- Modify: `apps/web/src/app/[locale]/validate/page.tsx` (source-link region ~`:289`; grounded-count region ~`:1356`)
- Modify: `apps/web/src/app/api/history/route.ts:88` (select list)

**Interfaces:**
- Consumes: `grounding_status`, `quarantined_at` (Task 2 migration; NULL-safe: missing/NULL renders today's behavior).
- Produces: rows with `grounding_status='unverified'|'quarantined'` render an amber "Unverified — not evidence" badge instead of a source link; grounded rows unchanged; history API returns the two new columns.

- [ ] **Step 1: History select** — extend the select string at `history/route.ts:88` with `, grounding_status, quarantined_at`. No test change (shape-additive).
- [ ] **Step 2: Badge render** — at the evidence row render (~`:289`), wrap: if `e.grounding_status === "unverified" || e.grounding_status === "quarantined"` render `<span className="...amber...">Unverified — not evidence</span>` in place of the source-link anchor; else today's render. Check the file's existing badge/chip classes first and reuse them (no new design language).
- [ ] **Step 3: Grounded-count line** — inspect `:1356` filter (`source_type === "web_search" && !!source_url`): extend to also require `e.grounding_status !== "unverified" && e.grounding_status !== "quarantined"` (NULL passes = legacy). 
- [ ] **Step 4: Verify** — tsc clean + `npm.cmd run build` (workdir `apps/web`) succeeds; manual screenshot of a quarantined startup's evidence list attached to the commit message body or plan checklist.
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/\[locale\]/validate/page.tsx apps/web/src/app/api/history/route.ts
git commit -m "feat(ui): unverified-evidence badge + grounding-aware counts"
```

**Acceptance:** quarantined rows visibly badged, never presented as sources; build green.

---

### Task 6: Methodology alignment + observability + prod verification

**Files:**
- Modify: `packages/skills/evidence-quality-coach/playbook.md` (append 3-5 lines)
- No code files (verification queries are run, not committed; record results in the final summary message + commit body)

**Interfaces:**
- Consumes: green Tasks 1-5 on `main`.
- Produces: playbook rule + recorded prod verification evidence.

- [ ] **Step 1: Playbook rule** — append to `packages/skills/evidence-quality-coach/playbook.md`:

```md
## Grounding persistence rule
Ungrounded synthesis output is NEVER evidence: rows without a tool-returned
http(s) URL persist only as `grounding_status='unverified'`, are withheld
from the decision memo and the verifier support set, and render as
"Unverified — not evidence". A numeric market claim without a cited URL is
dropped from grounding, never softened.
```

- [ ] **Step 2: Full regression battery** — tsc clean; full Vitest run (`node node_modules/vitest/vitest.mjs run`, workdir `apps/web`); golden checks per repo convention (`meta`/`golden` — run whatever `package.json` scripts the repo used for the last green: record commands + results); `npm.cmd run build` green.
- [ ] **Step 3: Prod verification queries** (Management API, same auth as Task 2):
1. `select grounding_status, count(*) from public.evidence group by 1;` — quarantined count stable at Task-2 `n`, zero new `unverified`-without-trace rows unexplained.
2. Fresh trial run (staging account if available, else trace-only review): confirm a `persistence_gate` trace event exists with `grounded`/`unverified` counts, and a memo whose prompt contains the WITHHELD line when applicable.
3. `select verdict, confidence, count(*) from public.decisions group by 1,2;` — no `go`/`high` resting on withheld rows (manual join spot-check on the newest 3 decisions).
- [ ] **Step 4: Commit**

```bash
git add packages/skills/evidence-quality-coach/playbook.md
git commit -m "docs(methodology): grounding persistence rule"
```

**Acceptance:** battery green; prod counts recorded; no `go` on ungrounded rows; plan's Definition of Done (§Done) satisfied.

---

## Track B (improvements — gated behind Track A green, same TDD rules)

B1. **Numeric-claim detector at creation**: route the `runMarketResearchSkill` ungrounded branch through `claimHasNumericContent`; numeric + ungrounded → still persisted as `unverified` (audit) but additionally stripped from the in-session SSE `evidence` payload so the UI never flashes invented numbers mid-run. Small, high value.
B2. **Strength relabel**: secondary numeric claims are not `opinion`-ladder material — introduce display-level mapping (`secondary` + numeric + grounded → shown as `data`; ungrounded → `insufficient`) WITHOUT touching the `strength` CHECK (display mapping in the UI/select layer only).
B3. **De-dup enforcement audit**: the thin-evidence rule assumes URL de-dup (`countDistinctSources`, `normalizeSourceUrl` in `utils.ts:160-175`) — add a test proving same-URL ×3 stays `low`/`test_more` end-to-end at the `meetsGoThreshold`+`deriveConfidence` level (likely already covered by `threshold.test.ts` — verify, close gap if any).
B4. **Experiment loop closure**: `experiments.status` `draft → running → done` transitions + `evidence.assumption_id` linkage UI; turns the 19 open drafts into a measurable validation funnel. (Largest item; split into its own plan if it exceeds 3 tasks on sizing.)
B5. **Stop-rule smoke test**: a tiny-TAM fixture asserting the `stop` path fires (today `stop` is unobserved in prod — the plan's blind spot).

---

## Rollout / rollback

- Order: Task 2 migration first (expand-only, zero code dependency), then code Tasks 3-4, UI Task 5, verification Task 6. Each task commits independently; any task may ship alone.
- Rollback per layer: code revert = `git revert` (pure additive guards, no callers depend on new helpers); DB rollback = DOWN script in the migration file (resets the two columns, history rows byte-identical to pre-migration); UI revert = today's NULL-safe render (missing columns render legacy view).
- Worst case (migration applied, code reverted): quarantined rows stay labeled but visible exactly as today — no user-facing change, audit value retained.

## §Done (Definition of Done)

- [ ] Zero rows with market numbers and no source are created on new runs (creation tag + gate).
- [ ] Memo prompt + verifier support set provably exclude ungrounded rows (tests red→green on record).
- [ ] The 150 legacy rows are quarantined, badged, and excluded from grounding (prod queries recorded).
- [ ] Full battery green (tsc, Vitest, golden/meta, build) with commands + results recorded.
- [ ] Playbook rule committed; rollout/rollback section executed or explicitly deferred with reason.
