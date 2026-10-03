# Task 4 — Validation Copilot Remaining Wiring Fixes — Report

Date: 2026-09-27
Scope: 4 small wiring fixes, no new frameworks, no subagents, no reviewer dispatch.
No commit (no git repo per instructions) — files edited in place.

## Files changed (6)

1. `apps/web/src/app/api/agent/route.ts`
   - `callAIWithFallback`: added optional `enableGrounding?: boolean` param. When true,
     attempts Gemini with `tools: [{ google_search: {} }]` first (snake_case per spec §6.1),
     then `[{ googleSearch: {} }]` (current `@google/generative-ai` SDK shape), each wrapped
     in try/catch with fallback to the existing non-grounded call. Default off so intake /
     assumption / experiment / verifier behaviour is unchanged.
   - Added `isHttpUrl()` guard.
   - `groundedSearch`: now returns `{ results, grounded, provider }`. Tries snake_case
     `google_search` then camelCase `googleSearch` (try/catch each). Gemini results are
     validated to http(s) URLs only (`grounded: true`). Groq fallback prompt rewritten to
     forbid invented URLs and its outputs are stripped to `url: ""` (`grounded: false`,
     `provider: "groq"`) — Groq has no browsing, so any URL it returns was not returned
     by a tool and is never emitted.
   - `runMarketResearchSkill`: `evidence_type: "secondary"` always; `source_type:
     "web_search"` + `source_url` ONLY when `grounded && isHttpUrl(url)`. Otherwise emits
     secondary/opinion evidence with no `source_type`/`source_url` and pushes a trace
     `verification` event with `warning: "ungrounded"` (plus one per-query ungrounded
     notice when `grounded === false`). Strength stays `opinion` (secondary max).
   - Input caps (`MAX_IDEA_CHARS`/`MAX_DATA_CHARS`, rate limit) and `GO_THRESHOLD`
     (in `lib/utils.ts`, untouched) unchanged.

2. `packages/tools/campaign.ts`
   - `executeCampaignAction(action, payload, supabase?)`: new optional LAST param
     `supabase?: SupabaseLike` (`{ from(table: string): any }`), backward compatible.
   - `create_lead` + `log_consent`: strict PDPL gate when persisting — `consent_given`
     must be `true` with `consent_timestamp` + `consent_text`, else `throw` (pure
     in-memory path without client unchanged, returns pending/logged objects).
   - `queue_message`: keeps L3 consent + opt-out copy gates; with client, enforces
     `idempotency_key` unique guard (pre-select + duplicate-race fallback returns
     existing row with `deduped: true` instead of double-queue). Persists to
     `leads`/`messages` (RLS enforced server-side via `(select auth.uid())` policies).
   - No demo-user strings. No new dependencies.

3. `packages/tools/save_artifact.ts`
   - `saveArtifact(payload, supabase?)`: new optional LAST param, backward compatible.
   - Removed fake `/validate?startup=demo&artifact=` URL (also removes the `demo`
     fallback string). Always returns real UUID path `artifact://{id}`.
   - With client: inserts snapshot into `trace_events` (`actor: "tool"`,
     `event_type: "tool_result"`, `startup_id` nullable) and returns the same
     `artifact://{id}` shape; throws on DB error so callers see persistence failures.

4. `apps/web/src/app/api/history/route.ts`
   - Verdict/confidence filters pushed into the DB via `decisions!inner(...)` +
     `.in("decisions.verdict", …)` / `.in("decisions.confidence", …)`; workspace
     isolation stays in-query (`.in("workspace_id", workspaceIds)`). Pagination
     (`range`) now applies after all DB filters.
   - Removed post-fetch JS verdict/confidence filtering (was applied AFTER `range`,
     breaking total/pages). Shaping kept, filtering removed.
   - `total` now always `count || 0` from Supabase (`count: "exact"`), `pages =
     ceil(total/limit)`.
   - Added `?startup_id=` detail branch (workspace-scoped `maybeSingle` with
     decisions/experiments/assumptions/evidence) to support `/validate?startup_id=`
     resume.

