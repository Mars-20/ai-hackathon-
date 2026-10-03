# Validation Copilot — Deploy & Validation Runbook (Task 9)

Covers the Tasks 1–8 hardening stream (HEAD `70d8ac2`). No app code changes here —
`.gitignore` + `.env.example` + this doc only.

## 1. Migration order (Supabase, in order — do not skip)

Apply with `supabase db push` or the Supabase SQL Editor, in filename order:

| # | File | What |
|---|------|------|
| 0000 | `20240101000000_schema_unified.sql` | Base unified schema (workspaces multi-tenancy + leads/messages/trace). |
| 0001 | `20240101000001_admin.sql` | Admin/ops objects. |
| 0002 | `20240101000002_hardening.sql` | RLS hardening: `private.*` SECURITY DEFINER helpers (`SET search_path=''`), REVOKE/GRANT, trace policies tightened (no NULL-`startup_id` bypass), triggers qualified. |
| 0003 | `20240101000003_workspace_spend.sql` | Spend ledger: `workspace_spend` + `add_workspace_spend(p_key,p_amount)` atomic upsert + `get_workspace_spend(p_key)`. |
| 0004 | `20240101000004_workspace_invites.sql` | Invites lifecycle: `token_hash` + index, `revoked` status, `expires_at > created_at` CHECK, `expire_workspace_invites()` (service_role only), member/owner-admin RLS. |
| 0005 | `20240101000005_workspace_invites_fix.sql` | R1 fix (additive, preserves 0000–0004 history): `token` DROP NOT NULL (hash-only rows legal) + `token_hash` NOT VALID CHECK for new writes. |

**0005-before-code note:** apply `0005` BEFORE deploying the Task 8 R1 route code —
new invite rows write `token: NULL` (hash-only), which is illegal under the old
`token NOT NULL`. Deploying code first breaks POST/resend.

## 2. Backfill steps (run once, in SQL Editor with pgcrypto)

```sql
create extension if not exists pgcrypto;

-- 0005: backfill sha256(token) for legacy pending rows with NULL token_hash
UPDATE workspace_invites SET token_hash = encode(
  digest(token::text, 'sha256'), 'hex')
WHERE token_hash IS NULL AND status = 'pending'
  AND token IS NOT NULL;

-- verify zero NULLs on pending rows, then enforce:
-- SELECT count(*) FROM workspace_invites WHERE status='pending' AND token_hash IS NULL;
ALTER TABLE workspace_invites
  VALIDATE CONSTRAINT workspace_invites_token_hash_required;
```

Route lookups are BY ID (never by token/hash), so legacy NULL-hash rows still
accept via the email-match path; any resend rotation backfills `token_hash`
automatically. No code branch needed.

## 3. Trusted-proxy note (XFF)

`getClientIp()` (`apps/web/src/lib/rate-limit.ts`) reads the first
`x-forwarded-for` entry as a best-effort abuse-brake signal only — XFF is
client-spoofable unless the edge overwrites it. Behind a CDN/LB, configure
trusted proxies (or use the platform client IP, e.g. Vercel's
`x-vercel-forwarded-for` / `x-real-ip`). Authenticated `user:` buckets are
always preferred; never treat the IP key as identity.

## 4. Live gates (verify before prod — mocked in CI, not live-proven)

- [ ] **Upstash live:** set `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`,
      run a real burst (e.g. 20 parallel, limit 10 → exactly 10 allowed).
      CI covers only mocked-fetch EVAL/Lua shape + single-roundtrip atomicity.
- [ ] **Supabase RLS live-DB:** replay Task 4/6/8 SQL-text asserts against a real
      instance — `private.*` grants, trace NULL-row invisibility, search
      counts/order/pagination, invite accept/410/403 flows. Unit tests use
      PostgREST mocks, not a live DB.
- [ ] **pg_cron sweep:** schedule `expire_workspace_invites()` (e.g. hourly).
      Route enforces expiry per-mutation regardless, so this is staleness
      hygiene, not a correctness gate.
- [ ] **token_hash backfill:** run §2, then `VALIDATE CONSTRAINT`.

## 5. Env checklist (placeholders in `apps/web/.env.example` — never values)

`GEMINI_API_KEY`, `GROQ_API_KEY` (+ optional `GEMINI_PLANNER_MODEL`,
`GEMINI_VERIFIER_MODEL`, `GROQ_ROUTER_MODEL`), `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server-only,
never `NEXT_PUBLIC_`-prefixed), `UPSTASH_REDIS_REST_URL`,
`UPSTASH_REDIS_REST_TOKEN`, `NEXT_PUBLIC_APP_URL`, optional `APOLLO_API_KEY`.
`.env.local` is gitignored and untracked — verify with
`git ls-files --error-unmatch apps/web/.env.local` (must fail).

## 6. Follow-ups deferred from Tasks 4–8 (not done here)

- **T4:** legacy NULL-`startup_id` trace rows invisible to authenticated reads
  after 0002 — backfill `startup_id` if prod relies on them via user clients.
- **T5:** `usageMetadata` not yet plumbed through skills (static `COST_TABLE`
  fallback active, marked); catch-path `recordSpend` + non-OK page branch lack
  dedicated tests; pre-flight adds one `getUser` roundtrip.
- **T6:** search `pages` = `ceil(total/limit)` over summed per-type counts
  (`pages_per_type` keeps old max-basis sizing); rank window = first 200/type;
  `from`/`to` date strings unvalidated (T1 deferred).
- **T7:** gate evaluates primary evidence only; `eval/run-eval.js` mirrors the
  threshold — needs the same URL de-dup if it re-implements counting; prompt
  prose contains "3+" (reword if a strict audit forbids digits in prompts).
- **T8:** `leads`/`messages` write API explicitly deferred — agent returns
  interviewees in-response only; revisit with a consent-first (PDPL) design.
  Email delivery (Resend) out of scope; no token ever logged/returned.
  On-behalf accept = 403 by design (invitee email-match is the accept path).

## 7. Hygiene rules

- `.superpowers/` reports stay on disk only: gitignored + `git rm -r --cached`
  (Task 9). Never commit session files, `*.tsbuildinfo`, or `.env.local`.
- Secret scan before every commit:
  `git grep -n -E "sk-|AKIA|ghp_|xoxb-" -- .` must return only docs placeholders.
- `.env.example` carries placeholders (`*_here` / example URLs) — no real values.
