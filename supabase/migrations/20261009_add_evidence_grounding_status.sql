-- 0018 evidence grounding: expand-only, nullable grounding_status +
-- quarantined_at; existing rows read as NULL = legacy. Idempotent backfill
-- quarantines exactly the fallback-path signature (secondary evidence with
-- no source_url and no source_type). DOWN rollback commented in-file.
alter table public.evidence
  add column if not exists grounding_status text
    check (grounding_status in ('grounded', 'unverified', 'quarantined')),
  add column if not exists quarantined_at timestamptz;

-- Backfill (idempotent): quarantine exactly the fallback-path signature.
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