5. `apps/web/src/app/api/search/route.ts`
   - Kept: min-2-chars 400 gate, per-type `Math.min(20, …)` cap (limit 20), ilike
     queries as fallback (unchanged predicates).
   - Added pg_trgm similarity ordering: documents server preference
     (`ORDER BY similarity(...) DESC`, extension + `idx_startups_name_trgm` /
     `idx_evidence_claim_trgm` already in `schema-unified.sql`) and re-ranks each
     result set in code with a bigram-Dice score mirroring `similarity()` (PostgREST
     has no function-ordering primitive on these routes; ilike remains the DB query).
   - Workspace filter for child tables pushed via `startups!inner(name, workspace_id)`
     + `.in("startups.workspace_id", workspaceIds)` (no post-fetch workspace filtering).
     Startups base table keeps direct in-query `.in("workspace_id", …)`.

6. `apps/web/src/app/validate/page.tsx`
   - Imports browser client (`@/lib/supabase/client`, `NEXT_PUBLIC_` keys only).
   - `runAgent` now resolves `user_id` via `supabase.auth.getSession()` (never hardcoded)
     and `workspace_id` via `localStorage active_workspace_id` else first
     `workspace_members` row; both sent in `/api/agent` body.
   - After `done`: `persistStartupSnapshot` tries `POST /api/startups/save`, falls back
     to `localStorage["startup:{id}"]` on non-OK/404/network failure.
   - On mount: if `?startup_id=` present, loads via `/api/history?startup_id=` detail,
     hydrates startup/assumptions/evidence/experiment/decision; falls back to the
     matching `localStorage` snapshot.

## Test evidence

- `node eval/run-eval.js` (from `D:\Downloads\Ai_OS`): **8 PASSED / 0 FAILED (100%)** —
  unchanged from baseline before edits. Verifier, leading-question, and Go-threshold
  gates all active. `GO_THRESHOLD` and eval files untouched.
- `tsc --noEmit --skipLibCheck` (apps/web): zero errors in any changed file
  (`api/agent`, `api/history`, `api/search`, `validate/page`); only pre-existing errors
  remain in untouched files (`history/page.tsx` JSX namespace, `supabase/server.ts` +
  `middleware.ts` implicit-any cookie params).
- Manual greps: no `demo-user`/`demo_user` strings in changed files; `demo` fallback
  removed from `save_artifact.ts`; input caps and `GO_THRESHOLD` unchanged.

## Concerns

1. `callAIWithFallback(enableGrounding)` is opt-in and currently no caller passes `true`
   (market research grounds via `groundedSearch`, not via this helper). The required
   `tools: [{ google_search: {} }]` attempt exists with try/catch fallback, but it only
   executes when a future caller opts in. If the intent was always-on grounding for all
   skills, that would change intake/assumption/verifier behaviour and cost — left off
   deliberately; one-line change to default it on if desired.
2. `POST /api/startups/save` does not exist in this repo (verified: no
   `app/api/startups/*` route), so validate-page persistence currently exercises the
   `localStorage` fallback path in practice. Server persistence path is coded but
   untested end-to-end until that route is added.
3. `/api/history?startup_id=` detail branch is new and shaped from the unified schema
   (`decisions`/`experiments`/`assumptions`/`evidence`); not covered by golden tasks.
   Resume against workspaces where child rows lack `workspace_id` relies on the parent
   `startups.workspace_id` scoping in RLS — correct per `schema-unified.sql`, but no
   live-Supabase integration test was run here.
4. Search similarity is a client-side bigram-Dice re-rank over the ilike-limited set,
   not a true server-side `ORDER BY similarity()`. Full pg_trgm server ordering needs a
   dedicated `rpc` (e.g. `search_startups_trgm`) — intentionally not added to keep this
   change small and keep ilike as the guaranteed fallback.
5. `SupabaseLike` uses `{ from(table: string): any }` to keep `packages/tools`
   dependency-free under `strict` (explicit `any` return, no implicit-any). A typed
   generated client can replace it later without changing call sites (param is last).

---

# Fix Follow-up — 3 Important Findings (2026-09-27)

Scope: 3 verbatim fixes, minimal edits. No subagents. No `GO_THRESHOLD` change
(verified untouched in `apps/web/src/lib/utils.ts`). No `demo-user` strings
introduced (verified via grep: none in any changed file). No commits (no git repo).

## Fix 1 — `packages/tools/campaign.ts`: consent gates return, not throw

- Renamed `assertConsentForPersist` → `validateConsentForPersist`, same signature
  shape: returns `{ ok: true, consent_timestamp, consent_text }` on success or
  `{ ok: false, error }` on failure instead of throwing. Error message preserved
  verbatim: `"Consent required: consent_given must be true with
  consent_timestamp and consent_text (Section 11 PDPL audit)."`.
