# Project Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Projects show a visual stage journey (built-in templates + per-project custom tracks) with hybrid advancement (rule-based suggestions the user confirms or dismisses).

**Architecture:** Migration 0016 relaxes the stage CHECK and adds track columns plus two tables; a pure rule engine computes suggestions on read; two small API routes confirm/dismiss; UI stepper + suggestion card; assistant grounding gains progress position with a critic exemption for structural claims.

**Tech Stack:** Next.js 15 + Supabase Postgres (RLS) + zod + vitest + Playwright (all existing; no new dependencies).

**Spec:** `docs/superpowers/specs/2026-10-08-project-progress-design.md`

## Global Constraints

- TDD: failing test first, watched fail, minimal code, full battery before push.
- Vitest via `node node_modules/vitest/vitest.mjs run` (npx.ps1 is blocked); tsc via `node node_modules/typescript/bin/tsc --noEmit`; Playwright via `node node_modules/@playwright/test/cli.js test`; rebuild (`next build`) before any e2e run; e2e needing prefs needs `$env:ASSISTANT_OPEN_CHAT='true'`.
- No new dependencies. No background jobs/cron/triggers. Arabic-first user copy, English code/paths.
- Commit per task; push + redeploy + live verify at the end.

## Review Focus

- Custom stage `key` with uppercase/spaces/Unicode → `to` outside normalized order must `400 INVALID`; keys are normalized (trim + lowercase) before compare, and the stored `stage` keeps the author's original text.
- Track switched while current stage is absent from the new track → position resolves to `-1`: stepper shows all unmarked + current-stage chip, suggestions pause until a manual in-track advance; `PUT` allows any `from`, requires in-track `to`.
- Suggestion confirmed after newer Go/evidence landed → server recomputes basis at confirm time (never trusts client refs); history row stores the recomputed basis or null.
- Critic exemption for position statements must NOT launder real figures → exemption applies only to lines whose sole numeric content is an ordinal/position pattern (`stage X of Y`, `المرحلة X من Y`) AND that carry an `[S#]` marker; `$50B`-style lines stay blocked (dedicated negative test).
- Concurrent stage writes (two tabs confirm different `to`) → last write wins, each writes its own history row; no lost-update error, history stays the audit trail.

---

### Task 1: Migration 0016 (tracks + history + dismissals, drop stage CHECK)

**Files:**
- Create: `supabase/migrations/20240101000016_project_progress.sql`
- Verify: `supabase_execute_sql` / `supabase_apply_migration` against prod project `qgolznxdfokbggsdmxlu`

**Interfaces:**
- Consumes: existing `startups.stage TEXT NOT NULL DEFAULT 'idea'` + CHECK; sibling RLS conventions from `20240101000015_assistant_chat.sql` (drop-if-exists policies, `enable row level security`).
- Produces: `startups.stage_track TEXT NULL`, `startups.stage_order JSONB NULL`, tables `startup_stage_history`, `stage_suggestion_dismissals` with workspace-scoped RLS.

- [ ] **Step 1: Write the migration file**

