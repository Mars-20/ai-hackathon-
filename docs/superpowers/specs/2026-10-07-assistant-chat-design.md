# Assistant Chat — Design Spec (approved, adversarially hardened v2)

- **Date:** 2026-10-07 (v2 after 5-agent adversarial loop + line-level verification)
- **Status:** APPROVED by product owner (all 3 sections signed off in chat)
- **Path:** architectural (new subsystem; no existing chat flow in repo)
- **Approach:** Approach 1 — conversation layer over existing, tested infrastructure
- **Scope:** v1 = grounded Q&A (A) + 4 tool actions (B). Foundation must admit open chat (C) later with no rework. Zero tech debt: nothing deferred, no TODOs in shipped code.
- **Loop verdict:** every reuse claim below is verified against exact file:line. Items the loop refuted are corrected here; nothing is assumed.

## 1. Outcome & success criteria

A logged-in user opens a standalone **Assistant page** (`/assistant`), holds a persistent multi-turn conversation grounded exclusively in their own data (startups, assumptions, evidence, experiments, decisions, companion memories), invokes 4 actions from chat, and can optionally pop the same conversation into a **floating window** on any page.

Success = all acceptance gates in §10 pass; a user question about their own decision returns a cited answer; a question with no supporting data returns an explicit refusal (never a fabrication); quota, RLS, and error behavior verified by tests, not by inspection.

## 2. Approved decisions (binding)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | v1 = A (grounded Q&A) + B (actions 1–4), architected for C later | Blast radius zero now; open chat later = prompt/config change only |
| D2 | All 4 actions ship in v1 (run validation, save memory, create/edit experiment, smart navigation). Nothing deferred | Owner: no tech debt |
| D3 | Independent daily chat quota (default 50 msgs/day, env `ASSISTANT_DAILY_QUOTA` via `resolvePositiveInt`), never touches validation quota | A long chat must never eat validation capacity |
| D4 | Approach 1: reuse entitlements, compiled memory context, key-rotation/timeout/usage primitives, sanitizers, verifier-as-critic | Every sensitive layer already tested; new surface is: conversation storage + quota + 4 tool wrappers + model tool-caller + UI |
| D5 | Standalone `/assistant` page + opt-in floating widget sharing one `AssistantPanel` component and one API | No duplicated logic between page and widget |
| D6 | Atomic quota consumption (`consume_assistant_message`, `consume_trial` row-lock pattern). One message = one unit, consumed at model dispatch (after all gates pass); total provider outage before dispatch triggers `refund_assistant_message` | No double-spend via retries; contradicts nothing: consume point is defined, refund path is explicit |
| D7 | Quota-exhausted = **402** (paywall semantics, budget precedent `agent/route.ts:1877-1883`), never 429. Rate-limit/infra-fail = 429 mirroring agent shape | One status-code language across the product |
| D8 | No markdown renderer in v1: assistant text renders as plain text + citation chips + action cards. XSS closed by construction | `package.json` has no react-markdown/dompurify; adding a renderer would open a sanitizer-maintenance burden |
| D9 | Float preference + quota admin read ship in v1 (no localStorage-now/DB-later, no ops-blindness) | Zero-debt: the loop caught both as deferred work; both are now in scope |

## 3. Architecture