- `create_lead` DB path: validates via `validateConsentForPersist(payload)` and
  returns `{ success: false, action, error }` on failure (same message).
- `log_consent` DB path: consent check now returns `{ success: false, action,
  error: "Consent required: consent_status must be true with consent_text and
  timestamp to log consent." }` (same message) instead of throwing.
- `queue_message` consent/opt-out gates already returned (unchanged).
- Remaining `throw`: none in `campaign.ts` — all DB errors already returned
  `{success:false, error}`; unexpected-exception throws preserved where they exist
  (`save_artifact.ts` persist throw untouched). Callers: grep shows
  `executeCampaignAction` has no external callers in-repo (only its own
  definition + report mention), so no caller updates required.

## Fix 2 — New `POST /api/startups/save` route

- Created `apps/web/src/app/api/startups/save/route.ts`: POST handler using
  `createServerSupabaseClient`, `auth.getUser()` (401 when unauthenticated),
  `upsert` into `startups` (`id` optional UUID — generated via
  `crypto.randomUUID()` when absent/invalid; `workspace_id` nullable — only a
  valid UUID is stored, else `null`; `owner_id=user.id`; `name` required/400,
  `one_liner`, `domain` default `"general"`, `target_customer`/`business_model`
  nullable, `stage` default `"idea"`), returns `{ startup }` (500 on DB error).
- `apps/web/src/app/validate/page.tsx` untouched — `persistStartupSnapshot`
  still POSTs to `/api/startups/save` with the `localStorage["startup:{id}"]`
  fallback intact on non-OK/network failure (verified: localStorage lines 485,
  523, 553 present).

## Fix 3 — `apps/web/src/app/api/agent/route.ts`: grounding opt-in now executes

- `groundedSearch(query, domainHint?, trace?)`: new optional LAST param `trace?`
  (backward compatible). First Gemini attempt now goes through
  `callAIWithFallback({ ..., skillName: "market-research", enableGrounding: true
  })` so the `tools: [{ google_search: {} }]` attempt executes; result text is
  parsed and validated to http(s) URLs only (`grounded: true`,
  `provider: "gemini"` when non-empty).
- Try/catch fallback preserved: helper failure falls through to the existing
  direct `google_search` → `googleSearch` tool-variant attempts (unchanged), then
  Groq synthesis fallback (unchanged — still strips all URLs to `""`,
  `grounded: false`, `provider: "groq"`).
- `runMarketResearchSkill` now calls `groundedSearch(query, startup.domain,
  trace)` (trace pass-through; failover notices recorded). All other
  `callAIWithFallback` callers (intake/assumption/experiment/verifier/memo) still
  omit `enableGrounding` (default off — behaviour/cost unchanged).

## Test evidence

- `node eval/run-eval.js` (from `D:\Downloads\Ai_OS`): **8 PASSED / 0 FAILED
  (100%)** — Anti-Hallucination Gate 100% Active, Leading-Question Screening 100%
  Active, Evidence-Ladder Enforcement 100% Active.
- `.\node_modules\.bin\tsc.cmd --noEmit --skipLibCheck` (apps/web): zero errors
  in any changed file (`api/agent`, `api/startups/save`, `validate/page`
  untouched); only pre-existing errors remain in untouched files
  (`history/page.tsx` JSX namespace, `supabase/server.ts` + `middleware.ts`
  implicit-any cookie params) — same baseline as prior report.
- Greps: no `demo-user`/`demo_user` in changed files; `GO_THRESHOLD` untouched in
  `lib/utils.ts`; `throw new Error` absent from `campaign.ts` (only remaining
  throw is the pre-existing persist throw in `save_artifact.ts`); `groundedSearch(`
  wired with trace in market-research skill; `localStorage` fallback lines intact
  in `validate/page.tsx`.

## Commands run

1. `node eval/run-eval.js` (workdir `D:\Downloads\Ai_OS`) → 8/8 pass.
2. `.\node_modules\.bin\tsc.cmd --noEmit --skipLibCheck` (workdir
   `D:\Downloads\Ai_OS\apps\web`) → only pre-existing untouched-file errors.
3. Grep checks: `demo-user|demo_user` (changed files, none found),
   `GO_THRESHOLD` (utils.ts, untouched), `throw new Error`
   (packages/tools, only pre-existing save_artifact.ts), `localStorage`
   (validate/page.tsx, fallback intact).

---