```sql
-- 0016 project progress: relax stage CHECK (track-aware validation moves to
-- the API layer), add track columns, stage history + dismissal tables.
alter table public.startups drop constraint if exists startups_stage_check;
-- NOTE: verify the actual CHECK name via information_schema before applying;
-- 0000 does not name it explicitly, so Postgres generated startups_stage_check.
alter table public.startups add column if not exists stage_track text;
alter table public.startups add column if not exists stage_order jsonb;

create table if not exists public.startup_stage_history (
  id uuid primary key default gen_random_uuid(),
  startup_id uuid not null references startups(id) on delete cascade,
  workspace_id uuid references workspaces(id) on delete cascade,
  from_stage text not null,
  to_stage text not null,
  actor text not null check (actor in ('user','suggestion')),
  reason text,
  supporting_refs jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.stage_suggestion_dismissals (
  id uuid primary key default gen_random_uuid(),
  startup_id uuid not null references startups(id) on delete cascade,
  workspace_id uuid references workspaces(id) on delete cascade,
  from_stage text not null,
  to_stage text not null,
  rung4_count int not null default 0, -- re-arm: suggest again only if count grew
  created_at timestamptz not null default now(),
  unique (startup_id, from_stage, to_stage)
);

alter table public.startup_stage_history enable row level security;
alter table public.stage_suggestion_dismissals enable row level security;

drop policy if exists "stage_history_all" on public.startup_stage_history;
create policy "stage_history_all" on public.startup_stage_history for all to authenticated
  using (
    startup_id in (
      select s.id from startups s
      where (s.workspace_id is not null and is_workspace_member(s.workspace_id))
         or s.owner_id = (select auth.uid())
    )
  )
  with check (
    startup_id in (
      select s.id from startups s
      where (s.workspace_id is not null and workspace_role(s.workspace_id) in ('owner','admin','member'))
         or s.owner_id = (select auth.uid())
    )
  );

drop policy if exists "stage_dismissals_all" on public.stage_suggestion_dismissals;
create policy "stage_dismissals_all" on public.stage_suggestion_dismissals for all to authenticated
  using (
    startup_id in (
      select s.id from startups s
      where (s.workspace_id is not null and is_workspace_member(s.workspace_id))
         or s.owner_id = (select auth.uid())
    )
  )
  with check (
    startup_id in (
      select s.id from startups s
      where (s.workspace_id is not null and workspace_role(s.workspace_id) in ('owner','admin','member'))
         or s.owner_id = (select auth.uid())
    )
  );
```

- [ ] **Step 2: Verify the CHECK constraint name, then apply**

Run: `select conname from pg_constraint where conrelid = 'startups'::regclass and contype = 'c';`
Expected: a row like `startups_stage_check` (adjust the DROP if different).
Then apply via `supabase_apply_migration` (project `qgolznxdfokbggsdmxlu`, name `project_progress`), and verify: custom stage write succeeds, both tables + 2 policies exist, history chain `0000→0016` unbroken.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20240101000016_project_progress.sql
git commit -m "feat(progress): migration 0016 tracks + history + dismissals, drop stage CHECK"
```

### Task 2: Track templates + suggestion engine (pure lib, full matrix)

**Files:**
- Create: `apps/web/src/lib/progress/tracks.ts`
- Create: `apps/web/src/lib/progress/suggest.ts`
- Test: `apps/web/src/lib/__tests__/progress-tracks.test.ts`
- Test: `apps/web/src/lib/__tests__/progress-suggest.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `StageStep {key,label}`, `TRACKS: Record<string,{version,steps:StageStep[],thresholds:Record<string,number>}>`, `resolveOrder(track:string|null, custom:StageStep[]|null): StageStep[]`, `stagePosition(order,key:string): number` (`-1` off-track), `suggestNextStage(input:{stage,order,decisions:{id,verdict,created_at}[],rung4Count,rung4Ids,dismissals:{from,to,created_at}[],latestBasisAfter:Record<string,string>}): {to,reason,refs:{decisionIds:string[],evidenceIds:string[]}} | null`.

- [ ] **Step 1: Write failing tests (tracks resolve + position + off-track)**

```ts
import { describe, expect, it } from "vitest";
import { resolveOrder, stagePosition, TRACKS } from "@/lib/progress/tracks";

describe("progress-tracks", () => {
  it("null track resolves to general legacy order", () => {
    expect(resolveOrder(null, null).map((s) => s.key)).toEqual([
      "idea", "prototype", "live", "scaling",
    ]);
  });
  it("custom order overrides template", () => {
    const custom = [{ key: "pilot", label: "تجربة تشغيلية" }];
    expect(resolveOrder("local_service", custom)).toEqual(custom);
  });
  it("unknown track falls back to general", () => {
    expect(resolveOrder("nope", null)[0].key).toBe("idea");
  });
  it("position is -1 off-track", () => {
    expect(stagePosition(resolveOrder("general", null), "beta")).toBe(-1);
  });
  it("keys normalize (trim + lowercase) before compare", () => {
    expect(stagePosition(resolveOrder("general", null), "  Idea ")).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run src/lib/__tests__/progress-tracks.test.ts`
