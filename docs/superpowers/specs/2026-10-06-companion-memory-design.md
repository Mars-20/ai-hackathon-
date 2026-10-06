# Companion Memory — Design Spec v0.3.0 (Sub-project 1 of 3)

Status: PROPOSED (rev I — v0.2.0 + my own fresh-eyes review: 5 High + 7 Medium + stragglers, all patched below).
DO NOT IMPLEMENT before written-spec approval + writing-plans.

History: v0.1.0 → adversarial review 26 findings (`.superpowers/sdd/2026-10-06-companion-memory/spec-review.md`,
verdict NOT READY) → v0.2.0 (26/26 closed, verified) → personal re-review (5H+7M new) → this v0.3.0.

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
| Working memory | Upstash Redis (short-TTL keys) | Per-user injection cache + daily inference counter — rebuildable from Postgres |
| Semantic search | DEFERRED (pgvector vs Upstash Vector → F-04) | v1 uses a deterministic no-embeddings ranker (§7) |

Principle (trial-paywall precedent): **Postgres is the ledger; Redis is the accelerator. Nothing critical
lives in Redis alone.** Redis outage → cache miss → sessions run memory-less (fail-open for reads;
rate-limit stays fail-closed by design — opposite rules, each documented where used).

Redis schema (exact):
- `companion:ctx:v1:{userId}` → compiled injection block, max 4 KB, TTL 3600 s. Version prefix `v1` forces
  clean cutover on compiler changes (no stale-format serves).
- `companion:inferbudget:{userId}:{YYYYMMDD_UTC}` → daily inference counter, TTL 86400 s. Date is UTC;
  increment is an ATOMIC Lua check-and-inc (reuse the `lib/rate-limit.ts` EVAL pattern — concurrent sessions
  can never jointly overshoot; M4). Redis error here → SKIP inference (fail-open, warn-logged) — inference is
  non-critical enhancement, never a gate.
- Prefix registry: `companion:*` reserved; no overlap with `ratelimit:*` (`lib/rate-limit.ts:26`).

Transition → cache behavior (exhaustive):

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

## 3. Data model — migration `0011`

Number fixed: `20240101000011_companion_memory.sql`, applied after `0010`. No `handle_new_user` rewrite:
profile rows are **lazy-created** with `insert … on conflict (user_id) do nothing` on first memory use —
race-safe by construction (the `0010:109` guard pattern). **No backfill**: legacy users get a profile on first use.

`companion_profile` (one row per user):
- `user_id uuid PK → auth.users(id) on delete cascade`, `memory_enabled boolean not null default true`
  (disable toggle — stops injection, deletes nothing), `created_at / updated_at`.
- Single-writer rule: style directives live ONLY as `style`-kind rows in `companion_memory`. No ghost directives.

`companion_memory`:
- `id uuid PK default gen_random_uuid()`, `user_id uuid not null → auth.users(id) on delete cascade`,
  `kind enum('fact','preference','style','episode')`, `value text not null CHECK (char_length(value) BETWEEN 1 AND 500)`
  (DB owns the length guard; zod mirrors it),
  `status enum('pending','approved','rejected') not null default 'pending'`,
  `confidence real NULL` (0..1 scale, §6; NULL = human-entered, always treated as 1.0),
  `source_ref text NULL` (OPAQUE provenance string: run timestamp + startup name — NOT a FK: no `sessions`/`runs`
  table exists today; dialogue-linked provenance deferred to sub-project 2),
  `startup_id uuid NULL → startups(id) on delete set null` (DETACH on deletion — user-level memory survives;
  multi-startup memories leave it NULL) **plus write-time ownership check: the startup's `owner_id` must equal
  `auth.uid()`, else 422 `STARTUP_NOT_OWNED`** (FK proves existence, not ownership — H4),
  `created_at / decided_at`.
- Row status machine (M1 — allowed transitions only): `pending→approved`, `pending→rejected`,
  `rejected→approved` (changed mind), `approved→rejected` (regret — keeps audit); `approved→pending` FORBIDDEN
  (delete instead); re-approving an `approved` row → 200 idempotent same-state.
- Deletion = HARD DELETE. `rejected` rows: retained 30 days for audit, then hard-deleted by the archive job
  (**scheduler: pg_cron, following migration `0007` precedent; job definition in plan** — M7).
- RLS (exact idiom `(select auth.uid())`): `… using ((select auth.uid()) = user_id)` for
  select/insert/update/delete, own rows only (0010 precedent). Service-role writes ONLY via named RPCs
  (consume_trial precedent) — the plan names them (`propose_memories`, `decide_memory`, `purgeCompanionCache`
  usage); no blanket bypass.