```
Browser (/assistant page | floating widget → same <AssistantPanel/>)
  │  SSE via shared createSseParser (lib/sse-client.ts:29) + terminal guard
  ▼
POST /api/assistant { conversation_id?, client_message_id (uuid, idempotency), message }
  ├─ 1. auth → 401 {error:"Unauthorized", code:"UNAUTHENTICATED"} (agent/route.ts:1900)
  ├─ 2. entitlement gate (resolveAgentGate, lib/entitlements.ts) → 402 TRIAL_CONSUMED /
  │     SUBSCRIPTION_REQUIRED / ACCOUNT_PAUSED (agent/route.ts:1934-1944)
  ├─ 3. validate input → 400 INVALID (message 1..4000 chars, uuid formats)
  ├─ 4. rate limit (checkRateLimit, lib/rate-limit.ts:178, fail-closed) → 429 + Retry-After
  ├─ 5. quota consume_assistant_message() (fail-closed on RPC error → 429 retryAfter:60,
  │     agent/route.ts:1924-1933) → 402 ASSISTANT_QUOTA_EXHAUSTED + plans_url + Retry-After
  │     (seconds to UTC midnight) + body {error, code, retryAfter, plans_url}
  ├─ 6. grounding fetch (workspace-scoped startups!inner pattern, search/route.ts:150-156;
  │     + getCompiledContext(userId, message) as query, dal.ts:366 + last 20 messages)
  ├─ 7. model call with 4 tools (NEW lib/assistant/model.ts callAssistantWithTools:
  │     functionDeclarations + multi-turn loop; reuses key rotation / withTimeout /
  │     usage accounting primitives — callAIWithFallback (route.ts:362) returns
  │     Promise<string> and CANNOT take tools, so silent reuse is forbidden).
  │     Dispatch-failure (zero bytes streamed: no keys / all providers down at
  │     call time) → refund_assistant_message; mid-stream failure → no refund,
  │     partial spend recorded (§9).
  ├─ 8. verifier-as-critic rescan (adapter cited rows → {claim, source_url},
  │     findUnsupportedFactualClaims, utils.ts:266; flagged draft → refusal + trace row)
  ├─ 9. recordSpendAsync(assistantBudgetKey, cost) on success AND partial on failure
  │     (agent/route.ts:2381-2387,2414-2419) — spec §5 of v1 was silent; now mandatory
  └─ 10. persist user msg + assistant reply (+ tool trace rows) → stream done
```

Upgrade path to (C): add `ASSISTANT_OPEN_CHAT=true` + a general system-prompt variant;
tools, grounding, quota untouched. No schema or route changes required.

## 4. Data model (migration `supabase/migrations/20240101000015_assistant_chat.sql`)

Conventions (verified): `if not exists`, schema-qualified `public.`, `drop policy if exists`
before each policy, policies `to authenticated` with `(select auth.uid())`
(0010:56-60, 0014:88), functions `security definer set search_path = ''` + REVOKE/GRANT
(0010:65-81), FK `on delete cascade` (0000:158).

```sql
create table if not exists public.assistant_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'New conversation'
    check (char_length(title) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.assistant_conversations enable row level security;
drop policy if exists "assistant_conversations_owner" on public.assistant_conversations;
create policy "assistant_conversations_owner" on public.assistant_conversations for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create index if not exists idx_assistant_conversations_user_updated
  on public.assistant_conversations (user_id, updated_at desc);
-- updated_at maintenance (reviews #hardening 0010:284-286 pattern)
create trigger trg_assistant_conversations_updated_at
  before update on public.assistant_conversations
  for each row execute function public.update_updated_at();

create table if not exists public.assistant_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.assistant_conversations (id) on delete cascade,
  seq bigint generated always as identity,          -- global monotonic order key
  client_message_id uuid not null,                  -- idempotency: retry reuses it
  role text not null check (role in ('user','assistant','tool')),
  content text not null check (char_length(content) between 1 and 8000),
  tool_name text null,
  tool_args jsonb null,
  -- citations: [{kind: startup|assumption|evidence|decision|memory, id: uuid, label: text}]
  citations jsonb not null default '[]',
  created_at timestamptz not null default now(),
  unique (conversation_id, client_message_id)
);
alter table public.assistant_messages enable row level security;
drop policy if exists "assistant_messages_via_parent" on public.assistant_messages;
create policy "assistant_messages_via_parent" on public.assistant_messages for all to authenticated
  using (exists (select 1 from public.assistant_conversations c
                 where c.id = conversation_id and c.user_id = (select auth.uid())))
  with check (exists (select 1 from public.assistant_conversations c
                      where c.id = conversation_id and c.user_id = (select auth.uid())));
create index if not exists idx_assistant_messages_conv_order
  on public.assistant_messages (conversation_id, created_at, seq, id);

-- Per-conversation cap 200 enforced in route (COUNT check before insert → 409
-- CONVERSATION_FULL + "start a new chat" CTA). No trigger debt, tested explicitly.

create table if not exists public.assistant_quota (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  used_count integer not null default 0 check (used_count >= 0),
  primary key (user_id, day)
);
alter table public.assistant_quota enable row level security;
-- service-role only, zero public policies (trial_claims precedent, 0010:61-62).

create or replace function public.consume_assistant_message(p_user uuid, p_max integer)
returns table (allowed boolean, used integer, remaining integer)
language plpgsql security definer set search_path = '' as $$
declare v_used integer; v_day date := (now() at time zone 'utc')::date;
begin
  insert into public.assistant_quota (user_id, day, used_count)
  values (p_user, v_day, 0) on conflict (user_id, day) do nothing;
  select used_count into v_used from public.assistant_quota
   where user_id = p_user and day = v_day for update;
  if v_used >= p_max then return query select false, v_used, 0;
  else update public.assistant_quota set used_count = used_count + 1
    where user_id = p_user and day = v_day;
    return query select true, v_used + 1, p_max - (v_used + 1);
  end if;
end; $$;
revoke all on function public.consume_assistant_message(uuid, integer) from public;
grant execute on function public.consume_assistant_message(uuid, integer) to authenticated, service_role;

-- Refund: provider-total-outage before dispatch only. Never refunds delivered answers.
create or replace function public.refund_assistant_message(p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.assistant_quota set used_count = greatest(used_count - 1, 0)
   where user_id = p_user and day = (now() at time zone 'utc')::date;
end; $$;
revoke all on function public.refund_assistant_message(uuid) from public;
grant execute on function public.refund_assistant_message(uuid) to authenticated, service_role;

-- DB-backed float preference (D9: no localStorage-first debt)
create table if not exists public.assistant_prefs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  float_enabled boolean not null default false,
  active_conversation_id uuid null references public.assistant_conversations (id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.assistant_prefs enable row level security;
drop policy if exists "assistant_prefs_owner" on public.assistant_prefs;
create policy "assistant_prefs_owner" on public.assistant_prefs for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
```

