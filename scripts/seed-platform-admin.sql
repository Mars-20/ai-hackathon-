-- ============================================================
-- Validation Copilot — platform-admin bootstrap seed (Task 8, spec §2 C1).
--
-- Purpose: insert the FIRST platform_admins row (the C1 bootstrap).
-- The Task 1 migration seeds NOTHING into platform_admins by design;
-- before this row exists, every grant path returns 403 (enforced in the
-- admin_action RPC: non-platform callers are rejected with a denied
-- trail), so this one-time operator step unlocks platform administration.
--
-- Runbook (BOOTSTRAP_EMAIL flow, spec §10 decision 1 — operator provides
-- the email at deploy):
--   1. Create the user in Supabase Auth first (sign up / invite), so a row
--      exists in auth.users. This script never creates Auth users.
--   2. Replace the <BOOTSTRAP_EMAIL> placeholder below with the operator
--      BOOTSTRAP_EMAIL and run this file in the Supabase SQL Editor
--      (or: psql -f scripts/seed-platform-admin.sql after substituting).
--   3. Verify: the trailing SELECT must return exactly 1 row.
--
-- Case-insensitivity (review-focus pin): the lookup uses
-- lower(email) = lower(<BOOTSTRAP_EMAIL>), so Admin@X.com seeds the same
-- user as admin@x.com.
--
-- Idempotency: safe to re-run. The INSERT targets the user_id PK with
-- ON CONFLICT (user_id) DO NOTHING, so an already-seeded admin is a
-- no-op (granted_by/granted_at of the existing row are preserved).
-- ============================================================

-- ── Step 1: bootstrap insert (self-grant: granted_by = the user) ──
INSERT INTO public.platform_admins (user_id, granted_by, granted_at)
SELECT u.id, u.id, now()
FROM auth.users AS u
WHERE lower(u.email) = lower('<BOOTSTRAP_EMAIL>')
ON CONFLICT (user_id) DO NOTHING;

-- ── Step 2: verify (must return exactly 1 row) ──
-- Zero rows means no auth.users row matches that email
-- (case-insensitively): create the Auth user first, then re-run.
SELECT pa.user_id, u.email AS email, pa.granted_at AS granted_at
FROM public.platform_admins AS pa
JOIN auth.users AS u ON u.id = pa.user_id
WHERE lower(u.email) = lower('<BOOTSTRAP_EMAIL>');