- Caps (M2 — enforcement point): `SELECT companion_profile … FOR UPDATE` (row lock) → count → write, inside the
  write transaction: max 20 `pending`/user (overflow drops lowest-confidence, trace-logged), max 200
  `approved`/user (POST or approve beyond → 409 `MEMORY_FULL`, Arabic copy §9 — never silent). Best-effort under
  race (overshoot bounded by lock scope); archive job deletes oldest `episode` rows first.

## 4. Entitlement matrix — full 5 (+null) × operations

Statuses from `lib/entitlements.ts:6-11`. Agent gate (`resolveAgentGate`) denies `paused`/`trial_consumed`/null —
no session can start, so infer/inject are vacuous there.

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

1. **Infer** (post-agent-run `done` ONLY — not on `error`, not on 429/402/budget-denied pre-flights; extract
   candidates + confidence; below-threshold dropped; normalized exact-match dupes of approved suppressed,
   lowercase+trim; semantic dedup = F-04 handoff).
   **Execution context (H1): inference NEVER runs in-band — zero added session latency.** It runs in Next.js
   `after()` following SSE `done`, wrapped in try/catch with `companion_infer` tracing; any failure (including a
   platform without `after`) → skip + warn. If `after()` is unavailable, the plan MUST provide an out-of-band
   worker or disable inference explicitly — never silently in-band.
2. **Queue**: survivors → Postgres `pending` (durable + visible). Redis holds NO drafts.
3. **Decide** ("ذكرياتي", Arabic copy in §9): approve → injected next session; edit-then-approve;
   reject → `rejected` (30-day audit, never injected); forget → hard delete + Redis purge.
   Conflict pair (candidate vs contradictory approved fact): surfaced TOGETHER, no overwrite.
4. **Inject**: §7. **Disable** (`memory_enabled=false`): injection empty + inference skipped (hide-vs-delete).
5. **Governance**: staged consent (queue surfaces gradually); provenance shown per row; deletion real everywhere.

## 6. Inference budget + confidence contract

- `confidence real 0..1`; extraction threshold **0.7** (initial, tunable per kind in plan).
- Daily cap: **50 inference calls/user/day** (atomic Lua check-and-inc BEFORE the LLM call — spend-first-drop-later
  closed; over → skip + trace-log).
- Cost attributed to the workspace spend ledger wiring point (`lib/cost`) — exact plumbing in plan; envelope:
  ~1 extraction call ≈ ~1.5k tokens (estimate, re-measured in plan) ⇒ worst case ≈75k tokens/user/day, typical ≪.
- Kind weights: `fact 0.6 / preference 0.5 / episode 0.3 / style 0.1` (initial multipliers, retune after measurement).

## 7. Injection — deterministic v1 ranker + real injection points

Token rule (single normative statement): compiler target ≤300 content tokens; measured session overhead
p50 ≤350 including framing, counter = `promptTokenCount` delta on the mocked-provider fixture set (§11).

Ranker (no embeddings): score = kind-weight × exp(-age_days/30) (M3 — exponential decay, 30-day half-life… precisely:
half-life = 30·ln2 ≈ 20.8 days; tunable) × (1 + overlap), where overlap = shared normalized tokens ÷ query tokens.
**Normalization is Arabic-aware (H3)**: reuse the F-04 normalization precedent (lowercase, strip URLs/emojis/diacritics,
Arabic-Indic digit folding) then whitespace-tokenize — NO stemming assumed (Arabic morphology is a stated F-04
upgrade). If the query yields zero tokens post-normalization → overlap bonus 0 (deterministic fallback to
recency × kind — stated, not silent). Top rows fill ≤300 tokens. Embeddings upgrade = F-04.

Injection points (honest): the agent route has 6+ independent prompt sites (skills `route.ts:881,982,1282,
1431,1535`, verifier `1690`, router `253-297`). The plan MUST introduce ONE helper
`composePrompt(base, companionCtx)` applied at every `callAIWithFallback` site — a small prompt-assembly refactor
is IN SCOPE. Verifier stays UNTOUCHED **with one binding rule (H2): the companion block is NEVER evidence.**
The verifier MUST exclude it when checking claim support — a memo claim supported ONLY by memory FAILS verification,
with a dedicated test (memory-only claim → rejected). This is what makes the backstop real instead of slogan.

