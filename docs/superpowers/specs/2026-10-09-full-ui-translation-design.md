# Design: full UI translation coverage + LanguageSwitcher redesign

- Date: 2026-10-09. Branch: `feat/full-ui-translation` (base: `12ddaf8`).
- Authority: user-approved in-chat design (4 sections) on 2026-10-09; this file is the binding spec.
- Prior art: `docs/superpowers/specs/2026-10-08-i18n-translation-design.md` (locale routing, cookie, AI/email locale, RTL shell). Nothing here changes routing, middleware, cookie semantics, or `HtmlLocaleSync`.

## 1. Problem

- `LanguageSwitcher` (`apps/web/src/components/LanguageSwitcher.tsx`) is a functional placeholder: two unstyled buttons, no active-locale indication, no tooltip, breaks header rhythm.
- Translation coverage is 8 keys (`common.*`, `nav.*`) against ~700 hardcoded user-facing literals in 31 files (<5% of visible UI). Everything outside `nav.*` ignores the locale switch. AR-only islands (assistant, plans, dashboard paywall) have no EN mirror; EN-only surfaces (landing, validate, admin, invite) have no AR mirror.

## 2. Scope

In scope: redesign of `LanguageSwitcher`; new `ar`+`en` message namespaces and `useTranslations`/`getTranslations` wiring for landing, login, dashboard, validate, history, assistant, plans, request-form, memories, invite, admin console (7 pages), shared components; parity + no-mixed-language tests.
Out of scope: locale routing/middleware/cookie behavior; AI prompt/email locale logic (already locale-aware); per-locale `<title>` (parked earlier); translating machine-English field tokens; changing any runtime behavior besides rendered language.

## 3. Phased delivery (each phase merges independently)

- Phase 1 — Switcher: redesign + wire to existing `common.switchToArabic`/`common.switchToEnglish` keys (currently hardcoded, unused). No behavior change (same cookie + same-page `router.replace`).
- Phase 2 — User surfaces: landing → login → dashboard → validate → history.
- Phase 3 — Assistant & plans: assistant panel/view, plans page, request-form, memories (`MEMORY_COPY` gains EN mirror; 5 EN residuals keyed), invite flow.
- Phase 4 — Admin: shell + overview + analytics + content + ops + users + workspaces + workspace-detail + requests (AR mirrors added), shared admin components (`AdminTable`, `ContentActions`, `UserActions`, `WorkspaceSwitcher`, `ReportGenerator`, `EmailResendButton`, `PlatformAdminGrantForm`, `PlatformAdminRevokeButton`, `AnalyticsAutoRefresh`, `KpiCard`).

## 4. Switcher design (delegated choice, locked)

Pill toggle matching the dark glass header: `glass rounded-full` container, `ع | EN` segments at `text-xs`, active locale `bg-brand-500/20` + bright text, inactive dimmed; single click switches; `title` tooltip; `aria-pressed` retained and now visually reflected. Rejected: dropdown (extra click for 2 locales), icon-only (hides current locale). Files: `LanguageSwitcher.tsx` only (+ colocated test if behavior added; none planned).

## 5. Message architecture

- Extend `apps/web/messages/ar.json` + `en.json` with namespaces: `landing`, `auth`, `dashboard`, `validate`, `history`, `assistant`, `plans`, `memories`, `invite`, `admin`, `shared`. Estimated ~450–550 new keys total (landing ~60, validate ~90, dashboard ~45, history ~45, login ~25, assistant ~40, plans/request ~35, memories ~20, invite ~8, admin ~150, shared/components ~30).
- Both files MUST keep identical key shape (parity test per namespace). Shared strings (`Cancel`, `Close`, `Search`, `Apply`, `Confirm`, network-error texts, verdict/stage/confidence enums, pagination `"Page X of Y"`) live once in `shared.*`.
- Dynamic values use next-intl ICU placeholders (counts, dates, names) — no string concatenation in components.

## 6. Copy & locale conventions (binding)

- Arabic: simplified plain style, Egyptian spirit, no hard terms (same bar as the prior Arabic review).
- English: match the site's current tone; admin/assistant EN mirrors translate meaning, not word-for-word.
- Machine-English tokens, API field names, and route paths stay English in both locales.
- Legal consent text (`consent-checkbox.tsx`) stays Arabic verbatim in both locales — translating legal text is a risk, explicitly accepted.
- Numbers/dates via `Intl` per locale (extend the existing `formatNumber` pattern); paywall `dir="rtl"` hardcode becomes locale-driven.

## 7. Quality gates (every phase)

- `tsc --noEmit` clean; eslint clean on touched files; full vitest green.
- Parity test per touched namespace (identical ar/en key shape, no empty/`TODO` values).
- Extend the existing `no-mixed-language` gate so new hardcoded literals fail.
- No dev server, no Live-pointed tests (Live project; CI owns e2e). `next build` green before each phase merge.
- Each phase: implement → self-review → independent reviewer → merge to `main` → push (redeploys Live).

## 8. Risks

- Review burden: ~500 Arabic strings need human spot-checks; mitigation: per-phase diffs, reviewer reads AR values.
- Admin AR mirrors for dense operational vocabulary; mitigation: shared glossary in `shared.*`, reviewer flags awkward terms.
- Scope creep into behavior refactors while wiring translations; mitigation: translation-only diffs, any behavior fix split out.
