# Project Progress Design (2026-10-08)

## 1. Intent

The user sees a raw project status today (`idea`, test leftovers) and wants
visible project progress: a journey from idea through prototype to a full
offering — for ANY startup kind, not just SaaS/tech (the SaaS example was
illustrative only; a restaurant or local service must fit equally well).

Approved approach: multiple track templates (no SaaS presumption) + per-project
custom tracks + visual progress + hybrid advancement (system suggests from
validation decisions and evidence thresholds; the user confirms or rejects).

## 2. Data model

- `startups.stage` is `TEXT NOT NULL DEFAULT 'idea'` **with a DB CHECK
  constraint limited to the four legacy values** (`0000_schema_unified`,
  line ~64) — it is NOT free text. Migration 0016 drops that CHECK (keeping
  NOT NULL + default); stage validity moves to the API layer, validated
  against the project's own track order. Existing
  `idea/prototype/live/scaling` rows keep working unchanged.
- `startups.stage_track` (new, nullable TEXT): template key — `general`
  (default; the legacy four stages, backward compatible), `saas_tech`,
  `local_service`, `consumer_product`, or `custom`. NULL means `general`.
- `startups.stage_order` (new, nullable JSONB): only when customized —
  ordered array of `{key, label}` (`key` = stable English snake_case,
  `label` = display text in the author's language; no `_ar`/`_en` split —
  the codebase has no i18n precedent). NULL means "use the template
  order from versioned code constants".
- New table `startup_stage_history`: every transition
  (`startup_id, from_stage, to_stage, actor[user|suggestion], reason,
  supporting_refs JSONB, created_at`). Owner-scoped RLS like sibling tables.
- New table `stage_suggestion_dismissals`: rejected (`from → to`) pairs with
  timestamps so a rejected suggestion is not re-proposed.
- Track templates live as versioned code constants: editing a template adds a
  new version and never mutates the old one, so existing projects never shift
  under their owners.

## 3. Built-in track templates (v1)

- `general`: idea → prototype → live → scaling (legacy-compatible default).
- `saas_tech`: idea → validation → prototype → beta → launch → growth.
- `local_service`: idea → validation → pilot → opening → expansion.
- `consumer_product`: idea → validation → prototype → production → retail.
- Every template carries per-stage evidence thresholds (see §4).
- Track is chosen at project creation or in project settings; default is
  `general`. Any template can be customized per project (reorder/rename
  stages, or build from scratch → becomes `custom`).

## 4. Suggestion rules (deterministic, computed on read — no background jobs)

Pure function `suggestNextStage(project, decisions, evidenceCounts, track)`
returns one suggestion or null:

- **R1 — Go decision:** the latest row (by `created_at`) with
  `verdict='go'` for this startup. Note: `decisions` has NO approved/status
  column, so "approved" is meaningless here — the verdict row itself IS the
  decision (written by the agent/admin flows). Any confidence qualifies.
  The suggestion cites the decision (`[D#]`).
- **R2 — evidence threshold:** count of evidence rows for this startup with
  `strength IN ('contact_shared','commitment')` (commitment-ladder rung 4+,
  the platform's own bar for a `Go` — see landing page). The `evidence`
  table has NO approved/status column, so rung-4+ IS the definition of
  "countable" evidence. Suggestion cites the evidence (`[E#]`).
- R1 takes precedence over R2. Never suggest backward; never suggest past
  the final stage.
- A dismissed (`from → to`) pair is suppressed unless newer supporting data
  appeared after the dismissal (a later `Go` or a threshold newly exceeded).
- Every suggestion carries `reason` + clickable references — no advancement
  without visible evidence (platform philosophy).
- Rules are data, not branching code: each rule is a testable row; changing
  a threshold changes a number, not logic.

## 5. API (workspace-scoped RLS like sibling tables — members read, writes
by role — same contracts as the assistant APIs)

- Project reads extend the current shape with
  `track, order, progress, suggestion` (no new read endpoint). Dashboard
  already `select("*")`, so new columns flow free; the assistant's
  `ownedStartupRows` uses an explicit column list and MUST add
  `stage_track,stage_order` there.
- `PUT /api/startups/[id]/stage` with `{to}` — writes the stage + a history
  row. The server recomputes the live suggestion at confirm time and stores
  its basis (decision/evidence refs) in the history row; if no live
  suggestion targets that `to`, basis is null and actor is `user`. (There
  are no stored suggestion rows — suggestions are computed — so the client
  never sends an id. Never trust client-supplied refs.)
- `POST /api/startups/[id]/stage/dismiss` with `{to}` — records rejection.
- Any `to` outside the project's track order → `400 INVALID`
  (no skipping, no hidden regression).
- Enum widening (required — hardcoded 4-value enums reject custom keys):
  `startupSaveSchema.stage`, `historyStageSchema`, the agent-route stage
  enum, and `types.ts Stage` become track-aware: free string validated
  server-side against the target project's track order (`400 INVALID`
  otherwise). The history-page stage filter derives its options from data,
  not from a hardcoded list. Save route additionally accepts optional
  `track` (known template key, default `general`) at creation.

## 6. UI

- Dashboard project card: stage stepper (dots + Arabic labels, current
  highlighted, completed ✓) replacing the raw text chip; renders any custom
  track automatically.
- Validate page: larger stepper + suggestion card (reason + evidence +
  [advance] [not now]).
- Track selection/customization lives in project settings (template list +
  simple order/label editor). Nothing is forced at creation.

## 7. Assistant compatibility

- The grounding line keeps `[startup:id]` stable and appends progress
  position (`stage 2/5`), so the assistant can answer "where is my project?"
  with citations. Existing golden threads stay green (additive field; no
  `stage` references exist in `eval/` today).
- **Critic-trap constraint (hard requirement):** progress answers are
  inherently numeric ("stage 2 of 5", "3 supporting evidences") and the
  critic blocks bare digits without URL support — the exact bug class of the
  2026-10-07 marker block (`07d777e`). The plan MUST include a critic
  exemption for `[S#]`-backed structural position statements, with a
  dedicated unit test (marker-style RED first) AND the new golden thread,
  or the progress Q&A will refuse exactly like the marker bug did.
- New golden thread: asking about project progress yields a cited answer.

## 8. Testing

- Unit matrix for the rules (every combination: Go/threshold/dismissed/final).
- Migration test: 0016 drops the stage CHECK (custom stage writes succeed),
  RLS owner/member-scoping on the two new tables.
- Zod-widening tests: custom keys pass save/history/agent validation when
  in-track, rejected when out-of-track.
- Critic-exemption test (RED-first): `[S#]`-backed position statements pass.
- Full e2e journey: suggestion → confirm → new stage in the stepper →
  dismiss a later suggestion.
- Golden assistant thread for progress questions.

## 9. Explicitly out of scope

Advancing stages from inside the assistant, notifications, periodic progress
reports.