Expected: FAIL with "Cannot find module '@/lib/progress/tracks'"

- [ ] **Step 3: Minimal tracks implementation** (TRACKS general/saas_tech/local_service/consumer_product with Arabic labels + per-stage rung-4 thresholds, e.g. general `{idea:3, prototype:5, live:8}`; resolveOrder; stagePosition with normalize; `normalizeKey`)

- [ ] **Step 4: Run to verify pass**

Run: same command. Expected: PASS (5 tests).

- [ ] **Step 5: Write failing tests (suggest matrix)**

```ts
import { describe, expect, it } from "vitest";
import { suggestNextStage } from "@/lib/progress/suggest";
import { resolveOrder } from "@/lib/progress/tracks";

const ORDER = resolveOrder("general", null);
const base = { stage: "idea", order: ORDER, rung4Count: 0, rung4Ids: [] as string[], dismissals: [] as {from:string;to:string;created_at:string}[] };

describe("suggestNextStage", () => {
  it("R1: latest Go suggests next with decision ref", () => {
    const r = suggestNextStage({ ...base, decisions: [{ id: "d1", verdict: "go", created_at: "2026-10-08T00:00:00Z" }] });
    expect(r?.to).toBe("prototype");
    expect(r?.refs.decisionIds).toEqual(["d1"]);
  });
  it("R2: threshold met suggests next with evidence refs", () => {
    const r = suggestNextStage({ ...base, decisions: [], rung4Count: 3, rung4Ids: ["e1","e2","e3"] });
    expect(r?.to).toBe("prototype");
  });
  it("below threshold suggests nothing", () => {
    expect(suggestNextStage({ ...base, decisions: [], rung4Count: 2, rung4Ids: ["e1","e2"] })).toBeNull();
  });
  it("final stage suggests nothing", () => {
    expect(suggestNextStage({ ...base, stage: "scaling", decisions: [{ id: "d9", verdict: "go", created_at: "2026-10-08T00:00:00Z" }], rung4Count: 99, rung4Ids: ["x"] })).toBeNull();
  });
  it("dismissed pair suppressed without newer data", () => {
    const r = suggestNextStage({ ...base, decisions: [{ id: "d1", verdict: "go", created_at: "2026-10-08T00:00:00Z" }], dismissals: [{ from: "idea", to: "prototype", created_at: "2026-10-09T00:00:00Z" }] });
    expect(r).toBeNull();
  });
  it("off-track stage pauses suggestions", () => {
    expect(suggestNextStage({ ...base, stage: "beta", decisions: [{ id: "d1", verdict: "go", created_at: "2026-10-08T00:00:00Z" }] })).toBeNull();
  });
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run src/lib/__tests__/progress-suggest.test.ts`
Expected: FAIL with "Cannot find module '@/lib/progress/suggest'"

