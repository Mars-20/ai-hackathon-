# Companion Memory — Design Spec v0.2.0 (Sub-project 1 of 3)

Status: PROPOSED (rev H — hardened after adversarial review 26 findings: 4 Critical + 11 High + 10 Medium + 1 Low,
all addressed below). DO NOT IMPLEMENT before written-spec approval + writing-plans.

Adversarial review: `.superpowers/sdd/2026-10-06-companion-memory/spec-review.md` (verdict on v0.1.0: NOT READY).
Finding IDs (F-01…F-26) referenced per fix.

## 1. Intent (agreed understanding)

Turn the agent from a single-session validator into a per-**user** co-founder companion that adapts to each
user's own style and stored memory. This spec covers **sub-project 1 of 3**: the memory foundation.
Sub-projects 2 (ongoing dialogue) and 3 (structured plans + progress stats) get their own specs later.

- Said by user: platform adapts to each user with their own character + stored memory; all three slices wanted;
  hybrid memory model (auto-inference, human approval); Supabase + Upstash both used.
- Assumptions (confirmed): user-level scope (`user_id`), not per-startup; trial users get memory too (conversion hook);
  semantic/vector search deferred to F-04.

## 2. Architecture — data split

| Layer | Home | Role |
|---|---|---|
| Durable memory | Supabase Postgres (tables + RLS) | Profile toggle, approved facts, approval queue — anything that must never be lost |
| Working memory | Upstash Redis (short-TTL keys) | Per-user injection cache only — rebuildable from Postgres |
| Semantic search | DEFERRED (pgvector vs Upstash Vector → F-04) | v1 uses a deterministic no-embeddings ranker (§7); "full accuracy" claim DROPPED (F-22) |

Principle (trial-paywall precedent): **Postgres is the ledger; Redis is the accelerator. Nothing critical
lives in Redis alone.** Redis outage → cache miss → sessions run memory-less (fail-open for reads;
rate-limit stays fail-closed by design — opposite rules, each documented where used).

Redis schema (exact — F-06):
- `companion:ctx:v1:{userId}` → compiled injection block, max 4 KB, TTL 3600 s. Version prefix `v1` forces
  clean cutover on compiler changes (no stale-format serves).
- `companion:inferbudget:{userId}:{YYYYMMDD}` → daily inference counter, TTL 86400 s. Redis error here →
  SKIP inference (fail-open, warn-logged) — inference is non-critical enhancement, never a gate (F-14).
- Prefix registry: `companion:*` reserved; no overlap with `ratelimit:*` (`lib/rate-limit.ts:26`).

Transition → cache behavior (exhaustive — closes F-04):

| Transition | Cache action | Rationale |
|---|---|---|
| approve / edit-then-approve | `DEL companion:ctx:v1:{userId}` | compiled block changed — recompile on next read |
| forget (hard delete) | `DEL` | row gone everywhere |
| disable/enable toggle | `DEL` | injection on/off flips output |
| archive-job delete (service-role) | `DEL` via shared `purgeCompanionCache(userId)` helper | background writes invalidate exactly like request writes |
| any other service-role write | `DEL` via the same helper (plan MUST route all service writes through it) | no silent stale path |
| reject write | NONE (deliberate) | rejected rows are never injected — invalidating would be pure churn |
| pending write | NONE (deliberate) | pending rows are not injected yet |
| TTL expiry (3600 s) | natural miss → recompile | bounds staleness of ANY missed path to ≤1h worst case |

## 3. Data model — migration `0011` (F-09)

Number fixed: `20240101000011_companion_memory.sql`, applied after `0010`. No `handle_new_user` rewrite
(it was rewritten twice already): profile rows are **lazy-created** with `insert … on conflict (user_id)
do nothing` on first memory use — race-safe by construction (the `0010:109` guard pattern). **No backfill**:
legacy users get a profile on first use (first-use behavior defined in §4 matrix).

`companion_profile` (one row per user):
- `user_id uuid PK → auth.users(id) on delete cascade`, `memory_enabled boolean not null default true`
  (disable toggle — stops injection, deletes nothing), `created_at / updated_at`.
- NOTE: v0.1.0's `style_notes` column is REMOVED — single-writer rule (F-11): style directives live ONLY as
  `style`-kind rows in `companion_memory`. No ghost directives.

`companion_memory`:
- `id uuid PK default gen_random_uuid()`, `user_id uuid not null → auth.users(id) on delete cascade`,
  `kind enum('fact','preference','style','episode')`, `value text not null CHECK (char_length(value) BETWEEN 1 AND 500)`
  (DB owns the length guard; zod mirrors it — F-13),
  `status enum('pending','approved','rejected') not null default 'pending'`,
  `confidence real NULL` (0..1 scale, §6; NULL = human-entered, always treated as 1.0),
  `source_ref text NULL` (OPAQUE provenance string: run timestamp + startup name — NOT a FK: no `sessions`/`runs`
  table exists today, F-08/F-23; dialogue-linked provenance deferred to sub-project 2),
  `startup_id uuid NULL → startups(id) on delete set null` (DETACH on startup deletion — user-level memory
  survives its startup; multi-startup memories leave it NULL — F-08),
  `created_at / decided_at`.
