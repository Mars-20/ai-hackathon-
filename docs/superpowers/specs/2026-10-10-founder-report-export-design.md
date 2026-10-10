# Sub-project A — Founder Report & Personal Export (spec)

Date: 2026-10-10. Path: architectural (sub-project of the reports/export/results system).
Status: design approved per-section in chat. Next: writing-plans skill, then TDD implementation.

## 0. Scope position

The reports/export/results request decomposed into three independent sub-projects,
each with its own spec → plan → implementation cycle:

- **A (this spec):** founder report + personal export. First.
- **B (later):** external sharing — revocable time-limited share links, login-free
  investor read-only view, explicit expose/hide policy (costs + trace never shared).
- **C (later):** team collaboration on reports — viewer/editor roles inside the
  existing `workspaces` / `workspace_members` structure.

## 1. Objective

A per-startup consolidated report page for the founder (all four approved sections)
plus two personal export formats: print/PDF via print stylesheet, and a detailed
server-generated CSV. Builds on existing validate-dashboard display and history CSV.
No new tables, no migration, no new dependencies.

## 2. Non-negotiables (from spec v2.3 + repo conventions)

- RLS/ownership on every read: same membership checks as `agent-workspace.ts`;
  foreign ids → 404 page / `FORBIDDEN`+`NOT_FOUND` JSON, never leak existence.
- ar/en via next-intl `reports.*` namespace (no-hardcoded-strings guard applies).
- Read-only L0: no quota consumption, no model calls, no new generated prose —
  the report renders stored, already-verified data only, so no Verifier pass needed.
- TDD RED→GREEN, DRY/YAGNI, battery + tsc + build green before commit.

## 3. Components

1. `app/[locale]/reports/[startupId]/page.tsx` — server component.
   Gate: login redirect (validate-page pattern) → ownership check → 404 otherwise.
   Parallel reads of the six sources (startup, assumptions, evidence, experiments,
   latest decision, scorecard) — reusing the validate dashboard's server queries.
2. Section order: header (name/domain/stage/date) → decision memo + verdict →
   assumptions + evidence (with source URLs) → experiments + results →
   investor scorecard → footer (generated-at timestamp + verifier status:
   approved vs flagged count).
3. Print: dedicated print stylesheet (hide nav/buttons, light theme, page-break
   rules between sections) + one button calling `window.print()`. Browser saves PDF.
4. `GET /api/reports/[startupId]/export?format=csv` — thin route, same auth +
   ownership gate. RFC-4180 quoting (the history-page `join(",")` naive CSV is the
   negative precedent), UTF-8 BOM for Arabic Excel, filename `report-<shortid>.csv`.
5. CSV shape: section-tagged rows (`section,item,field,value`): header block →
   decision → assumptions → evidence (with source URLs) → experiments → scorecard.
   Opens directly in Excel/Sheets with correct Arabic.
6. Entry points: link from validate results + history per-row. i18n keys `reports.*`
   in `messages/en.json` + `messages/ar.json`.

## 4. Data flow & errors

Request → auth → ownership → parallel DAL reads → render. CSV route: same gate →
shape rows → `text/csv` + BOM. Transport failures → generic error page / 500 JSON
without internals. Empty states: the report always renders what exists; no memo yet
→ verdict section shows a "no decision yet" state pointing back to validation, other
sections render if present. Never an empty page.

## 5. Testing & acceptance

- RED first: CSV shaping (commas/newlines/URLs/BOM, ar/en columns), gates
  (stranger → 403/404, visitor → 401/redirect), empty states (no memo → graceful).
- Gates: full battery green, `tsc --noEmit` clean, `npm run build` success.
- Manual acceptance: open from validate + history; clean ar/en print/PDF (no chrome,
  sane page breaks); CSV opens in Excel with correct Arabic.

## 6. Explicitly out of scope

Share links (B), team roles on reports (C), a PDF library (browser print suffices),
new tables/migrations, per-section selective export, scheduled emailed reports.
