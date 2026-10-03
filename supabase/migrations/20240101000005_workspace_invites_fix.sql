-- ============================================================
-- Validation Copilot — workspace invites R1 hardening (Task 8 R1, M5)
-- Additive-only on top of 0004. Does NOT touch 0000/0001/0002/0003
-- and does NOT rewrite 0004 (applied history preserved).
-- Apply with `supabase db push` or via the Supabase SQL Editor.
-- Idempotent (drop-if-exists / conditional DDL).
--
-- What this fixes (review R1/5):
--  (1) Invitee RLS deadlock: 0004 RLS select/update are member-only,
--      so a non-member invitee cannot read or accept their own invite
--      through the anon/authenticated PostgREST path. Fix is applied
--      in the route (apps/web/src/app/api/workspace/invite/route.ts
--      PATCH now reads/mutates the invite row via the service_role
--      client with explicit email + expiry + pending checks), NOT by
--      widening RLS. No policy change here by design.
--  (2) Hash-only tokens: 0004 wrote the raw token into the legacy
--      `token` column alongside `token_hash`, defeating the hash.
--      New route writes NEVER store raw material: `token` is nulled
--      and only `token_hash` (sha256 hex) is persisted. This migration
--      makes `token` NULLABLE so hash-only rows are legal; legacy raw
--      values stay until rotated/expired (see backfill below).
--  (5) token_hash NULL backfill path: legacy (pre-0004) rows have
--      token_hash NULL. A plain SET NOT NULL would fail on those rows,
--      so this migration adds a NOT VALID CHECK (enforced for every
--      NEW/UPDATED row, legacy rows unchecked until touched) plus the
--      backfill statement to run once pgcrypto is available, after
--      which VALIDATE CONSTRAINT can be run:
--        UPDATE workspace_invites SET token_hash = encode(
--          digest(token::text, 'sha256'), 'hex')
--        WHERE token_hash IS NULL AND status = 'pending'
--          AND token IS NOT NULL;
--        -- verify zero NULLs on pending rows, then:
--        ALTER TABLE workspace_invites
--          VALIDATE CONSTRAINT workspace_invites_token_hash_required;
--      (requires pgcrypto: create extension if not exists pgcrypto;)
--      Lookup fallback (no code branch needed): the route looks invites
--      up BY ID (never by token/hash), so legacy NULL-hash rows accept
--      via the same email-match path; any resend rotation backfills
--      token_hash (hash-only) automatically.
-- ============================================================

-- ── 1. token nullable (hash-only new rows; legacy raws untouched) ──
do $$
begin
  alter table workspace_invites alter column token drop not null;
exception when others then null;
end $$;

comment on column workspace_invites.token is
  'LEGACY raw invite token (pre-R1 back-compat reads only). New rows MUST be NULL (hash-only: credential lives in token_hash). Never returned by the API.';

-- ── 2. token_hash required for new writes (legacy rows grandfathered) ──
-- NOT VALID: existing rows are not checked, but every INSERT/UPDATE
-- from now on must carry a token_hash. Run the backfill above, verify
-- zero NULLs on pending rows, then VALIDATE CONSTRAINT.
do $$
begin
  alter table workspace_invites
    add constraint workspace_invites_token_hash_required
    check (token_hash is not null) not valid;
exception when duplicate_object then null;
end $$;

comment on column workspace_invites.token_hash is
  'sha256 hex of the invite token (credential-equivalent; never returned by the API). NOT NULL for all rows written after 0005 (NOT VALID check); legacy rows NULL until rotated via resend or backfilled.';
