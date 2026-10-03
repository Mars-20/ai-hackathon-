-- ============================================================
-- Validation Copilot — workspace invites hardening (Task 8, M5)
-- Additive-only on top of 0000 + 0002. Does NOT touch
-- 0000/0001/0002/0003 (0003 = Task 5 spend ledger).
-- Apply with `supabase db push` or via the Supabase SQL Editor.
-- Idempotent (IF NOT EXISTS / OR REPLACE / drop-if-exists).
--
-- What this hardens:
--  * token_hash text column + index: invite tokens are
--    credential-equivalent. New app rows store sha256(token);
--    the legacy token column is kept for back-compat reads only.
--    Backfill guidance (NOT enforced here — legacy rows keep
--    token_hash NULL until rotated by resend):
--      UPDATE workspace_invites SET token_hash = encode(
--        digest(token::text, 'sha256'), 'hex')
--      WHERE token_hash IS NULL AND status = 'pending';
--    (requires pgcrypto; verify zero NULLs on pending rows, then
--    consider SET NOT NULL in a follow-up migration.)
--  * status gains 'revoked' (accept/decline/list/resend/revoke
--    lifecycle in apps/web/src/app/api/workspace/invite/route.ts).
--  * RLS: select = workspace member (any role, incl. viewer);
--    insert/update = owner/admin only; delete = owner only.
--    Uses private.* helpers from 0002 (fixed search_path).
--  * Expiry: CHECK (expires_at > created_at) + expire helper.
--    A pg_cron sweep is ops follow-up (Task 9 runbook); the route
--    enforces expiry on every mutation (stale pending → expired
--    → 410), so correctness never depends on the sweep.
--
-- Leads decision (Task 8 — explicit deferral, no build break):
--  leads + messages tables already exist in 0000 with RLS (member
--  read via parent startup, member write). No new table is needed
--  for M3. A dedicated leads API (consent capture / unsubscribe)
--  is DEFERRED: the agent lead-finder path returns interviewees
--  in-response only and persists nothing, so shipping a half-wired
--  leads write path now would widen the consent/PDPL surface
--  without a consumer. Revisit with a consent-first design.
-- ============================================================

-- ── 1. token_hash column ───────────────────────────────────
alter table workspace_invites
  add column if not exists token_hash text;

create index if not exists idx_invites_token_hash
  on workspace_invites(token_hash);

comment on column workspace_invites.token_hash is
  'sha256 hex of the invite token (credential-equivalent; never returned by the API). Legacy rows NULL until rotated via resend.';

-- ── 2. status: add revoked ────────────────────────────────
-- Inline CHECK from 0000 is auto-named workspace_invites_status_check.
alter table workspace_invites
  drop constraint if exists workspace_invites_status_check;
alter table workspace_invites
  add constraint workspace_invites_status_check
  check (status in ('pending','accepted','declined','expired','revoked'));

-- ── 3. expiry sanity ──────────────────────────────────────
alter table workspace_invites
  drop constraint if exists workspace_invites_expiry_check;
alter table workspace_invites
  add constraint workspace_invites_expiry_check
  check (expires_at > created_at);

-- Sweep helper for the ops cron (SECURITY DEFINER, fixed search_path).
-- Marks stale pending invites expired; returns the marked count.
create or replace function public.expire_workspace_invites()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.workspace_invites
     set status = 'expired'
   where status = 'pending' and expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end; $$;

revoke all on function public.expire_workspace_invites() from public;
revoke execute on function public.expire_workspace_invites() from anon, authenticated;
grant execute on function public.expire_workspace_invites() to service_role;

-- ── 4. RLS: member/admin only ─────────────────────────────
alter table workspace_invites enable row level security;

drop policy if exists "invites_select" on workspace_invites;
create policy "invites_select" on workspace_invites for select to authenticated
  using (private.is_workspace_member(workspace_id));

drop policy if exists "invites_insert" on workspace_invites;
create policy "invites_insert" on workspace_invites for insert to authenticated
  with check (private.workspace_role(workspace_id) in ('owner','admin'));

drop policy if exists "invites_update" on workspace_invites;
create policy "invites_update" on workspace_invites for update to authenticated
  using (private.workspace_role(workspace_id) in ('owner','admin'))
  with check (private.workspace_role(workspace_id) in ('owner','admin'));

drop policy if exists "invites_delete" on workspace_invites;
create policy "invites_delete" on workspace_invites for delete to authenticated
  using (private.workspace_role(workspace_id) = 'owner');