# Fix Round 2 — 2 Important Findings (2026-09-27)

Scope: 2 verbatim fixes, minimal edits. No subagents. Backward compatible.
No commits (no git repo).

## Fix A — `apps/web/src/app/api/agent/route.ts`: helper fallback no longer emits grounded URLs

- `callAIWithFallback`: new optional LAST param `groundingStatus?: { grounded:
  boolean }` (backward compatible — all existing callers omit it).
- Grounded-attempt loop: after `generateContent`, inspects
  `response.candidates[0].groundingMetadata ?? response.groundingMetadata`;
  sets `groundingStatus.grounded = true` only when `webSearchQueries.length >
  0` or `groundingSupports.length > 0`. Text with URLs but no such metadata
  stays `grounded: false`.
- Non-grounded fallback path: when `enableGrounding` is set and a
  `groundingStatus` object was passed, explicitly sets
  `groundingStatus.grounded = false` before returning text.
- `groundedSearch` helper path: passes `{ grounded: false }`, requires
  `validatedGrounded.length > 0 && groundingStatus.grounded` for
  `{ grounded: true, provider: "gemini" }`. Otherwise, any claimed results
  are stripped to `url: ""` and returned as `{ grounded: false, provider:
  "gemini-ungrounded" }` — downstream `runMarketResearchSkill` already
  downgrades `grounded === false` to secondary/opinion with no
  `source_type: web_search` plus a trace `warning: "ungrounded"`.
- Provider union extended to `"gemini" | "gemini-ungrounded" | "groq" |
  "none"` (trace/grounded checks unchanged; `!grounded` downgrade covers the
  new value).
- Residual (out of scope, left untouched): direct grounding-tool variants
  below the helper path still mark http(s) URLs as `grounded: true` without
  a metadata check; they only run when the helper yields zero claims.

## Fix B — `apps/web/src/app/api/startups/save/route.ts`: workspace membership gate

- Before `upsert`, when `workspace_id` is a valid UUID (`rawWorkspaceId`
  non-null): `select workspace_id from workspace_members where
  workspace_id=<id> and user_id=<auth user> maybeSingle()`; returns `403
  { error: "Forbidden: not a workspace member" }` when no row.
- Null/absent `workspace_id` (personal save) skips the check — backward
  compatible. Auth (`401`), `name` required (`400`), UUID validation, and
  `{ startup }` shape unchanged.

## Test evidence

- `node eval/run-eval.js` (from `D:\Downloads\Ai_OS`): **8 PASSED / 0 FAILED
  (100%)** after both fixes (re-ran after tsc scoping fix).
- `.\node_modules\.bin\tsc.cmd --noEmit --skipLibCheck` (apps/web): zero
  errors in both changed files (`api/agent`, `api/startups/save`); only
  pre-existing errors remain in untouched files (`history/page.tsx` JSX
  namespace, `supabase/server.ts` + `middleware.ts` implicit-any cookie
  params). One interim error (`groundingStatus` not destructured) was caught
  by tsc and fixed; final run is clean for changed files.
- Greps: no functional `demo-user` in changed files (only pre-existing
  comment `never demo-user` in `api/agent/route.ts`; no `"demo-user"`
  assignment, no `owner_id`/`user_id` demo fallback).

---

# Fix Round 3 — groundingToolVariants groundingMetadata proof (2026-09-27)

Scope: one hole only in `apps/web/src/app/api/agent/route.ts` lines 287-312.
No subagents. No threshold changes (`GO_THRESHOLD` untouched). No commits.

## Fix — direct grounding-tool variants require groundingMetadata proof

- Before: `groundingToolVariants` loop returned `{ grounded: true, provider:
  "gemini" }` on `isHttpUrl(url)` alone — model-invented URLs with no tool
  proof counted as grounded.
- After (same loop, after `model.generateContent`): inspects
  `response.candidates[0].groundingMetadata` with `response.groundingMetadata`
  fallback; requires `webSearchQueries` non-empty OR `groundingSupports` /
  `groundingChunks` non-empty to set `grounded: true`. Else strips URLs to
  `url: ""` and returns `{ grounded: false, provider: "gemini-ungrounded" }`
  (downstream already downgrades to secondary/opinion + trace
  `warning: "ungrounded"`).
- Try/catch fallthrough preserved: `catch` still `continue`s to the next
  variant; empty-`validated` now `continue`s (was `break`, which skipped the
  second variant) instead of breaking the loop.