Trace rows for chat tool calls: `actor='executor'`, `event_type in ('tool_call','tool_result')`
(literal `'executor/tool_call'` would violate `trace_events_event_type_check`, 0011:47-49 —
loop refutation applied). `startup_id`/`workspace_id` NULL when the action targets no
startup (columns nullable, 0000:171-182). No new event types, no CHECK edit.

## 5. API contracts

### POST /api/assistant (SSE, standalone contract — NOT "identical" to /api/agent)
- Request: `{ conversation_id?: string, client_message_id: uuid, message: string }`.
- Enforcement order §3. A `conversation_id` not owned by the caller → `403 FORBIDDEN`
  (uniform: no existence oracle). Missing id → server creates, returns id in `done`.
- Duplicate `(conversation_id, client_message_id)` → return the existing persisted exchange,
  consume NO additional quota (idempotent retry/double-submit).
- Stream events: `{type:"token", text}` · `{type:"tool", tool, args, result_summary}` ·
  `{type:"done", conversation_id, citations[]}` · `{type:"error", code, message, retryAfter?, trace?}`.
- Error codes: `UNAUTHENTICATED 401` · `TRIAL_CONSUMED|SUBSCRIPTION_REQUIRED|ACCOUNT_PAUSED 402 + plans_url`
  · `ASSISTANT_QUOTA_EXHAUSTED 402 + plans_url + Retry-After` · `RATE_LIMITED 429 + Retry-After`
  · `INVALID 400` · `CONVERSATION_FULL 409` · `FORBIDDEN 403` · `MODEL_UNAVAILABLE 503`.
- Pre-stream denials return JSON `{error, code, retryAfter?, plans_url?}` with matching
  `Retry-After` header (agent/route.ts:1877-1893, 1924-1933).

### GET /api/assistant/conversations?page=&limit=
- `{ conversations: [{id,title,updated_at,message_count}], meta:{page,limit,pages} }`
  (`message_count` via `COUNT(*) GROUP BY`, no counter column — loop decision).
  Owner-scoped, newest first.

### GET /api/assistant/conversations/:id/messages?before=&limit=50
- Windowed fetch (loop: §5 promised pagination §7 required — endpoint added).
  `{ messages: [...asc], meta:{...}, has_more }`. Cap note: threads hard-cap at 200.

### PATCH /api/assistant/conversations/:id `{title}`
- Owner-checked rename (1..200 chars). Title strategy: deterministic default = first user
  message truncated to 60 chars (zero AI cost); user/model rename via PATCH.

### DELETE /api/assistant/conversations/:id
- Hard cascade delete with confirm dialog (memories forget-confirm pattern). Explicitly NO
  soft-delete in v1 (decision, documented) — audit trail lives in `trace_events`.

### GET+PUT /api/assistant/prefs
- `{float_enabled, active_conversation_id}`. Single source `useAssistantFloatPref()`;
  cross-tab sync via `storage` event; messages always refetch on focus (server truth wins).

