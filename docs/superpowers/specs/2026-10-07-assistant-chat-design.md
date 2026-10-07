# Assistant Chat — Design Spec (approved)

- **Date:** 2026-10-07
- **Status:** APPROVED by product owner (all 3 sections signed off in chat)
- **Path:** architectural (new subsystem; no existing chat flow in repo)
- **Approach:** Approach 1 — conversation layer over existing, tested infrastructure
- **Scope:** v1 = grounded Q&A (A) + 4 tool actions (B). Foundation must admit open chat (C) later with no rework. Zero tech debt: nothing deferred, no TODOs in shipped code.

## 1. Outcome & success criteria

A logged-in user opens a standalone **Assistant page** (`/assistant`), holds a persistent multi-turn conversation grounded exclusively in their own data (startups, assumptions, evidence, experiments, decisions, companion memories), invokes 4 actions from chat, and can optionally pop the same conversation into a **floating window** on any page.

Success = all acceptance gates in §11 pass; a user question about their own decision returns a cited answer; a question with no supporting data returns an explicit refusal (never a fabrication); quota, RLS, and error behavior verified by tests, not by inspection.

## 2. Approved decisions (binding)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | v1 = A (grounded Q&A) + B (actions 1–4), architected for C later | Blast radius zero now; open chat later = prompt/config change only |
| D2 | All 4 actions ship in v1 (run validation, save memory, create/edit experiment, smart navigation). Nothing deferred | Owner: no tech debt |
| D3 | Independent daily chat quota (default 50 msgs/day, env `ASSISTANT_DAILY_QUOTA`), never touches validation quota | A long chat must never eat validation capacity |
| D4 | Approach 1: reuse entitlements, compiled memory context, AI-with-fallback caller, sanitizers, verifier-as-critic | Every sensitive layer already tested; only conversation storage + quota + 4 tool wrappers + UI are new |
| D5 | Standalone `/assistant` page + opt-in floating widget sharing one `AssistantPanel` component and one API | No duplicated logic between page and widget |
| D6 | Atomic quota consumption (`consume_assistant_message`, `consume_trial` pattern). One message = one unit, consumed before the AI call | No double-spend via retries; technical failures before consumption cost nothing |

## 3. Architecture

```
Browser (/assistant page | floating widget → same <AssistantPanel/>)
  │  SSE (token/done/error — same protocol as /api/agent)
  ▼
POST /api/assistant { conversation_id?, message }
  ├─ 1. auth (middleware + route pre-flight, 401 UNAUTHENTICATED anon)
  ├─ 2. entitlement gate (TRIAL_CONSUMED / ACCOUNT_PAUSED refuse — same codes as agent)
  ├─ 3. quota gate consume_assistant_message() — fail-closed (429 ASSISTANT_QUOTA_EXHAUSTED + plans_url)
  ├─ 4. rate limit (shared lib/rate-limit Lua, in-memory fallback dev only)
  ├─ 5. grounding fetch (workspace-scoped: startups, assumptions, evidence,
  │     experiments, decisions + getCompiledContext(user) + last 20 messages)
  ├─ 6. model call with 4 tools (callAIWithFallback — Gemini primary, Groq fallback)
  ├─ 7. verifier-as-critic rescan of the draft reply (unsupported factual line → block + refuse)
  └─ 8. persist user msg + assistant reply (+ tool traces) → stream done
```

Tool execution (server-side only): each tool thinly wraps the existing flow —
run-validation calls the same entry as `/api/agent`; save-memory calls the same
propose path behind `/memories`; create-experiment calls the existing experiment
creator; navigate resolves a real `startup_id` and returns a card (never a bare URL).

Upgrade path to (C): add `ASSISTANT_OPEN_CHAT=true` + a general system prompt variant;
tools and grounding stay untouched. No schema or route changes required.

## 4. Data model (single new migration)

