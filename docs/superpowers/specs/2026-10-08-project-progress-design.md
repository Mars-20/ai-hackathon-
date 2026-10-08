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

- `startups.stage` (existing free-text column) stays the current stage.
  No breakage: existing `idea/prototype/live/scaling` rows keep working.
- `startups.stage_track` (new, nullable TEXT): template key — `general`
  (default; the legacy four stages, backward compatible), `saas_tech`,
  `local_service`, `consumer_product`, or `custom`. NULL means `general`.
- `startups.stage_order` (new, nullable JSONB): only when customized —
  ordered array of `{key, label_ar, label_en}`. NULL means "use the template
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

- **R1 — Go decision:** the latest approved `Go` decision closing the current
  stage's gate → suggest the next stage, citing the decision (`[D#]`).
- **R2 — evidence threshold:** approved-evidence count ≥ the current stage's
  threshold (thresholds are part of the template definition) → suggest the
  next stage, citing the evidence (`[E#]`).
- R1 takes precedence over R2. Never suggest backward; never suggest past
  the final stage.
- A dismissed (`from → to`) pair is suppressed unless newer supporting data
  appeared after the dismissal (a later `Go` or a threshold newly exceeded).
- Every suggestion carries `reason` + clickable references — no advancement
  without visible evidence (platform philosophy).
- Rules are data, not branching code: each rule is a testable row; changing
  a threshold changes a number, not logic.

## 5. API (owner-only via RLS, same contracts as the assistant APIs)

- Project reads extend the current shape with
  `track, order, progress, suggestion` (no new read endpoint).
- `PUT /api/startups/[id]/stage` with `{to, confirmed_suggestion_id?}` —
  writes the stage + a history row.
- `POST /api/startups/[id]/stage/dismiss` with `{to}` — records rejection.
- Any `to` outside the project's track order → `400 INVALID`
  (no skipping, no hidden regression).

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
  with citations. Existing golden threads stay green (additive field).
- New golden thread: asking about project progress yields a cited answer.

## 8. Testing

- Unit matrix for the rules (every combination: Go/threshold/dismissed/final).
- Migration test: RLS owner-scoping on the two new tables.
- Full e2e journey: suggestion → confirm → new stage in the stepper →
  dismiss a later suggestion.
- Golden assistant thread for progress questions.

## 9. Explicitly out of scope

Advancing stages from inside the assistant, notifications, periodic progress
reports.