## 6. Assistant behavior (binding rules)

1. **Grounding first:** every reply about user data cites ≥1 row id; citations persisted in
   `citations` jsonb and rendered as clickable chips. Test: `citation-required`.
2. **Refuse, never invent:** no supporting rows → explicit refusal naming the gap.
   Test: `refusal-on-no-data`.
3. **Verifier-as-critic:** draft replies pass `findUnsupportedFactualClaims`
   (`apps/web/src/lib/utils.ts:266`, signature `(text, Array<{claim?, source_url?}>)`)
   over an adapter mapping cited rows → `{claim, source_url}`; flagged draft → refusal +
   trace row. The LLM never outranks the scan.
4. **Tool schemas (zod, strict):** run-validation `{idea 1..2000c, uploaded_data?}` ·
   save-memory `{kind enum(memoryKindSchema), value 1..500c, startup_id?}` → wraps
   `createManualMemory` (`dal.ts:234`, inline-approve semantics included) ·
   create/update-experiment `{startup_id, assumption_id?, type enum, design, status?}` +
   `{experiment_id, patch}` → via NEW shared `lib/experiments.ts` (`createExperiment`,
   `updateExperiment`, ownership-checked through startup→workspace) used by BOTH the agent
   route (refactor of inline insert `route.ts:2357-2365`, behavior-preserving) and chat ·
   navigate `{startup_id}` → card only, never a bare URL.
5. Tool failures → inline error card + retry of that tool (no extra message unit).
6. Bilingual (EN/AR) replies matching the user; glass-card visual language of `/validate`.
7. **Secret/PII sweep:** `containsBlockedSecret` + PII redaction applied to ALL chat persists
   (messages, tool_args, citations labels) and trace payloads — not just save-memory.
8. Every "never" in this spec maps to a named failing-first test (§10).

## 7. UI

- **Route `/assistant`** (add `"/assistant"` to `PROTECTED_ROUTES`, `middleware.ts:11`;
  matcher `middleware.ts:76` excludes `api/` — no matcher edit): two columns —
  conversation list (new/select/delete-with-confirm) + `<AssistantPanel/>`
  (log, citation chips, action cards, composer, stop, terminal-guard banner).
- **`<AssistantPanel conversationId?>`** — the single shared component for page + widget.
- **Floating widget:** opt-in toggle (DB-backed pref, D9). `AssistantFloatProvider` added in
  root `layout.tsx` (body is `relative z-10` with no provider today — verified) so state
  survives route changes; dock at `z-[60]` (headers/modals sit at `z-50` — verified in
  history:222/dashboard:255; widget above headers, future modals at `z-[70]`).
  Closed by default; storage-event cross-tab sync.