- Deletion = HARD DELETE (no soft-delete theater). `rejected` rows: retained 30 days for audit, then hard-deleted
  by the archive job (retention TTL — resolves F-26c tension with real-deletion).
- RLS (exact idiom `(select auth.uid())`, F-21): `… using ((select auth.uid()) = user_id)` for
  select/insert/update/delete, own rows only (0010 precedent: entitlements select-own `0010:51-53`,
  subreq select+insert `0010:54-60`). Service-role writes ONLY via named RPCs (consume_trial precedent
  `0010:64-81`) — no blanket bypass.
- Caps: max 20 `pending`/user (inference drops lowest-confidence overflow; the DROP is trace-logged, F-14);
  max 200 `approved`/user; archive job deletes oldest `episode` rows first (reference tracking dropped as
  unbuildable pre-F-04 — F-24; "unreferenced" rule replaced by oldest-episode-first).

## 4. Entitlement matrix — full 5 (+null) × operations (F-01, F-02)

Statuses from `lib/entitlements.ts:6-11`. Agent gate (`resolveAgentGate`) denies `paused`/`trial_consumed`/null —
no session can start, so infer/inject are vacuous there (v0.1.0's "read-only injection" for paused: REMOVED as
unreachable; "server still enforces writes" phrase REMOVED as meaningless).

| status | infer (post-run) | queue READ | queue DECIDE (approve/reject/forget) | inject |
|---|---|---|---|---|
| `trial_active` | yes | yes | yes | yes |
| `subscribed` | yes | yes | yes | yes |
| `legacy` | yes | yes | yes | yes |
| `trial_consumed` | no (no sessions) | yes, read-only (conversion surface) | no → 402 `TRIAL_CONSUMED` | no (no sessions) |
| `paused` | no | no → 402 `ACCOUNT_PAUSED` | no → 402 | no |
| null/missing | no | no → 402 `SUBSCRIPTION_REQUIRED` | no → 402 | no |

Memory APIs enforce this matrix server-side (never trust client status). Inference cost is therefore bounded by
sessions the gate already allowed — plus the daily cap in §6.

## 5. Hybrid approval lifecycle

1. **Infer** (post-agent-run `done` ONLY — not on `error`, not on 429/402/budget-denied pre-flights which never
   ran; F-07): extract candidates + confidence; below-threshold dropped; normalized exact-match dupes of
   approved suppressed (lowercase+trim; semantic dedup = F-04 handoff — F-18).
2. **Queue**: survivors → Postgres `pending` (durable + visible). Redis holds NO drafts (v0.1.0 draft keys removed).
3. **Decide** ("ذكرياتي", Arabic copy in §9): approve → injected next session; edit-then-approve;
   reject → `rejected` (30-day audit, never injected); forget → hard delete + Redis purge.
   Conflict pair (candidate vs contradictory approved fact): surfaced TOGETHER, no overwrite (F-10 weight fix below).
4. **Inject**: §7. **Disable** (`memory_enabled=false`): injection empty + inference skipped (hide-vs-delete — F-26e).
5. **Governance**: staged consent (queue surfaces gradually); provenance shown per row; deletion real everywhere.

## 6. Inference budget + confidence contract (F-14, F-18)

- `confidence real 0..1`; extraction threshold **0.7** (initial, tunable per kind in plan).
- Daily cap: **50 inference calls/user/day** (`companion:inferbudget:*`); over → skip silently + trace-log
  (spend-first-drop-later hole closed: the cap is checked BEFORE the LLM call — F-14).
- Cost attributed to the workspace spend ledger wiring point (`lib/cost`) — exact plumbing in plan; envelope:
  1 extraction call ≈ 1.5k tokens ⇒ ≤75k tokens/user/day worst case, typical ≪ (only sessions that ran infer).
- Kind weights (all 4 enum members covered — F-10): `fact 0.6 / preference 0.5 / episode 0.3 / style 0.1`
  (initial multipliers, retune after measurement).

## 7. Injection — deterministic v1 ranker + real injection points (F-19, F-22)

Token rule (single normative statement — F-03): compiler target ≤300 content tokens; measured session overhead
p50 ≤350 including framing, counter = `promptTokenCount` delta on the mocked-provider fixture set (§11).

Ranker (no embeddings — F-22): score = kind-weight × recency-decay × (1 + keyword-overlap bonus, defined as
shared non-stopword stems ÷ query stems, deterministic). Top rows fill ≤300 tokens. Embeddings upgrade = F-04.

