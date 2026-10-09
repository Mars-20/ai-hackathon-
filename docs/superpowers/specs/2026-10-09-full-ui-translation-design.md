# Design: full UI translation coverage + LanguageSwitcher redesign

- Date: 2026-10-09. Branch: `feat/full-ui-translation` (base: `12ddaf8`).
- Authority: user-approved in-chat design (4 sections) on 2026-10-09; this file is the binding spec.
- Prior art: `docs/superpowers/specs/2026-10-08-i18n-translation-design.md` (locale routing, cookie, AI/email locale, RTL shell). Nothing here changes routing, middleware, cookie semantics, or `HtmlLocaleSync`.

## 1. Problem

- `LanguageSwitcher` (`apps/web/src/components/LanguageSwitcher.tsx`) is a functional placeholder: two unstyled buttons, no active-locale indication, no tooltip, breaks header rhythm.
- Translation coverage is 8 keys (`common.*`, `nav.*`) against ~700 hardcoded user-facing literals across ~50 source files (audit-based estimate, Oct 2026; <5% of visible UI). Everything outside `nav.*` ignores the locale switch. AR-only islands (assistant, plans, dashboard paywall) have no EN mirror; EN-only surfaces (landing, validate, admin, invite) have no AR mirror.

## 2. Scope

In scope: redesign of `LanguageSwitcher`; new `ar`+`en` message namespaces and `useTranslations` (client components) / `getTranslations` (server components) wiring for landing, login, dashboard, validate, history, assistant, plans, request-form, memories, invite, admin console (8 pages), shared components; parity + no-mixed-language tests. In-scope string classes in every touched file: rendered text, placeholders, aria-labels, `title`/tooltips, empty states, toasts, browser dialogs, and route-level metadata titles/descriptions of touched pages. Browser dialogs consume translated strings as arguments (client components): `dashboard.dialogs.*` (workspace-name `prompt`, membership `alert`) and `admin.dialogs.* (revoke `confirm`).
Out of scope: locale routing/middleware/cookie behavior; AI prompt wording and full email templates (assistant refusals + email subjects are locale-aware today; template localization is a separate phase); translating machine-English field tokens and CSV export headers (machine-readable — stay English in both locales); server API error bodies (stay as-is); root-shell `<title>`; changing any runtime behavior besides rendered language, except the two allowlisted touches in §8.

## 3. Phased delivery (each phase merges independently)

Prerequisite P0 (before Phase 2): fix root font wiring — `app/layout.tsx` sets `--font-en/--font-ar` vars that `globals.css` never reads (`body` pins a latin-only stack), so full-Arabic surfaces would render in fallback. Outcome mandated: Arabic glyphs render in the designed font and latin numerals/code keep mono; verified via `next build` + visual check. Phase 1 (switcher) is unaffected and may proceed in parallel.
- Phase 1 — Switcher: redesign + wire to existing `common.switchToArabic`/`common.switchToEnglish` keys (currently hardcoded, unused); three small new keys name the rest (`common.switchLanguage` group aria-label, `common.arabicShort`/`common.englishShort` pill segments — native abbreviations, no exemptions needed). The `title` tooltip reuses the label keys. No behavior change (same cookie + same-page `router.replace`, R11 cookie semantics preserved — see §4). Behavioral proof (query/hash-preserving switch) is owned by the existing CI Playwright switch spec; phase gate is tsc + vitest + build.
- Phase 2 — User surfaces: landing → login → dashboard → validate → history, plus `StageProgressSection`/`StageStepper` (validate-owned). Builds `shared.*` incrementally (append-only; per-phase parity still passes).
- Phase 3 — Assistant & plans: assistant panel/view, `AssistantFloatProvider` (assistant-owned), plans page, request-form, memories (client-rendered `MEMORY_COPY` gains EN mirror resolved in components; memories paywall EN strings keyed here; server error bodies unchanged), invite flow (`invite/[token]/page.tsx` wired to the `locale` param + switcher/header like every other `[locale]` page). Lib-resident copy (`progress/tracks.ts`, `progress/suggest.ts`, `assistant/format.ts`, `research-label.ts`, `STRENGTH_LABEL`) is keyed by stable ids resolved in components via `shared.*`/`assistant.errors.*` — lib files never call `useTranslations`.
- Phase 4 — Admin: shell (brand strings + tier badge + `NAV_ITEMS`, including adding the missing `/admin/requests` entry) + overview + analytics + content + ops + users + workspaces + workspace-detail + requests (AR mirrors added), shared admin components (`AdminTable`, `ContentActions`, `UserActions`, `WorkspaceSwitcher`, `ReportGenerator`, `EmailResendButton`, `PlatformAdminGrantForm`, `PlatformAdminRevokeButton`, `AnalyticsAutoRefresh`, `KpiCard`).

## 4. Switcher design (delegated choice, locked)

Pill toggle matching the dark glass header: `glass rounded-full` container, `ع | EN` segments at `text-xs`, active locale `bg-brand-500/20` + bright text, inactive dimmed; single click switches; `title` tooltip; `aria-pressed` retained and now visually reflected. Rejected: dropdown (extra click for 2 locales), icon-only (hides current locale). Files: `LanguageSwitcher.tsx` only (+ colocated test if behavior added; none planned). Hard rules from prior SDD run: R11 — client cookie write stays without `Secure` (server re-set owns Secure-in-prod; the redesign MUST NOT add `Secure` client-side); R12 — only unprefixed paths into `withLocale`, no new dynamic href prefixing without a guard.

## 5. Message architecture

- Extend `apps/web/messages/ar.json` + `en.json` with namespaces: `landing`, `auth`, `dashboard`, `validate`, `history`, `assistant`, `plans`, `memories`, `invite`, `admin`, `shared`. Estimated ~500–650 new keys total (landing ~60, validate ~90, dashboard ~45, history ~45, login ~25, assistant ~40, plans/request ~35, memories ~20, invite ~8, admin ~150–180 for 8 pages + 10 components, shared/components ~30; +10–20% headroom for ICU splits of concatenated strings). Method: Oct 2026 source audit; counts are planning guides, not caps.
- Both files MUST keep identical key shape (parity test per namespace). Shared strings (`Cancel`, `Close`, `Search`, `Apply`, `Confirm`, network-error texts, verdict/stage/confidence enums, pagination `"Page X of Y"`) live once in `shared.*`.
- Dynamic values use next-intl ICU placeholders (counts, dates, names) — no string concatenation in components. Count strings MUST use ICU plural forms with full Arabic categories (zero/one/two/few/many) — known sites: dashboard workspace stats, history session totals, admin pagination/"Showing X of Y", workspace usage/member counts.

## 6. Copy & locale conventions (binding)

- Arabic: simplified plain style, Egyptian spirit, no hard terms (same bar as the prior Arabic review).
- English: match the site's current tone; admin/assistant EN mirrors translate meaning, not word-for-word.
- Machine-English tokens, API field names, and route paths stay English in both locales.
- Legal consent text (`consent-checkbox.tsx`) stays Arabic verbatim in both locales — translating legal text is a risk, explicitly accepted — and is path-exempted in the source-scan gate (§7) so the gate does not flag it.
- Numbers/dates via `Intl` per locale (extend the existing `formatNumber` pattern; hardcoded `en-US` dates become locale-driven); paywall `dir="rtl"` hardcodes become locale-driven.
- Directional styling is locale-driven: logical props (`ms-/me-`, `start-/end-`, `text-start/end`) instead of physical `left-/right-`/`ml-/mr-`/`text-left`; directional icons (←/→) flip under `rtl`. When a file is touched by its phase, its physical-direction offenders are converted (validate/dashboard/history/login/landing headers, admin tables, assistant panel).

## 7. Quality gates (every phase)

- `tsc --noEmit` clean; eslint clean on touched files; full vitest green.
- Parity test per touched namespace (identical ar/en key shape, no empty/`TODO` values; the existing recursive parity test auto-extends).
- New source-scan gate: the existing `no-mixed-language` test scans messages JSON only — each phase adds a source scan failing on new hardcoded UI literals in touched files, with an explicit exemption list (starting with `consent-checkbox.tsx`; not-yet-covered phases' files stay exempt until their phase lands, then exemptions are removed).
- Per-file next-intl mapping: `"use client"` files use `useTranslations`; server files use `getTranslations`; nested client-in-server (e.g. `RequestForm` inside `plans/page.tsx`) resolves translations at the client boundary.
- No dev server, no Live-pointed tests (Live project; CI owns e2e). `next build` green before each phase merge.
- Each phase: implement → self-review → independent reviewer → merge to `main` → push (redeploys Live).

## 8. Risks

- Review burden: ~500+ Arabic strings need human spot-checks; mitigation: per-phase diffs, reviewer reads AR values.
- Admin AR mirrors for dense operational vocabulary; mitigation: shared glossary in `shared.*`, reviewer flags awkward terms.
- Scope creep into behavior refactors while wiring translations; mitigation: translation-only diffs except three allowlisted touches (paywall `dir` locale-driven; client-side `MEMORY_COPY` mirror; admin `/admin/requests` nav entry) — any other behavior fix split out.
- No global `error.tsx`/`not-found.tsx`/`loading.tsx` boundaries exist (verified by glob) — no action required; inline loaders are covered by their pages' phases.