- Mirrors the existing `callAIWithFallback` proof check (plus the
  `groundingChunks` alternative per spec).

## Test evidence

- `node eval/run-eval.js` (from `D:\Downloads\Ai_OS`): **8 PASSED / 0 FAILED
  (100%)** after the fix.
- `.\node_modules\.bin\tsc.cmd --noEmit --skipLibCheck` (apps/web): zero
  errors in `api/agent/route.ts`; only pre-existing errors remain in untouched
  files (`history/page.tsx` JSX namespace, `supabase/server.ts` +
  `middleware.ts` implicit-any cookie params) — same baseline as prior rounds.

---

# Final Fix Wave — 5 blockers minimal (2026-09-27)

Scope: 5 verbatim fixes, minimal edits. No subagents. No commits (no git repo).

## 1. `packages/db/schema-unified.sql` lines 14-15: pg_trgm extension

- Added `create extension if not exists "pg_trgm";` alongside `pgcrypto` /
  `uuid-ossp`, before the trigram GIN indexes (`idx_startups_name_trgm`,
  `idx_evidence_claim_trgm`). Idempotent, fixes missing-extension failure on
  fresh Supabase projects.

## 2. `apps/web/src/app/api/agent/route.ts`: experiments persist + membership gate

- Identity: `ownerId = user?.id || ""` — dropped `body.user_id` trust (never
  demo-user). `workspaceId = body.workspace_id || ""` unchanged.
- Membership gate: if `workspaceId` provided, `select workspace_id from
  workspace_members where workspace_id=<id> and user_id=<ownerId> maybeSingle()`;
  on miss pushes `trace executor/error { persist_warning: "Forbidden: not a
  workspace member, persistence skipped" }` and skips DB writes but still falls
  through to `done`.
- Experiments persist: after `decisions` insert, best-effort inner try/catch
  `supabase.from("experiments").insert({ id, startup_id, workspace_id,
  assumption_id: experiment.assumption_id ?? null, type, design, status })`;
  on fail pushes `trace executor/error { persist_warning: "experiments insert
  failed: ..." }` without breaking `trace_events` or `done`.
- `tables: 5` → `tables: 6` to reflect the added table.

## 3. `apps/web/src/app/api/search/route.ts` + `history/route.ts`: PostgREST escape

- Added `escapePostgrest(s)` in both files: escapes `\` first, then `% _ , ( )
  * " [ ]` with backslash prefix (covers `[,()%*_"\\]` + `%_` wildcards).
- `search/route.ts`: `const eq = escapePostgrest(q)` used in all three
  `.or()` ilike patterns (startups line 85, assumptions line 99, evidence line
  116); `rankBySimilarity` still scores on raw `q`.
- `history/route.ts` line 116: `const eq = escapePostgrest(q)` used in
  `name/one_liner/domain.ilike` `.or()`.

## 4. `history/route.ts` sort=verdict docs drift

- Header comment `sort — created_at | name | verdict` → `created_at | name |
  updated_at` to match `validSortCols = ["created_at","name","updated_at"]`.
  Chose remove-from-docs (simplest per instruction) over decisions-join ordering.

## 5. Docs drift: GO_THRESHOLD rung-4 x3 n30/12

- Canonical `GO_THRESHOLD` in `lib/utils.ts` untouched (verified): `MIN_RUNG 4,
  MIN_INDEPENDENT_SOURCES 3, MIN_SAMPLE_QUANT 30, MIN_INTERVIEWS_SATURATED 12`.
- `README.md` line 24: `≥1 rung-3 primary evidence + sample ≥15` →
  `rung-4+ x3 sources, n≥30 (or n≥12 saturated interviews)`.
- `apps/web/src/app/page.tsx` line 345: `Minimum rung 3 + ≥15 responses` →
  `Minimum rung-4+ x3 sources, n≥30 (or n≥12 interviews)`.

## Test evidence

- `node eval/run-eval.js` (from `D:\Downloads\Ai_OS`): **8 PASSED / 0 FAILED
  (100%)** after all 5 fixes.
- `.\node_modules\.bin\tsc.cmd --noEmit --skipLibCheck` (apps/web): zero
  errors in all changed files (`api/agent`, `api/search`, `api/history`,
  `page.tsx`); only pre-existing errors remain in untouched files
  (`history/page.tsx` JSX namespace, `supabase/server.ts` + `middleware.ts`
  implicit-any cookie params) — same baseline as prior rounds.
