-- ============================================================
-- Validation Copilot — nightly invite-expiry sweep schedule (Task 6)
-- Additive-only on top of 0004 (expire_workspace_invites helper).
-- Apply with `supabase db push` or via the Supabase SQL Editor.
-- Idempotent (job unscheduled first when present; no-op when pg_cron
-- is absent).
--
-- Cron choice (Task 6 — explicit pick, documented):
--   pg_cron (DB-level) OVER Vercel Cron, because the sweep helper
--   already lives in the DB (0004), the schedule works regardless of
--   hosting, and correctness never depends on the sweep — the invite
--   route enforces expiry on every mutation (stale pending → expired
--   → 410). When pg_cron is absent (local dev without the extension)
--   this migration is a no-op NOTICE; the operator alternative is a
--   Vercel Cron hitting a sweep endpoint (not created — out of scope).
-- Runs daily at 02:00 UTC.
-- ============================================================

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'expire-workspace-invites-nightly') then
      perform cron.unschedule('expire-workspace-invites-nightly');
    end if;
    perform cron.schedule(
      'expire-workspace-invites-nightly',
      '0 2 * * *',
      'select public.expire_workspace_invites()'
    );
  else
    raise notice 'pg_cron absent: nightly invite-expiry sweep NOT scheduled (route enforces expiry per-mutation; add Vercel Cron if needed).';
  end if;
exception
  when others then
    raise notice 'invite-expiry cron scheduling skipped: %', sqlerrm;
end $$;