Injection points (honest — F-19): the agent route has 6+ independent prompt sites (skills `route.ts:881,982,1282,
1431,1535`, verifier `1690`, router `253-297`). The plan MUST introduce ONE helper
`composePrompt(base, companionCtx)` applied at every `callAIWithFallback` site — a small prompt-assembly refactor
is IN SCOPE (v0.1.0's "one block, everything untouched" was fiction). Verifier stays UNTOUCHED **and** becomes
the poisoning backstop: memory-derived claims without evidence FAIL verification by construction (§10) —
documented interaction, not contradiction.

DAL (named — F-20): `lib/companion/dal.ts` with `import "server-only"`, identity from
`supabase.auth.getUser()` server-side (NEVER a caller-supplied `userId` — the `route.ts:1754` anti-pattern),
errors normalized via `toEnvelope()` (`lib/admin-dal.ts:41-72` pattern, user-gated variant).

## 8. API shapes (F-13)

All routes: 401 anon (existing auth pattern). Validation: zod mirrors DB CHECKs.

- `GET /api/companion/memory?status=pending|approved|all&limit=&cursor=` → 200 `{items:[{id,kind,value,status,
  confidence,source_ref,created_at}], nextCursor}` (cursor pagination; matrix §4 for 402s).
- `POST /api/companion/memory` `{kind,value,startup_id?}` → 201 (human-entered ⇒ `approved`, confidence NULL);
  422 on schema fail; 409 on normalized exact-dupe of an approved row.
- `PATCH /api/companion/memory/:id` `{action:"approve"|"reject", value?}` → 200; 404 unknown id; 409 on
  approve-when-cap-full (delete something first — explicit, never silent).
- `DELETE /api/companion/memory/:id` → 200 hard delete + cache purge; 404 unknown.
- `POST /api/companion/profile/toggle` `{memory_enabled:bool}` → 200.
- 429 via `checkRateLimit` (`mem:<userId>`, 30/min) on all five.

## 9. Arabic copy (first-pass table — F-12)

| key | ar |
|---|---|
| page_title | ذكرياتي |
| pending_queue | بانتظار موافقتك |
| approve | اعتماد |
| edit_approve | تعديل واعتماد |
| reject | رفض |
| forget | نسيان نهائي |
| forget_confirm | سيُحذف نهائيًا من كل مكان — متأكد؟ |
| disable | إيقاف الذاكرة مؤقتًا |
| disable_hint | يتوقف التخصيص دون حذف أي شيء |
| conflict_pair | يتعارض مع ذكرى معتمدة — اختر الصحيحة |
| empty_queue | لا شيء بانتظارك — سأقترح ما أتعلمه هنا |
| provenance | من جلسة {date} |
| cap_full | القائمة ممتلئة — احذف ذكرى أولًا |

## 10. Threat model (F-05, F-26 — was entirely absent)

1. **Memory poisoning (Critical)**: approved `value` is attacker-influenced text. Mitigations (ALL mandatory):
   (a) inject-time `sanitizeForPrompt()` + `toUntrusted()` wrap on EVERY value (reuse `route.ts:120-122,1738-1745`
   posture — memory is untrusted input, never system-trusted); (b) per-value charset/length rules (CHECK + zod);
   (c) values NEVER alter role structure (injected as quoted data block, delimiters fixed);
   (d) verifier backstop (§7) rejects evidence-less memory claims from memos.
2. **Staleness/pivot**: facts carry timestamps; conflict re-surfacing when new approved contradicts old
   (both shown, user resolves); episodes archived oldest-first (§3).
3. **Consent fatigue**: 20-pending cap + confidence threshold + silent overflow trace-logged (not user-pinging).
4. **Rejected retention**: 30-day TTL then hard delete (archive job) — resolves audit-vs-deletion tension.
5. **Secrets/PII in values**: write-time scan (key/token patterns) → BLOCK with Arabic warning, never stored.
6. **Approval-rate abuse**: decide endpoints rate-limited (§8); mass-approve is user-explicit and logged.

## 11. Testing + rollout + observability (F-15, F-16, F-17, F-25)

- Determinism (rewritten — F-15): mocked-provider fixture set; assertion = identical fixtures + memory
  disabled ⇒ identical composed prompts (prompt-level, not live-LLM byte equality — provable in CI).
- Overhead metric (defined — F-16): p50 of `promptTokenCount` delta (memory on vs off) on fixture set ≤350,
  asserted in vitest with mocked providers.
- Inference bar (falsifiable — F-17): fixture N=30 runs ⇒ ≥80% yield ≥1 pending with confidence ≥0.7 and zero
  secret-scan flags, judged by checked-in rubric R.
- Rollout order: migration `0011` → backfill none (lazy) → code → cache with `v1` key prefix (no stale format).
- Meters (named): `companion_inject` (hit/miss/disabled), `companion_infer` (latency, skipped-over-cap),
  approval rate, contradiction-pair count, rejected-retention deletes. New `trace_events` types:
  `companion_inject | companion_infer | companion_decide`.

## 12. Non-goals (unchanged + dialogue fields deferred — F-23)

No vector retrieval (F-04); no procedural playbooks; no proactive scheduling (sub-project 2);
no cross-user memory; provenance stays opaque text until sub-project 2 defines dialogue sessions.

## 13. Success criteria (falsifiable)

- Fixture user → 3 mocked sessions → ≥1 pending conf ≥0.7; after approve, session 4's composed prompt contains it.
- "ذكرياتي" shows provenance per row; delete ⇒ absent from Postgres + Redis (test asserts both).
- Disabled-memory composed prompts identical to pre-feature prompts on fixture set.
- Overhead p50 ≤350 on fixture set; inference skips over daily cap with trace (no spend).