DAL (named): `lib/companion/dal.ts` with `import "server-only"`, identity from
`supabase.auth.getUser()` server-side (NEVER a caller-supplied `userId` — the `route.ts:1754` anti-pattern),
errors normalized via `toEnvelope()` (`lib/admin-dal.ts:41-72` pattern, user-gated variant).
**Deploy-window tolerance (M6): the DAL MUST run memory-less (empty context + warn trace) when the `0011`
tables are absent** — migration-first rollout still required; tolerance is a backstop (Task 7's 500 lesson), not license.

## 8. API shapes

Order on every route: **401 auth check BEFORE rate-limit** (Task 6 precedent — anon never burns buckets; M5).
Validation: zod mirrors DB CHECKs.

- `GET /api/companion/memory?status=pending|approved|rejected|all&limit=&cursor=` → 200
  `{items:[{id,kind,value,status,confidence,source_ref,created_at}], nextCursor}` (cursor pagination;
  `all` = pending+approved; matrix §4 for 402s).
- `POST /api/companion/memory` `{kind,value,startup_id?}` → 201 (human-entered ⇒ `approved`, confidence NULL);
  422 on schema fail **or non-owned `startup_id` (`STARTUP_NOT_OWNED`)**; 409 `MEMORY_FULL` when approved cap hit,
  409 on normalized exact-dupe.
- `PATCH /api/companion/memory/:id` `{action:"approve"|"reject", value?}` → 200 (idempotent re-approve);
  404 unknown id; 409 `MEMORY_FULL` on approve-when-full. Only transitions in §3 allowed, else 422.
- `DELETE /api/companion/memory/:id` → 200 hard delete + cache purge; 404 unknown.
- `POST /api/companion/profile/toggle` `{memory_enabled:bool}` → 200.
- 429 via `checkRateLimit` (`mem:<userId>`, 30/min) on all five.

## 9. Arabic copy (first-pass table)

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
| provenance | من جلسة {date} (عرض التاريخ بlocale عربي) |
| cap_full | القائمة ممتلئة — احذف ذكرى أولًا |
| memory_full | ذاكرتك ممتلئة (200) — احذف أو اندمج قبل إضافة جديد |
| startup_not_owned | هذا المشروع ليس لك |
| secret_blocked | عذرًا — لا أحفظ المفاتيح والبيانات الحساسة |

## 10. Threat model

1. **Memory poisoning (Critical)**: approved `value` is attacker-influenced text. Mitigations (ALL mandatory):
   (a) inject-time `sanitizeForPrompt()` + `toUntrusted()` wrap on EVERY value (reuse `route.ts:120-122,1738-1745`
   posture — memory is untrusted input, never system-trusted); (b) per-value charset/length rules (CHECK + zod);
   (c) values NEVER alter role structure (injected as quoted data block, delimiters fixed);
   (d) verifier non-evidence rule (§7) + dedicated test.
2. **Staleness/pivot**: facts carry timestamps; conflict re-surfacing when new approved contradicts old
   (both shown, user resolves); episodes archived oldest-first (§3).
3. **Consent fatigue**: 20-pending cap + confidence threshold + silent overflow trace-logged (not user-pinging).
4. **Rejected retention**: 30-day TTL then hard delete (archive job) — resolves audit-vs-deletion tension.
5. **Secrets/PII in values (H5)**: write-time scan → BLOCK with Arabic warning (`secret_blocked`), never stored.
   **About-the-user rule (binding)**: inference extracts facts ABOUT the account holder ONLY. Persons appearing in
   evidence/interviews/CSV (respondents, customers, third parties) are NEVER stored — the extraction prompt forbids
   person-entities other than the user, and the scan blocks email/phone/national-ID patterns in INFERRED candidates.
   MANUALLY entered values are the user's explicit act and pass (still length/charset-checked).
6. **Approval-rate abuse**: decide endpoints rate-limited (§8); mass-approve is user-explicit and logged.

## 11. Testing + rollout + observability

- Determinism: mocked-provider fixture set; assertion = identical fixtures + memory disabled ⇒ identical composed
  prompts (prompt-level, not live-LLM byte equality — provable in CI).
- Overhead metric: p50 of `promptTokenCount` delta (memory on vs off) on fixture set ≤350, asserted in vitest
  with mocked providers.
- Inference bar: fixture N=30 runs ⇒ ≥80% yield ≥1 pending with confidence ≥0.7 and zero secret-scan flags,
  judged by checked-in rubric R (plan writes it).
- Rollout order: migration `0011` → backfill none (lazy) → code (with M6 tolerance) → cache with `v1` key prefix.
- Meters (named): `companion_inject` (hit/miss/disabled), `companion_infer` (latency, skipped-over-cap),
  approval rate, contradiction-pair count, rejected-retention deletes. New `trace_events` types:
  `companion_inject | companion_infer | companion_decide`.

## 12. Non-goals

No vector retrieval (F-04); no procedural playbooks; no proactive scheduling (sub-project 2);
no cross-user memory; provenance stays opaque text until sub-project 2 defines dialogue sessions.

## 13. Success criteria (falsifiable)

- Fixture user → 3 mocked sessions → ≥1 pending conf ≥0.7; after approve, session 4's composed prompt contains it.
- "ذكرياتي" shows provenance per row; delete ⇒ absent from Postgres + Redis (test asserts both).
- Disabled-memory composed prompts identical to pre-feature prompts on fixture set.
- Overhead p50 ≤350 on fixture set; inference skips over daily cap with trace (no spend).