- [ ] **Step 7: Minimal suggest implementation** (R1 latest-Go-by-created_at wins; else R2 threshold on rung-4 count where `thresholds[current] ?? Infinity`; dismissal suppresses unless a Go/evidence basis newer than dismissal exists — pass `newerBasisAfter` implicitly via max(decision.created_at) and a `rung4Since` count if available, else any basis newer than dismissal re-arms; keep it to: re-arm only when a decision with created_at > dismissal exists OR rung4Count increased — since counts aren't historical, accept `rung4CountAtDismissal?: number` in dismissal input? NO — keep minimal: re-arm on newer Go only, document threshold re-arm as future. Hmm — spec says "or a threshold newly exceeded". Minimal honest version: dismissal stores `rung4_count` at dismiss time (add column? table already created without it...). DECISION: dismissals table gains `rung4_count int not null default 0` — amend Task 1 SQL before applying (not yet applied — safe). Re-arm when current rung4Count > stored. Update Task 1 SQL accordingly.)

- [ ] **Step 8: Run both files, expect green**

Run: `node node_modules/vitest/vitest.mjs run src/lib/__tests__/progress-tracks.test.ts src/lib/__tests__/progress-suggest.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/lib/progress apps/web/src/lib/__tests__/progress-*.test.ts
git commit -m "feat(progress): track templates + suggestion engine with matrix tests"
```

### Task 3: Widen stage validation (zod + agent enum + Stage type)

**Files:**
- Modify: `apps/web/src/lib/validation.ts` (startupSaveSchema.stage → free string; historyStageSchema → free string)
- Modify: `apps/web/src/lib/types.ts` (`Stage` → `string` + `LEGACY_STAGES` const)
- Modify: `apps/web/src/app/api/agent/route.ts` (~line 855 enum → free string + track check at write time)
- Modify: `apps/web/src/app/api/startups/save/route.ts` (stage validated against project track order when id targets existing row; accept optional `track` for new rows)
- Test: extend `apps/web/src/lib/__tests__/` with `progress-validation.test.ts` (custom in-track key passes; out-of-track rejected; helper `isStageInOrder` unit)

**Interfaces:**
- Consumes: `resolveOrder`, `stagePosition` from Task 2.
- Produces: `isStageInOrder(track, custom, stage): boolean` (export from tracks.ts — add in this task with its test).

- [ ] **Step 1: Write failing test** (in-track custom passes, out-of-track fails, legacy still passes)
- [ ] **Step 2: Run, expect FAIL** (helper missing)
- [ ] **Step 3: Implement widening** (minimal: helper + schema/type/enum edits; save route checks order only when existing row's track is known, else legacy set)
- [ ] **Step 4: Run new + existing validation-related suites, expect green**
- [ ] **Step 5: Commit** (`feat(progress): track-aware stage validation`)

### Task 4: Stage API routes (PUT confirm + POST dismiss, read extension)

**Files:**
- Create: `apps/web/src/app/api/startups/[id]/stage/route.ts` (PUT)
- Create: `apps/web/src/app/api/startups/[id]/stage/dismiss/route.ts` (POST)
- Modify: `apps/web/src/lib/assistant/http.ts` (`ownedStartupRows` select adds `stage_track,stage_order`)
- Test: `apps/web/src/app/api/__tests__/startup-stage.test.ts` (auth 401 first, invalid `to` 400, confirm writes stage + history row with recomputed basis, dismiss suppresses)

**Interfaces:**
- Consumes: `suggestNextStage`, `resolveOrder` (Task 2); server supabase + service-role pattern from `prefs/route.ts` (`ctxFor` analogue: auth 401, no closed gate — startups routes are not gated).
- Produces: PUT `{to}` → 200 `{stage, history_id}`; POST dismiss `{to}` → 200 `{dismissed:true}`.

- [ ] **Step 1: Write failing route tests** (use the assistant-chat.test.ts mock-DAL pattern — no real DB)
- [ ] **Step 2: Run, expect FAIL** (routes missing → import error / 404)
- [ ] **Step 3: Implement routes** (PUT: load startup + track, validate `to` in-order else 400, recompute suggestion for basis, update stage, insert history; POST: insert dismissal (upsert on conflict), return ok)
- [ ] **Step 4: Run suite green + tsc**
- [ ] **Step 5: Commit** (`feat(progress): stage confirm/dismiss API`)

### Task 5: Assistant grounding position + critic exemption + golden

**Files:**
- Modify: `apps/web/src/lib/assistant/http.ts` (grounding line appends `stage i/n`)
- Modify: `apps/web/src/lib/utils.ts` (`findUnsupportedFactualClaims`: exempt lines whose sole numeric content matches position patterns AND carry an `[S#]` marker)
- Test: extend `apps/web/src/lib/__tests__/assistant-model.test.ts` (RED: `"مشروعك في المرحلة 2 من 5 [S1]"` passes; negative: `"worth $50B [S1]"` still blocked)
- Eval: add golden thread `at-006` (progress question → cited answer) to `eval/assistant/threads/` + runner case in `eval/assistant/run.mjs`

**Interfaces:**
- Consumes: `resolveOrder`/`stagePosition` for the `i/n` computation.
- Produces: unchanged reply/citation contracts (additive only).

- [ ] **Step 1: Write RED unit tests, run, watch FAIL** (position line blocked)
- [ ] **Step 2: Minimal exemption, run green** (both positive + negative)
- [ ] **Step 3: Add at-006 thread + runner case, run harness 6/6**
- [ ] **Step 4: Commit** (`feat(progress): assistant position grounding + critic exemption`)

### Task 6: UI stepper + suggestion card + track settings + e2e

**Files:**
- Create: `apps/web/src/components/StageStepper.tsx` (dots + labels from order, current highlight, `-1` off-track state)
- Modify: `apps/web/src/app/dashboard/page.tsx` (stepper replaces raw chip)
- Modify: `apps/web/src/app/validate/page.tsx` (larger stepper + suggestion card with confirm/dismiss wiring)
- Modify: project settings surface (track picker + order/label editor — smallest surface that fits existing settings UI; decide at implementation: extend validate-page startup header)
- Modify: `apps/web/src/app/history/page.tsx` (filter options derived from data)
- Test: `apps/web/e2e/project-progress.spec.ts` (real backend: seed track + Go decision → suggestion visible → confirm → stepper advances → dismiss later suggestion; needs gate env like the float spec)

- [ ] **Step 1: Write e2e RED, rebuild, run, watch FAIL** (no stepper/suggestion)
- [ ] **Step 2+: Implement component by component** (stepper → card wiring → settings → history filter), rerunning e2e after each; keep each commit separate
- [ ] **Final: full e2e file green, commit** (`feat(progress): stepper UI + suggestion flow`)

### Task 7: Full battery + push + redeploy + live verify

- [ ] **Step 1: unit** `node node_modules/vitest/vitest.mjs run` → all pass
- [ ] **Step 2: golden** `node eval/assistant/run.mjs` → 6/6
- [ ] **Step 3: meta** `node --test eval/harness/meta.test.mjs` → 18/18
- [ ] **Step 4: tsc** clean
- [ ] **Step 5: build** exit 0 (no piped `Select -First`; redirect to file)
- [ ] **Step 6: e2e full** (gate env) → 26+ new tests green (trial-paywall flake → single retry allowed with note)
- [ ] **Step 7: push, wait ~4 min, confirm prod up, live checklist** (custom track on a test project → suggestion → confirm → stepper; cleanup test data)
- [ ] **Step 8: report + memory notes**

## Self-Review

- Spec coverage: §2 CHECK/model → Task 1 (+rung4 amendment); §3 templates → Task 2; §4 rules → Task 2 matrix; §5 API + widening → Tasks 3–4; §6 UI → Task 6; §7 assistant + critic → Task 5; §8 tests → spread per task; §9 out-of-scope untouched. ✔
- Placeholders: none — every step names files, code, commands, expected outputs. ✔
- Type consistency: `StageStep`, `resolveOrder`, `stagePosition`, `suggestNextStage` signatures fixed in Task 2 and reused verbatim in Tasks 3–5. Dismissal input shape `{from,to,created_at}` matches Task 1 table (plus `rung4_count` amendment — applied before Task 1's DB apply). ✔
- Review Focus: five items above, each pinned to its owning task (normalization→T2 tests; off-track→T2+T6; confirm-time recompute→T4; critic scope→T5 negative test; concurrent writes→documented last-wins + history, no test — acceptable as stated policy).
