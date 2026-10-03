# Task 1 Report — Validation layer

**Status:** DONE (pre-SDD controller implementation, submitted for task review)

**What implemented:**
- `src/lib/validation.ts` with `workspaceIdSchema`, `inviteSchema`, `startupSaveSchema`, `searchQuerySchema` (zod, exact enums above)
- `src/lib/__tests__/validation.test.ts` with 4 tests (invalid role, bad email, valid invite, bad stage)
- `vitest.config.ts` + `package.json` scripts `typecheck/test/test:ci` + vitest/vite devDeps (legacy-peer-deps)
- `api/workspace/invite/route.ts`: `safeParse` → `400 {issues}`, DB error generic `500 {Failed to create invite}` + internal log without error object, removed `console.log token` + `debug_token` entirely

**Tests:**
- RED: `npx vitest run src/lib/__tests__/validation.test.ts` → `FAIL Cannot find package '@/lib/validation'` (expected, feature missing)
- GREEN: same command → `1 passed (4 tests)` + `---EXIT_0`
- `tsc --noEmit --skipLibCheck` → `TSC_EXIT_0`
- `next lint` → `No ESLint warnings or errors` + `LINT_EXIT_0`
- `npm run test:ci` → `1 passed (4 tests)`

**Files changed:** `src/lib/validation.ts` (new), `src/lib/__tests__/validation.test.ts` (new), `vitest.config.ts` (new), `src/app/api/workspace/invite/route.ts` (modified), `package.json` + `package-lock.json` (scripts + deps)

**Self-review:** wiring for `save/route.ts` + `search/history` whitelist not yet done (plan lists them in T1 files but implementation deferred to avoid scope creep; T6 owns search counts, T1 owns invite gate). Noted as concern for reviewer to judge as Missing vs deferred.

**Concerns:** `save/route.ts` still returns `500` on bad stage (not yet wired); `search/history` still without zod wiring. Recommend reviewer flag as Important if T1 brief requires them now, else park to T6/T8 with ruling.

---
# Fix Round 1/5 (Task 1 owner — 2026-10-03)

**Findings fixed (all 5):**
1. `api/startups/save/route.ts` wired: `startupSaveSchema.safeParse` → `400 {error, issues}`; invalid non-empty `id`/`workspace_id` → `400` (empty→absent; absent id → `crypto.randomUUID()`; absent workspace → `null`); DB error hidden (generic `500 {Failed to save startup}` + `console.error` without error object); stage/name/domain now schema-validated (no more CHECK-violation 500).
2. `api/search/route.ts` + `history/route.ts` wired (minimal, no counts/RPC change — Task 6 untouched): search uses `searchQuerySchema.safeParse` → `400 {error, issues}`; history uses `historyQuerySchema.safeParse` (csv→arrays) → `400`, plus `startup_id` uuid guard → `400`. Ranking, `decisions!inner`, `count exact`, `range` logic unchanged.
3. `validation.ts:16 workspace_id` decision: KEPT OPTIONAL (read save route first — it allows personal startups with `workspace_id: null`). Justification: isolation falls back to `owner_id === auth user`; added code comment + owner-hijack guard (client-supplied id → verify owner or workspace membership, else 403) + test proving missing `workspace_id` parses OK while invalid uuid fails.
4. `MemberRole` import in invite route: CHECKED — USED (`ROLE_RANK: Record<MemberRole,number>` + cast), so kept. Enums stay hardcoded with sync comment (types.ts exports types only, no runtime values — derivation not trivial).
5. `validation.test.ts` extended 4 → 8 tests: + invalid workspace_id uuid, + missing workspace_id (personal fallback), + name trim/max200, + searchQuerySchema plural whitelist/default-limit-5/q-min2.

**Schema corrections (dead-code fix):** `searchQuerySchema.type` singular → plural `["all","startups","assumptions","evidence"]` (matches search route branches); `q` min1→min2, `limit` max50/default20 → max20/default5 (matches route header `min 2 chars / default 5 / max 20`). Added `historyQuerySchema` + single-value whitelists (verdict/confidence/stage/sort/order, page/limit).

**TDD:** extended test first → RED `1 failed` (singular `startup` wrongly accepted) → fixed `validation.ts` → GREEN `8 passed`. Routes wired after schema green.

**Tests:** `vitest run src/lib/__tests__/validation.test.ts` → `1 passed (8 tests)`; `tsc --noEmit --skipLibCheck` → clean (no output). No token logs; no `error.message` to client (grep verified).

**Files changed:** `src/lib/validation.ts`, `src/lib/__tests__/validation.test.ts`, `src/app/api/startups/save/route.ts`, `src/app/api/search/route.ts`, `src/app/api/history/route.ts`.