```sql
-- assistant_conversations: one row per user thread
create table assistant_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'New conversation',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table assistant_conversations enable row level security;
create policy assistant_conversations_owner
  on assistant_conversations for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index idx_assistant_conversations_user_updated
  on assistant_conversations (user_id, updated_at desc);

-- assistant_messages: roles user | assistant | tool
create table assistant_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references assistant_conversations (id) on delete cascade,
  role text not null check (role in ('user','assistant','tool')),
  content text not null,
  tool_name text null,
  tool_args jsonb null,
  citations jsonb null,            -- [{type,startup_id,assumption_id,evidence_id,memory_id,label}]
  created_at timestamptz not null default now()
);
alter table assistant_messages enable row level security;
create policy assistant_messages_via_parent
  on assistant_messages for all
  using (exists (select 1 from assistant_conversations c
                 where c.id = conversation_id and c.user_id = auth.uid()))
  with check (exists (select 1 from assistant_conversations c
                     where c.id = conversation_id and c.user_id = auth.uid()));
create index idx_assistant_messages_conv_created
  on assistant_messages (conversation_id, created_at);

-- assistant_quota: independent daily counter
create table assistant_quota (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null default (now() at time zone 'utc')::date,
  used_count integer not null default 0,
  primary key (user_id, day)
);
alter table assistant_quota enable row level security;
-- service-role only: no public policies (route uses admin client, same as trial_claims)

-- atomic consume (same contract style as consume_trial)
create or replace function consume_assistant_message(p_user uuid, p_max integer)
returns table (allowed boolean, used integer, remaining integer)
language plpgsql security definer set search_path = public as $$
declare v_used integer; v_day date := (now() at time zone 'utc')::date;
begin
  insert into assistant_quota (user_id, day, used_count)
  values (p_user, v_day, 0)
  on conflict (user_id, day) do nothing;
  select used_count into v_used from assistant_quota
   where user_id = p_user and day = v_day for update;
  if v_used >= p_max then
    return query select false, v_used, 0;
  else
    update assistant_quota set used_count = used_count + 1
     where user_id = p_user and day = v_day;
    return query select true, v_used + 1, p_max - (v_used + 1);
  end if;
end; $$;
```

Conventions (repo-mandated, zero-debt): migration filename `supabase/migrations/YYYYMMDDHHMMSS_assistant_chat.sql`;
companion `trace_events` rows use existing 10-type check — chat tool calls log as
`executor/tool_call` + `executor/tool_result` (no new event types, no check-constraint edit).

## 5. API contracts

### POST /api/assistant (SSE)
- Request: `{ conversation_id?: string, message: string (1..4000 chars) }`.
- Order of enforcement: auth → entitlement → quota → rate-limit → validation → model.
- Stream events (identical envelope to `/api/agent`):
  - `{type:"token", text}` incremental deltas
  - `{type:"tool", tool, args, result_summary}` per executed action (auditable in client trace)
  - `{type:"done", conversation_id, citations[]}` terminal success
  - `{type:"error", code, message}` terminal failure (codes below)
- Error codes: `UNAUTHENTICATED 401`, `TRIAL_CONSUMED 402`, `ACCOUNT_PAUSED 402`,
  `ASSISTANT_QUOTA_EXHAUSTED 429 (+ Retry-After, plans_url)`,
  `RATE_LIMITED 429`, `INVALID 400`, `MODEL_UNAVAILABLE 503`, `FORBIDDEN 403`
  (cross-user conversation_id).
- A `conversation_id` not owned by the caller → `403 FORBIDDEN` (never 404-oracle the existence).
- Missing `conversation_id` creates the conversation server-side and returns its id in `done`.

### GET /api/assistant/conversations?page=&limit=
- `{ conversations: [{id,title,updated_at,message_count}], meta:{page,limit,pages} }`, owner-scoped, newest first.

### DELETE /api/assistant/conversations/:id
- Owner-checked delete (cascade wipes messages). Returns `{deleted:true}`.

## 6. Assistant behavior (binding rules)

1. **Grounding first:** every reply about user data must cite ≥1 row id (startup/assumption/evidence/decision/memory); citations persisted in `citations` jsonb and rendered as clickable chips.
2. **Refuse, never invent:** question with no supporting rows → explicit refusal naming what is missing
   ("No evidence rows mention pricing for Flowboard yet — run 5 discovery interviews first").
3. **Verifier-as-critic:** draft replies pass the deterministic unsupported-claim scan
   (`findUnsupportedFactualClaims`-equivalent over cited rows); a flagged draft is replaced by a refusal + trace row. The LLM never outranks the scan.
4. **Tool schemas are strict** (zod): run-validation `{idea(≤2000c), uploaded_data?}`, save-memory
   `{kind enum, value(≤500c), startup_id?}`, create-experiment `{startup_id, hypothesis(assumption_id?), method enum}`, navigate `{startup_id}` → card only.