- **New components:** `CitationChip` + 4 tool `ActionCard`s (only `.cite-link` exists,
  `globals.css:211`; validate's AssumptionCard/EvidenceCard not reusable — verified).
  Reuse `.glass/.btn-glow/.shimmer` (`globals.css:75,115,108`); dark-only
  (`colorScheme:"dark"`, `layout.tsx:16-19`); empty-state copies history pattern
  (`history:503-520`); delete-confirm copies memories pattern (`memories-client:403-430`).
- **Message list:** client pagination (limit 50, `meta{page,limit,pages}` shape reused;
  no existing client pager — verified), streaming append reconciled by `(created_at, seq, id)`.
- **i18n:** add Arabic-capable font + one shared `dir` util (today: Inter/JetBrains only,
  ad-hoc `dir="rtl"` in 3 pages — verified gap, shipped in v1, memories copy precedent).
- **Composer:** stop button = `abortRef` pattern (`validate:523,660,688,817-830` copy);
  abort is client-side: unit already consumed at dispatch, server finishes best-effort,
  writer closes (documented, no refund — matches agent AbortError semantics).
- **Nav entries:** dashboard header + validate/history banners (no shared nav exists —
  `dashboard:333` verified; insert beside History/Memories links).

## 8. Security checklist (all blocking at merge)

- RLS on all 4 tables; service-role only for quota consume/refund (user-supplied SQL never).
- `sanitizeForPrompt` + `toUntrusted` on every user string entering a prompt; tool outputs
  rendered as untrusted plain text (D8: no HTML renderer, no innerHTML anywhere).
- Workspace isolation on every grounding query (`startups!inner` pattern).
- No keys in client; no new `NEXT_PUBLIC_*`; rate-limit fail-closed in prod.
- Uniform 403 on foreign `conversation_id` (no oracle).
- Secret/PII sweep (§6.7) incl. trace payloads.

## 9. Error-handling matrix

| Failure | Behavior | Quota |
|---|---|---|
| All AI providers down (detected pre-dispatch) | `MODEL_UNAVAILABLE` + retry | refunded (never dispatched) |
| Quota exhausted | 402 + plans CTA (`/plans?reason=assistant_quota` banner — anchor `#request-form` exists, `plans:98`; add searchParams reader) | n/a |
| Stream cut, no terminal event | terminal-guard banner + full-replay retry (no resume cursor in v1 — documented) | consumed once |
| Tool throws | inline error card + retry that tool | no extra unit |
| Message persist DB error | error banner + browser-only notice (validate `persistNotice` contract — same UX, cites component behavior already shipped in `f0f3835`) | consumed once |
| Abort by user | stream stops, partial text kept marked `stopped` | consumed once |
| Thread > 200 msgs | 409 + new-chat CTA | not consumed |

## 10. Testing & acceptance gates (blocking)

- **Unit (vitest, all new files under existing `src/**/__tests__/`):**
  `quota-atomic-parallel` (50 concurrent consumes, max never exceeded) ·
  `quota-refund-on-outage` · `rls-ownership` (B sees nothing of A) ·
  `foreign-conversation-403` · `citation-required` · `refusal-on-no-data` ·
  `tool-schema-rejections` · `idempotent-retry-same-client-id` ·
  `conversation-cap-409` · `seq-ordering-ties` · `float-pref-single-source` ·
  `experiments-shared-helper` (agent route behavior unchanged).
- **Assistant golden (NEW `eval/assistant/threads/at-001..005.json` + `eval/assistant/run.mjs`):**
  `{id, user_seed, turns: [{ask, must_cite?: [...], must_refuse?: string, tool?: {name, expect: {...}}}]}`.
  at-001 cited decision answer · at-002 refusal with gap named · at-003 save-memory → visible
  in memories · at-004 run-validation → real session card · at-005 quota-exhausted 402+plans.
  Pass bar: 5/5. Existing suites untouched and green.
- **Commands (all must pass):** `npm run typecheck` · `npm run test:ci` (zero failures) ·
  `eval/run-eval.js` 8/8 · `node --test eval/harness/meta.test.mjs` 18/18 ·
  `node eval/assistant/run.mjs` 5/5 · `npm run build` clean ·
  secrets scan empty · migration `20240101000015` applies on a fresh branch, history
  continuous `0000→0015`, fingerprint verify:
  `assistant_conversations RLS on` · 2 policies on messages-parent chain ·
  `consume_assistant_message` + `refund_assistant_message` executable ·
  `trace_events` CHECK unchanged.
- **e2e (extend `e2e/smoke.spec.ts`, unauth pattern kept):** `/assistant` → login redirect ·
  `POST /api/assistant` anon → 401 · widget toggle hidden when logged out.
- **Live (prod session):** new chat → cited answer → chips navigate → memory action in
  /memories → quota 402 on throttled test user → delete thread → gone.

## 11. Rollout (ordered, with rollback)

1. Branch-verify migration `20240101000015` → fingerprints (§10) → merge.
2. Set `ASSISTANT_DAILY_QUOTA` in Vercel (default 50 when absent) + `ASSISTANT_OPEN_CHAT`
   reserved (absent = grounded mode).
3. Deploy → smoke (§10 e2e) → live checklist (§10).
4. Admin visibility: read-only `getAssistantQuota(userId)` in `lib/admin-queries/users.ts`
   (D9 — `trial_claims` ops-blindness is NOT copied).
5. Rollback: forward-fix migration only (applied migrations are never edited); code revert
   leaves inert tables behind (documented, harmless).
6. Redis-outage runbook: chat 429s fail-closed like the agent — on-call alert on
   `RATE_LIMIT_UNAVAILABLE` spike; no silent degraded mode (explicit decision).

## 12. Future (C) — extension points, not work

- `ASSISTANT_OPEN_CHAT` env + general-system-prompt variant; tools/grounding/quota untouched.
- Optional later specs: per-conversation model picker, voice input, share links, SSE resume
  cursors, soft-delete/export.
