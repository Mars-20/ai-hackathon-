# Sub-project A — Founder Report & Personal Export (spec)

Date: 2026-10-10. Path: architectural (sub-project of the reports/export/results system).
Status: design approved per-section in chat, then passed through an adversarial
review loop against the repo (2026-10-10): 3 blockers found and fixed, 7 points
pinned. Next: writing-plans skill, then TDD implementation.

## 0. Scope position

The reports/export/results request decomposed into three independent sub-projects,
each with its own spec → plan → implementation cycle:

- **A (this spec):** founder report + personal export. First.
- **B (later):** external sharing — revocable time-limited share links, login-free
  investor read-only view, explicit expose/hide policy (costs + trace never shared).
- **C (later):** team collaboration on reports — viewer/editor roles inside the
  existing `workspaces` / `workspace_members` structure.

## 1. Objective

A per-startup consolidated report page for the founder (four approved sections:
decision memo + assumptions/evidence + experiments/results + investor scorecard)
plus two personal export formats: print/PDF via print stylesheet, and a detailed
server-generated CSV. Exactly one migration (`decisions.scorecard`, because the
scorecard is currently SSE-ephemeral — see §3.2). No new tables, no new dependencies.

## 2. Non-negotiables (from spec v2.3 + repo conventions)

- Gate mirrors `/api/history` exactly: auth + workspace membership, no entitlement
  check. Foreign/missing id → 404 page / 404 `NOT_FOUND` JSON (history detail
  convention, `history/route.ts:135-137`) — never 403, never leak existence.
- Verdict enum is four-valued: `go | iterate | stop | test_more`
  (`history/route.ts:8`). The report never invents verdict labels.
- ar/en via next-intl `reports.*` namespace (no-hardcoded-strings guard applies).
- Report reads are L0: no quota consumption, no model calls, no new generated prose.
  Stored scorecards render as stored (produced by skill:investor-readiness under its
  own rules) — no re-validation, no Verifier pass.
- TDD RED→GREEN, DRY/YAGNI, battery + tsc + build green before commit.

## 3. Components

1. `app/[locale]/reports/[startupId]/page.tsx` — server component. Gate: login
   redirect (`redirect(withLocale("/login", appLocale))`, precedent
   `memories/page.tsx:70`) → workspace-membership ownership check → 404 otherwise.
   Data: the page performs the detail read server-side with the session client,
   mirroring `/api/history?startup_id=` detail mode — workspace `.in()` scoping +
   the three-generation ladder fallback (`history/route.ts:87-139`). There are no
   "validate dashboard server queries" to reuse: the dashboard is `"use client"`
   (`validate/page.tsx:1`) and fetches that same endpoint (`validate/page.tsx:673).
2. Scorecard persistence (approved scope addition — the scorecard is SSE-only today:
   computed at `agent/route.ts:2583`, emitted at `2602`/`2747`, never stored):
   - Migration `supabase/migrations/20261010_decisions_scorecard.sql`:
     `alter table decisions add column scorecard jsonb null`. No backfill possible
     (ephemeral source); old rows stay null. This is a deliberate exception to the
     "Runtime/SSE only — not a decisions-table column" precedent (`types.ts:177-178`).
   - Agent `decisions` insert (`agent/route.ts:2673`) gains
     `scorecard: investorScorecard ?? null`, best-effort — never fail the stream
     (same persist_warning pattern as the surrounding block).
   - `Decision` type + history detail select gain the nullable `scorecard` field.
   - Staleness rule: the report shows the scorecard of the **latest decision with a
     non-null scorecard**, labeled with that decision's date. Scorecards are computed
     for Go/Iterate verdicts only (`agent/route.ts:1847-1850`); otherwise the section
     shows the "no scored run yet" empty state.
3. Report presentational components: new file (e.g. `reports/ReportSections.tsx`).
   The validate page's `EvidenceCard` (`validate/page.tsx:249`), `DecisionMemoPanel`
   (`544`) and `InvestorScorecardCard` (`492`) are local functions inside a client
   page module — they cannot be imported; the plan builds report-owned components.
4. Section order: header (name/domain/stage/date) → decision memo + verdict →
   assumptions + evidence (with source URLs) → experiments + results →
   investor scorecard → footer (generated-at timestamp + evidence grounding summary
   computed from persisted `grounding_status`/`quarantined_at` rows; run verifier
   stats are SSE-only and are explicitly excluded from the footer).
5. Print: greenfield print stylesheet — zero `@media print` precedent exists in the
   repo. Hide nav/buttons, light theme, page-break rules between sections, mandatory
   RTL print check. One button calling `window.print()`; the browser saves PDF.
6. `GET /api/reports/[startupId]/export?format=csv` — thin route, same auth +
   ownership gate. Shared `lib/csv.ts` extracted from the admin precedent: move
   `csvEscape` out of `admin/analytics/experiments/route.ts:40-46` (DRY) and reuse
   its `content-disposition: attachment` pattern. Two deliberate divergences from the
   admin CSV: UTF-8 BOM (Arabic Excel requires it) and localized values following
   the history-page precedent (`history/page.tsx:232-246`), while headers stay
   stable English (machine-readable). Filename `report-<first-8-of-startup-id>.csv`.
   (The history-page `join(",")` naive CSV is the negative precedent.)
7. CSV shape: section-tagged rows (`section,item,field,value`): header block →
   decision → assumptions → evidence (with source URLs) → experiments → scorecard
   (omitted block when null). Opens directly in Excel/Sheets with correct Arabic.
8. Entry points: link from validate results + history per-row. i18n keys `reports.*`
   in `messages/en.json` + `messages/ar.json`.

## 4. Data flow & errors

Write path (run time): agent computes scorecard → decisions insert incl. scorecard
(best-effort). Read path: request → auth → ownership → parallel server-side reads
→ render. CSV route: same gate → shape rows → `text/csv; charset=utf-8` + BOM.
Transport failures → generic error page / 500 JSON without internals. Empty states:
the report always renders what exists; no memo yet → verdict section shows "no
decision yet" pointing back to validation; no scored run → scorecard empty state
(§3.2). Never an empty page.

## 5. Testing & acceptance

- RED first: CSV shaping (commas/newlines/URLs/BOM, localized values, stable
  headers); gates (stranger → 404, visitor → 401/redirect, invalid format → 400);
  scorecard persist (stored when present / null when skipped-or-failed / stream
  never breaks); report shows latest non-null scorecard with its date label;
  empty states (no memo, no scored run) render gracefully.
- Gates: full battery green, `tsc --noEmit` clean, `npm run build` success.
- Manual acceptance: open from validate + history; clean ar/en print/PDF (no chrome,
  sane page breaks, RTL correct); CSV opens in Excel with correct Arabic.

## 6. Explicitly out of scope

Share links (B), team roles on reports (C), a PDF library (browser print suffices),
any further tables/migrations beyond `decisions.scorecard`, per-section selective
export, scheduled emailed reports.