5. Tool failures are reported inline as cards with retry; a failed tool never fabricates its result.
6. Bilingual (EN/AR) replies matching the user's language; same glass-card visual language as `/validate`.

## 7. UI

- **Route `/assistant`** (middleware-protected like `/history`): two-column layout —
  conversation list (new/select/delete with confirm) + `<AssistantPanel/>`
  (message log, citation chips, action cards, composer, stop button, terminal-guard banner).
- **`<AssistantPanel conversationId?>`** is the single shared component; page and widget both render it. No forked logic.
- **Floating widget:** opt-in toggle in settings (`useAssistantFloatPref()` — single source;
  localStorage now, DB-backed later without touching consumers). Closed by default.
  Renders the active conversation in a docked panel above all routes; same SSE stream; closes on navigation only if user closes it (state survives route changes via React context, not remount).
- **States:** empty (suggested prompts grounded in user's startups), streaming (stop allowed),
  quota-exhausted (plans CTA), offline/error (retry; never silent), deleted-conversation (redirect to new).
- **A11y/perf:** focus trap in widget, `aria-live` for streamed text, list virtualization not needed
  (paginate messages at 50), no new global CSS (reuse glass tokens).

## 8. Security checklist (must all hold at merge)

- RLS on all 3 tables; service-role used only for quota consume (never with user-supplied SQL).
- `sanitizeForPrompt` + `toUntrusted` on every user string entering a prompt; tool outputs rendered as untrusted text.
- `containsBlockedSecret` scan on save-memory values (same as companion memories).
- Workspace isolation on every grounding query (same `startups!inner` pattern as `/api/search`).
- No keys in client; no `NEXT_PUBLIC_` additions; rate-limit fail-closed in prod, in-memory fallback dev/test only.
- Cross-user `conversation_id` probing returns uniform 403 (no existence oracle).

## 9. Error-handling matrix

| Failure | Behavior | Quota |
|---|---|---|
| All AI providers down | `MODEL_UNAVAILABLE`, retry button | not consumed (failure precedes consume) |
| Quota exhausted | 429 + plans CTA | n/a |
| Stream cut, no terminal event | terminal-guard banner + retry | consumed once (single unit) |
| Tool throws | inline error card + retry that tool | tool re-run consumes no extra message unit |
| Save-message DB error | error banner, stream already carried the answer; client keeps local copy + "browser-only" notice (same pattern as validate persistNotice) | consumed once |
| Delete conversation | confirm dialog; on success route to new chat | n/a |

## 10. Testing & acceptance gates (blocking)

- **Unit (vitest):** quota atomicity (parallel consumes never exceed max), RLS ownership
  (user B reads nothing of user A), 403-on-foreign-conversation_id, citation-required enforcement,
  refusal-on-no-data, tool schema rejections, float-pref single-source.
- **Golden:** scripted threads — (a) "why was Flowboard Test More?" → cites decision+evidence;
  (b) "what is our pricing evidence?" with none → refusal naming the gap;
  (c) "remember my market is restaurants" → propose-memory card → appears in /memories;
  (d) "run validation for X" → run card links a real session; (e) quota exhausted → 429+plans.
- **Commands (all must pass):** `npm run typecheck`, `npm run test:ci` (zero failures),
  golden file `8+/8+` (extend, never weaken existing), `node --test eval/harness/meta.test.mjs 18/18`,
  `npm run build` clean, secrets scan (`sbp_|sk-|eyJhbGci`) empty, migration applies on a fresh branch with zero drift.
- **Live (staging/prod session):** create chat → ask about own startup → citations clickable →
  run-memory action → visible in /memories → exhaust quota on test user → 429+plans → delete thread → gone.

## 11. Rollout

1. Migration applied via Management API + fingerprint verify (tables/policies/RPC), history continuity check.
2. Deploy; verify `/assistant` renders, widget toggle persists, quota default 50 enforced.
3. Update nav (an "Assistant" entry next to History/Validate) — no other route changes.
4. No changes to `/api/agent`, trial ledger, or existing RLS.

## 12. Future (C) — extension points, not work

- `ASSISTANT_OPEN_CHAT` env + general-system-prompt variant; tools/grounding/quota untouched.
- Optional: per-conversation model selector, voice input, share links (each needs its own spec).
