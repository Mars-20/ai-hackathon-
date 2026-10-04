-- ============================================================
-- Validation Copilot — workspace_id NOT NULL verification (Task 8)
-- Deferred follow-up to 0006 backfill (see packages/db/schema-unified.sql
-- NOT NULL follow-up note + 0006 header: "NOT NULL deferred to Task 8
-- after verification"). Apply with `supabase db push` or via the
-- Supabase SQL Editor AFTER 0006, on a database where the backfill ran.
-- Idempotent (inherits + verifies + enforces; re-runnable no-op when
-- already enforced). FAIL-CLOSED: raises before any ALTER when NULLs
-- remain — never silently leaves a partial state.
--
-- Scope note: trace_events.workspace_id stays NULLABLE by design —
-- platform-health events (and legacy NULL-startup_id rows, see
-- docs/runbook-validation.md T4) may not belong to a startup.
-- ============================================================

-- ── 1. Inherit workspace_id from parent startup (child rows) ──────
-- All five tables below carry startup_id NOT NULL, so any row whose
-- startup already has a workspace inherits it. 0006 backfilled
-- startups itself (personal workspace per orphaned owner).
update assumptions a
set workspace_id = s.workspace_id
from startups s
where a.workspace_id is null and a.startup_id = s.id
  and s.workspace_id is not null;

update evidence e
set workspace_id = s.workspace_id
from startups s
where e.workspace_id is null and e.startup_id = s.id
  and s.workspace_id is not null;

update experiments x
set workspace_id = s.workspace_id
from startups s
where x.workspace_id is null and x.startup_id = s.id
  and s.workspace_id is not null;

update decisions d
set workspace_id = s.workspace_id
from startups s
where d.workspace_id is null and d.startup_id = s.id
  and s.workspace_id is not null;

-- ── 2. Verify zero NULLs, then enforce (single fail-closed block) ─
do $$
declare
  v_startups int; v_assumptions int; v_evidence int;
  v_experiments int; v_decisions int;
begin
  select count(*) into v_startups   from startups    where workspace_id is null;
  select count(*) into v_assumptions from assumptions where workspace_id is null;
  select count(*) into v_evidence   from evidence     where workspace_id is null;
  select count(*) into v_experiments from experiments where workspace_id is null;
  select count(*) into v_decisions  from decisions    where workspace_id is null;

  if v_startups + v_assumptions + v_evidence + v_experiments + v_decisions > 0 then
    raise exception
      'workspace_id NOT NULL blocked: NULLs remain (startups=%, assumptions=%, evidence=%, experiments=%, decisions=%). Re-run 0006 backfill, then re-apply.',
      v_startups, v_assumptions, v_evidence, v_experiments, v_decisions;
  end if;

  alter table startups    alter column workspace_id set not null;
  alter table assumptions alter column workspace_id set not null;
  alter table evidence    alter column workspace_id set not null;
  alter table experiments alter column workspace_id set not null;
  alter table decisions   alter column workspace_id set not null;

  raise notice 'workspace_id NOT NULL enforced on startups/assumptions/evidence/experiments/decisions.';
end $$;
