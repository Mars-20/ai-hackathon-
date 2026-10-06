# Companion Memory — Design Spec v0.1.0 (Sub-project 1 of 3)

Status: PROPOSED — awaiting user review. DO NOT IMPLEMENT before written-spec approval + writing-plans.

## 1. Intent (agreed understanding)

Turn the agent from a single-session validator into a per-**user** co-founder companion that adapts to each
user's own style and stored memory. This spec covers **sub-project 1 of 3**: the memory foundation.
Sub-projects 2 (ongoing dialogue) and 3 (structured plans + progress stats) get their own specs later.

- Said by user: platform adapts to each user with their own character + stored memory; all three slices wanted;
  hybrid memory model (auto-inference, human approval); Supabase + Upstash both used.
- Assumptions (confirmed): user-level scope (`user_id`), not per-startup; trial users get memory too (conversion hook);
  semantic/vector search deferred to F-04.

## 2. Architecture — data split (approved §1)

| Layer | Home | Role |
|---|---|---|
| Durable memory | Supabase Postgres (tables + RLS) | User profile, approved facts, approval queue, plans/tasks (later) — anything that must never be lost |
| Working memory | Upstash Redis (short-TTL keys) | Live dialogue context, pre-approval inference drafts, per-user injection cache — all rebuildable |
| Semantic search | DEFERRED (pgvector vs Upstash Vector → F-04) | Sub-project 1 works at full accuracy without it (structured facts, no fuzzy retrieval) |

Principle (from trial-paywall precedent): **Postgres is the ledger; Redis is the accelerator. Nothing critical
lives in Redis alone.** Redis outage → injection cache miss → sessions run memory-less (fail-open for reads,
never fail-closed on product paths — unlike rate-limit which is fail-closed by design).

## 3. Data model (new migration, exact names TBD in plan)

`companion_profile` (one row per user):
- `user_id uuid PK → auth.users`, `style_notes text` (approved tone/style directives),
  `memory_enabled boolean default true` (the disable toggle — stops injection, deletes nothing),
  `created_at / updated_at`.

`companion_memory`:
- `id uuid PK`, `user_id uuid → auth.users (cascade)`, `kind enum('fact','preference','style','episode')`,
  `value text` (≤500 chars), `status enum('pending','approved','rejected')`,
  `confidence real` (inference score, NULL for manual entries),
  `source_session_id uuid NULL` (provenance — which run/dialogue produced it),
  `startup_id uuid NULL` (optional link when the memory is about a specific startup),
  `created_at / decided_at`.
- Deletion = HARD DELETE (no soft-delete theater — per MIT TR warning on fake forget controls).
- RLS: `select/insert/update/delete` own rows only (`auth.uid() = user_id`); service-role bypasses for server writes.
- Caps (anti-fatigue): max 20 `pending` per user (inference drops lowest-confidence overflow silently);
  max ~200 `approved` facts (oldest unreferenced episodes archived first — archive policy detailed in plan).

Conflict rule (external best practice): a candidate contradicting an approved fact does NOT overwrite —
both surface in the queue as a conflict pair for the user to resolve.

## 4. Hybrid approval lifecycle (approved §2, amended)

1. **Infer** (post-session, best-effort, never fails the run — same pattern as `consume_trial`): extract
   candidates with confidence; below-threshold dropped immediately; duplicates of approved suppressed.
2. **Queue**: survivors → Postgres `pending` (durable + user-visible). Redis holds only transient drafts.
3. **Decide** (page "ذكرياتي"): approve → injected from next session; edit-then-approve; reject → kept as
   `rejected` audit (never injected); forget → hard delete.
4. **Inject**: approved facts compiled to one system section, ~300-token cap ordered by
   (relevance × recency × kind-weight: semantic 0.6 / episodic 0.3 / style 0.1 — mem0 weighting),
   cached in Redis per user, invalidated on any approve/edit/reject/delete/toggle.
5. **Governance** (CHI'26 / CDT / MIT TR inputs): staged consent (decisions surface gradually, not upfront);
   provenance always shown (source + time); distinct hide/archive/delete/disable semantics;
   deletion executes for real across Postgres + Redis cache purge.

## 5. Injection into current agent sessions (approved §3)

- New server-only DAL `buildCompanionContext(userId)` → `{ systemSection: string, tokens: number }`.
- Agent route change is ADDITIVE ONLY: one system block ("ما أعرفه عن المؤسس" + style directive).
  The 6-step validation flow, verifier, SSE shapes, and 401/402/entitlement gates are UNTOUCHED.
- `memory_enabled=false` → empty section (reads fail-open); inference step skipped.
- Entitlement interplay: `trial_active` included (memory is the conversion hook); `paused` → inference paused,
  injection continues read-only (server still enforces writes); `legacy/subscribed` full.

## 6. External research inputs (2026 sources)

- Tripartite memory (semantic/episodic/procedural): Letta agent-memory; mem0 long-term-memory (extract →
  consolidate → store → retrieve; top-k scoring); Redis long-term-memory-architectures (read-before-reason /
  write-after-acting loop); AdMem arXiv:2606.06787; episodic-semantic arXiv:2605.17625; memory survey
  arXiv:2603.07670 (consolidation policy is the hard part; forgetting is under-evaluated; 4-layer metric stack).
- Consent/privacy: CHI'26 memory-privacy papers (staged consent, hide-vs-delete distinction, control asymmetry);
  CDT AI-memory roadmap (governance-enabling architecture, portable format, real deletion);
  MIT TR privacy-led UX + "what AI remembers" (provenance, memory categories, no fake forget).

## 7. Testing strategy

- Unit (vitest): token-cap ordering, Redis-invalidation on every state transition, conflict-pair surfacing,
  queue caps, RLS policies (own-only incl. cross-user negative), hard-delete purges cache.
- E2E (Playwright, real data): session N stores pending → approve → session N+1 reflects fact; disable toggle →
  sessions memory-less; delete → fact gone everywhere.
- Metrics (from survey Layer 1–4, scoped): task success with/without memory, contradiction rate ≈ 0,
  prompt-token overhead per session, storage growth per user.

## 8. Non-goals (explicit)

- No vector/semantic retrieval in this sub-project (F-04 decides the home).
- No procedural playbooks (`how-to` reuse) — later, on top of this foundation.
- No proactive/check-in scheduling — belongs to sub-project 2 (dialogue).
- No cross-user/shared memory — strictly `user_id`-isolated (trial-paywall RLS precedent).

## 9. Success criteria

- Fresh user → 3 sessions → queue holds ≥1 sensible pending; after approve, session 4 references it.
- "ذكرياتي" shows provenance for every row; delete removes it from Postgres + Redis (verified by test).
- Validation flow outputs byte-identical with memory disabled (regression suite).
- Prompt overhead ≤ 350 tokens/session median at 200 approved facts.
