# Full UI Translation Coverage + Switcher Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cover 100% of user-visible UI strings (including admin) with `ar`/`en` next-intl keys, redesign the language pill, and fix Arabic font wiring — in 5 independently shippable tasks.

**Architecture:** Extend the existing `messages/{ar,en}.json` with 11 namespaces and wire each surface with `useTranslations` (client) / `getTranslations` (server); lib-resident copy is keyed by stable ids resolved in components; a new source-scan test forbids new hardcoded literals.

**Tech Stack:** Next.js 15 + next-intl `^4.3.0` + vitest + tsc + eslint. Workdir for commands: `apps/web`. Repo root: `D:\Downloads\Ai_OS\.worktrees\i18n-translation`. Branch: `feat/full-ui-translation` (do NOT merge to `main`, do NOT push — controller owns deploy).

**Spec:** `docs/superpowers/specs/2026-10-09-full-ui-translation-design.md` (binding; executors read both).

## Global Constraints

- Locales are exactly `["ar", "en"]`, default `en` (`src/i18n/routing.ts:3-7` — do NOT touch).
- Cookie line in `LanguageSwitcher.tsx:16` stays byte-identical: `` document.cookie = `NEXT_LOCALE=${t}; Path=/; Max-Age=31536000; SameSite=Lax` `` (R11: NEVER add `Secure` client-side).
- Only unprefixed paths into `withLocale` (R12: it is NOT idempotent).
- Run tools node-direct, NEVER bare `npx`: `node node_modules/typescript/bin/tsc --noEmit`, `node node_modules/vitest/vitest.mjs run <path>`, `node node_modules/eslint/bin/eslint.js <files>`, `node node_modules/next/dist/bin/next build`.
- NEVER start a dev server; NEVER point tests at Live (R10). `next build` is allowed.
- Arabic copy: simplified plain style, Egyptian spirit, no hard terms. English copy: current site tone. Machine-English tokens, route paths, CSV headers, API error bodies: unchanged.
- Every task ends green: tsc 0 + eslint 0 on touched files + FULL vitest green + (Tasks 0,1,4) `next build` green. Then commit. Then independent reviewer before next task.

## Review Focus

1. Arabic page rendering latin-fallback glyphs → Task 0 body rule + controller visual check on Live after deploy (implementer: `next build` green + grep proof).
2. Broken RTL (physical `left-/right-/ml-/mr-/text-left`, unflipped ←/→) → each task converts offenders in touched files; reviewer greps the diff for `text-left|ml-|mr-|left-|right-|←|→`.
3. Wrong Arabic plurals ("3 startups" grammar) → plural keys MUST contain `{n, plural, =0 {...} =1 {...} =2 {...} few {...} many {...} other {...}}`; Task 2 adds a test asserting every `shared.pagination.*` / count key value contains `", plural,"`.
4. Switch losing query/hash (behavioral) → owned by existing CI Playwright switch spec; Task 1 reviewer diff-checks `switchTo` body lines 9-18 for logic changes (only JSX may change).
5. Client cookie regression → Task 1 reviewer asserts line 16 byte-identical.

---

## File Structure

- Modify: `apps/web/messages/ar.json`, `apps/web/messages/en.json` (append namespaces; keep valid JSON).
- Modify: `apps/web/src/app/globals.css` (Task 0: body font rule only).
- Modify: `apps/web/src/components/LanguageSwitcher.tsx` (Task 1: JSX + hook only).
- Create: `apps/web/src/lib/__tests__/no-hardcoded-strings.test.ts` (Task 1 scaffold with exemptions; Tasks 2-4 remove exemptions).
- Modify + wire (Task 2): `src/app/[locale]/page.tsx`, `login/page.tsx`, `dashboard/page.tsx`, `validate/page.tsx`, `history/page.tsx`, `src/components/StageProgressSection.tsx`, `src/components/StageStepper.tsx`.
- Modify + wire (Task 3): `src/app/[locale]/assistant/**`, `src/components/AssistantFloatProvider.tsx`, `src/app/[locale]/plans/page.tsx`, `request-form.tsx`, `memories-client.tsx`, `memories/page.tsx`, `invite/[token]/page.tsx`.
- Modify + wire (Task 4): `src/app/[locale]/admin/**`, `src/components/admin/**`.

---

### Task 0: P0 font wiring (unblocks all Arabic surfaces)

**Files:**
- Modify: `apps/web/src/app/globals.css` (body rule, line 42)
- Test: none new (build + grep proof)

**Interfaces:**
- Consumes: `app/layout.tsx:9-10,26` (sets `--font-en`=`Inter` / `--font-ar`=`Cairo` on `<html>`, one at a time).
- Produces: `body` renders `var(--font-ar)` on `/ar`, `var(--font-en)` on `/en`.

- [ ] **Step 1: Confirm the defect**

Run: `Select-String -Pattern "font-ar|font-en" -Path apps/web/src/app/globals.css`
Expected: NO matches (vars set by layout, never read) — defect confirmed.

- [ ] **Step 2: Fix the body rule**

Replace `apps/web/src/app/globals.css:42`:
```css
font-family: var(--font-inter);
```
with:
```css
font-family: var(--font-ar, var(--font-en, var(--font-inter)));
```
Why correct: layout applies exactly one variable class, so `--font-ar` exists only on `/ar` and `--font-en` only on `/en`; fallback preserves today's rendering if neither exists. Do NOT touch the `@import` line or anything else.

- [ ] **Step 3: Verify**

Run: `node node_modules/typescript/bin/tsc --noEmit` → exit 0. Then `node node_modules/next/dist/bin/next build` → exit 0 with `/ar` + `/en` prerendered.
Expected: both green.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/globals.css
git commit -m "fix(i18n): wire locale font vars into body font-family"
```

---

### Task 1: Phase 1 — Switcher redesign + source-scan gate scaffold

**Files:**
- Modify: `apps/web/messages/ar.json` (add 1 key), `apps/web/messages/en.json` (add 1 key)
- Modify: `apps/web/src/components/LanguageSwitcher.tsx` (JSX + hook only — lines 9-18 logic UNTOUCHED)
- Create: `apps/web/src/lib/__tests__/no-hardcoded-strings.test.ts`
- Test: `apps/web/src/lib/__tests__/i18n-keys.test.ts` (existing parity, auto-extends)

**Interfaces:**
- Consumes: `routing` locales `["ar","en"]`; existing `common.switchToArabic`/`common.switchToEnglish` (native names, both files).
- Produces: `common.switchLanguage` key (`ar`: `"تبديل اللغة"`, `en`: `"Switch language"`); scan-gate with exemption list consumed by Tasks 2-4.

- [ ] **Step 1: Add the one new key (both files)**

In `ar.json` inside `common`: `"switchLanguage": "تبديل اللغة"`. In `en.json` inside `common`: `"switchLanguage": "Switch language"`. Keep files valid JSON.

- [ ] **Step 2: Run parity to verify keys land**

Run: `node node_modules/vitest/vitest.mjs run src/lib/__tests__/i18n-keys.test.ts`
Expected: PASS (4/4 — recursive parity auto-covers the new key).

- [ ] **Step 3: Rewrite the switcher JSX (only lines 1, 4, 19-24 change)**

```tsx
"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

export default function LanguageSwitcher({ locale }: { locale: "ar" | "en" }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const t = useTranslations("common");
  // switchTo lines 9-18 stay EXACTLY as-is (see Review Focus 4+5).
  function switchTo(t: "ar" | "en") {
    /* ...unchanged... */
  }
  return (
    <div role="group" aria-label={t("switchLanguage")} className="glass flex items-center gap-0.5 rounded-full p-0.5">
      <button onClick={() => switchTo("ar")} aria-pressed={locale === "ar"} title={t("switchToArabic")}
        className={`rounded-full px-2.5 py-1 text-xs transition-colors ${locale === "ar" ? "bg-brand-500/20 text-slate-100" : "text-slate-400 hover:text-slate-200"}`}>ع</button>
      <button onClick={() => switchTo("en")} aria-pressed={locale === "en"} title={t("switchToEnglish")}
        className={`rounded-full px-2.5 py-1 text-xs transition-colors ${locale === "en" ? "bg-brand-500/20 text-slate-100" : "text-slate-400 hover:text-slate-200"}`}>EN</button>
    </div>
  );
}
```
Rules: `switchTo` body + cookie line byte-identical; labels use `t()` (native names render from messages); active segment lit, inactive dimmed; `glass`, `bg-brand-500/20`, `text-xs` match header siblings. (If `bg-brand-500/20` is not a configured token, use the header's existing active-state classes from a sibling component instead — grep `bg-brand` in components and copy the exact working token.)

- [ ] **Step 4: Create the source-scan gate**

Create `apps/web/src/lib/__tests__/no-hardcoded-strings.test.ts`:
```ts
// Fails on Arabic-script or sentence-case English UI literals in COVERED files.
// Exempt: not-yet-covered phases' files + consent-checkbox.tsx (legal verbatim, permanent).
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const EXEMPT = new Set([
  "src/components/consent-checkbox.tsx", // legal text stays Arabic (spec §6)
  // Phase 2 files (exemptions removed in Task 2):
  "src/app/[locale]/page.tsx",
  "src/app/[locale]/login/page.tsx",
  "src/app/[locale]/dashboard/page.tsx",
  "src/app/[locale]/validate/page.tsx",
  "src/app/[locale]/history/page.tsx",
  "src/components/StageProgressSection.tsx",
  "src/components/StageStepper.tsx",
  // Phase 3 files (removed in Task 3):
  "src/app/[locale]/assistant/AssistantPanel.tsx",
  "src/app/[locale]/assistant/AssistantView.tsx",
  "src/app/[locale]/assistant/page.tsx",
  "src/app/[locale]/assistant/ActionCards.tsx",
  "src/app/[locale]/assistant/CitationChip.tsx",
  "src/components/AssistantFloatProvider.tsx",
  "src/app/[locale]/plans/page.tsx",
  "src/app/[locale]/plans/request-form.tsx",
  "src/app/[locale]/memories/memories-client.tsx",
  "src/app/[locale]/memories/page.tsx",
  "src/app/[locale]/invite/[token]/page.tsx",
  // Phase 4 files (removed in Task 4):
  "src/app/[locale]/admin/layout.tsx",
  "src/app/[locale]/admin/page.tsx",
  "src/app/[locale]/admin/analytics/page.tsx",
  "src/app/[locale]/admin/content/page.tsx",
  "src/app/[locale]/admin/ops/page.tsx",
  "src/app/[locale]/admin/users/page.tsx",
  "src/app/[locale]/admin/workspaces/page.tsx",
  "src/app/[locale]/admin/workspaces/[id]/page.tsx",
  "src/app/[locale]/admin/requests/page.tsx",
  "src/components/admin/AdminTable.tsx",
  "src/components/admin/ContentActions.tsx",
  "src/components/admin/UserActions.tsx",
  "src/components/admin/WorkspaceSwitcher.tsx",
  "src/components/admin/ReportGenerator.tsx",
  "src/components/admin/EmailResendButton.tsx",
  "src/components/admin/PlatformAdminGrantForm.tsx",
  "src/components/admin/PlatformAdminRevokeButton.tsx",
  "src/components/admin/AnalyticsAutoRefresh.tsx",
  "src/components/admin/KpiCard.tsx",
]);

const AR = /[\u0600-\u06FF]/;

describe("no hardcoded UI strings in covered files", () => {
  it("covered source files contain no Arabic-script literals", () => {
    const root = join(__dirname, "..", "..");
    const bad: string[] = [];
    const walk = (dir: string) => {
      const { readdirSync, statSync } = require("node:fs");
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        const rel = p.split("src")[1] ? `src${p.split("src")[1]}`.replace(/\\/g, "/") : "";
        if (statSync(p).isDirectory()) { if (!e.includes("node_modules")) walk(p); continue; }
        if (!/\.tsx?$/.test(e) || e.includes(".test.")) continue;
        if (EXEMPT.has(rel)) continue;
        const src = readFileSync(p, "utf8");
        const lines = src.split("\n");
        lines.forEach((ln, i) => {
          const code = ln.split("//")[0];
          if (AR.test(code) && !code.includes("i18n-exempt")) bad.push(`${rel}:${i + 1}`);
        });
      }
    };
    walk(join(root, "src"));
    expect(bad).toEqual([]);
  });
});
```
Note: `LanguageSwitcher.tsx` itself is COVERED from this task on (its labels now come from `t()`; `aria` uses `t("switchLanguage")`). If the walk flags it, the implementer left a literal — fix, don't exempt.

- [ ] **Step 5: Run everything**

Run: `node node_modules/vitest/vitest.mjs run` → FULL green. Then tsc → 0. Then eslint on the 4 touched files → 0. Then `next build` → green.
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/web/messages/ar.json apps/web/messages/en.json apps/web/src/components/LanguageSwitcher.tsx apps/web/src/lib/__tests__/no-hardcoded-strings.test.ts
git commit -m "feat(i18n): redesign language pill + source-scan gate scaffold"
```

---

### Task 2: Phase 2 — User surfaces (landing/login/dashboard/validate/history + stage components + shared.*)

**Files:**
- Modify: `apps/web/messages/ar.json` + `en.json` (add `landing`, `auth`, `dashboard`, `validate`, `history`, `shared` namespaces)
- Modify + wire: `src/app/[locale]/page.tsx`, `login/page.tsx`, `dashboard/page.tsx`, `validate/page.tsx`, `history/page.tsx`, `src/components/StageProgressSection.tsx`, `src/components/StageStepper.tsx`
- Modify: `apps/web/src/lib/__tests__/no-hardcoded-strings.test.ts` (remove the 7 Phase-2 exemptions)
- Test: existing parity (auto) + plural-form test (new, in `i18n-keys.test.ts`)

**Interfaces:**
- Consumes: Task 1 gate + `common.*`; `stripLocale` untouched.
- Produces: namespaces below; `shared.*` append-only base for Tasks 3-4.

Key contract (EN values = current literals VERBATIM from cited lines; AR per spec §6 simplified style; EVERY key in BOTH files):

- `shared.actions.*`: `cancel, close, apply, confirm, retry, delete, save, back, clearAll, clearFilters, invite, export, downloadCsv, stop, send, signOut`
- `shared.pagination.*`: `pageXofY` = `"{x, plural, =0 {...} ...} ..."` ICU with full AR categories (dashboard:460-area, history:669, AdminTable:175)
- `shared.errors.*`: `networkError` ("Network error — please retry" / "Network error. Please try again." variants unified), `requestFailed`, `failedToLoad`, `unknownError`, `agentRunFailed`
- `shared.verdicts.*`: `go, iterate, stop, testMore` (+ history:74-77 labels, validate DecisionMemo, analytics bars)
- `shared.confidence.*`: `high, medium, low` (+ `confidence` label)
- `shared.misc.*`: `loading, on, off, role, searchDefault` ("Search (min 2 chars)..."), `previousPage, nextPage`
- `shared.stages.*`: stage-label ids mirroring `lib/progress/tracks.ts:17-55` (components resolve by id; lib file UNTOUCHED)
- `landing.*`: `header.{brand, version, launch}`, `hero.{eyebrow, titleA, titleB, subA, subB, subC, inputPlaceholder, primaryCta, orLineA, orLineB, orLineC}`, `trust[4]`, `steps[6].{label,desc}` (page.tsx:27-58), `features[6].{title,desc}` (:66-96), `verdicts[4].{name,desc}` (:103-106), `golden.{title,sub}`, `rigor.{title,desc}`, `honesty.{title,desc}`, `ladder.{title,rows[5].{rung,label},note}`, `final.{title,desc,cta}`, `footer.{brand,builtWith,pdpl}`
- `auth.*` (login): `taglineA, taglineB, signInTab, signUpTab, google, emailDivider, fullName{Label,Placeholder}, email{Label,Placeholder}, password{Label,Placeholder}, submitSignIn, submitSignUp, forgotPrefix, forgotLink, enterEmailFirst, resetSent, checkEmail, terms, pdplLine, loading`
- `dashboard.*`: `greeting, workspaceLine` (plural startups/members), `stats.{startups,teamMembers,experiments,decisions}`, `startups.{title,newCta,emptyTitle,emptyCta}`, `team.{title,inviteCta,emptyLine,memberLine}` (plural-aware `Joined {date}`), `quickActions.{title,inviteCta}`, `inviteModal.*` (:563-625 all), `dialogs.{workspacePrompt, membershipAlert}`, `paywall.*` (EN mirrors of existing AR :638-656), `header.{noWorkspace, workspacesTitle, newWorkspace, adminLink, avatarAlt, signOutTitle}`, `loading`
- `validate.*`: `phases[10]` (PhaseIndicator :66-75), `trace.{title,countPattern,waiting}`, `cards.{riskWhy,source,targetSample,estCost,timeToRun,successCriteria,questionsTitle,biasApproved}`, `leads.{notice}`, `icp.{role,context,pain,workaround,authority,tam,sam,som,preliminary}`, `investor.{topGaps}`, `decision.{confidence,rationale,nextExperiment}`, `serverErrors.{offlineSnapshot,saveFailed,requestFailed,statusPattern,retryIn,streamEnded}`, `header.{readyTitle,verifierOk,verifierFlags,callsUsed}`, `form.{ideaLabel,ideaPlaceholder,evidenceLabel,evidencePlaceholder,evidenceHint}`, `paywall.*` (EN mirrors :1061-1068), `controls.{stop,run,examplesTitle,examples[3]}`, `stats.{title,evidence,assumptions}`, `tabs.{results,trace}`, `idle.{title,desc,bullets[4]}`, `results.{agentError,apiKeyHint,browserOnly,clarifying,assumptionMap,secondaryOnly,moreItems,icpTitle,experimentTitle,leadsTitle,leadsSearching,primaryTitle,primarySub,memoTitle,scoreTitle,toolsUsed,verifierSummary,evidenceCount}`, `assistant.errors.*` mirroring `lib/assistant/format.ts:46,57-63` + `lib/research-label.ts:15-20` + `STRENGTH_LABEL` (resolve in components; lib files UNTOUCHED)
- `history.*`: `header.{title,subPattern,searchPlaceholder,exportCta,openTitle,openParentTitle,noResultsFor}`, `filters.{byNamePlaceholder,filtersTitle,sortDate,sortUpdated,sortName,descTitle,ascTitle,activeTitle,verdict,stage,confidence,dateRange,fromPlaceholder,toPlaceholder}`, `states.{error,retry,emptyFiltered,emptyFresh,clearCta,startCta}`, `cards.{assumptions,validated,experiments,critical,confidencePattern}`, (CSV headers stay EN — NO keys, spec §2)

- [ ] **Step 1: Write AR+EN keys for `shared.*` + ONE page (landing) first, run parity**

Run: `node node_modules/vitest/vitest.mjs run src/lib/__tests__/i18n-keys.test.ts` → PASS. (Repeat per page-group; parity is the per-batch gate.)

- [ ] **Step 2: Wire landing (`src/app/[locale]/page.tsx`) with `useTranslations("landing")`**

Client or server? Check the file's first line: if `"use client"` → `const t = useTranslations("landing")`; else `const t = await getTranslations("landing")`. Replace each literal with `t("path")`; arrays map to indexed keys (`t("steps.0.label")` style or `t.raw` — pick ONE pattern per file and stay consistent). Convert physical-direction classes in touched JSX to logical props (`text-left`→`text-start`, `ml-/mr-`→`ms-/me-`, `left-/right-`→`start-/end-`) and flip ←/→ under rtl.

- [ ] **Step 3: Repeat Step 1-2 pattern for login → dashboard → validate → history → stage components**

Dashboard `prompt()`/`alert()` take `tDialog("...")` strings from `useTranslations("dashboard.dialogs")`. Dashboard/history counts use plural keys. `dir="rtl"` hardcodes (dashboard:637, validate:1059) become `dir={locale === "ar" ? "rtl" : "ltr"}` via existing locale prop/context (no new plumbing — read how the file already knows locale; if it doesn't, use `useLocale()` from next-intl).

- [ ] **Step 4: Add the plural-form test to `i18n-keys.test.ts`**

```ts
it("plural keys use full ICU plural syntax", () => {
  const flat = JSON.stringify(en);
  for (const k of ["shared.pagination.pageXofY", "dashboard.workspaceLine", "history.header.subPattern"]) {
    const val = k.split(".").reduce<unknown>(
      (a, key) => (typeof a === "object" && a !== null ? (a as Record<string, unknown>)[key] : undefined),
      en as unknown
    );
    expect(typeof val === "string" && val.includes(", plural,")).toBe(true);
  }
});
```
(Adjust key names to what Step 1 actually created — the assertion shape `contains ", plural,"` is the requirement.)

- [ ] **Step 5: Remove the 7 Phase-2 exemptions from the scan gate, run FULL suite**

Run: full vitest → green (scan gate now enforces the 7 files). tsc → 0. eslint on touched files → 0.
Expected: green; any flagged literal is a missed string — key it, don't re-exempt.

- [ ] **Step 6: Commit per page-group (5 commits, one per surface)**

```bash
git add apps/web/messages/ar.json apps/web/messages/en.json apps/web/src/app/[locale]/page.tsx
git commit -m "feat(i18n): translate landing (ar/en)"
# ... login, dashboard, validate (+ stage components), history
```

---

### Task 3: Phase 3 — Assistant, plans, memories, invite

**Files:**
- Modify: messages (add `assistant`, `plans`, `memories`, `invite` namespaces; extend `shared.*` only append-only)
- Modify + wire: `src/app/[locale]/assistant/AssistantPanel.tsx`, `AssistantView.tsx`, `page.tsx` (metadata via `generateMetadata`), `ActionCards.tsx` (only if literals found), `CitationChip.tsx`, `src/components/AssistantFloatProvider.tsx`, `src/app/[locale]/plans/page.tsx` (+ metadata), `request-form.tsx`, `memories-client.tsx`, `memories/page.tsx`, `invite/[token]/page.tsx`
- Modify: scan gate (remove 11 Phase-3 exemptions)
- Test: parity (auto) + FULL suite

**Interfaces:**
- Consumes: Task 2 `shared.*`; `MEMORY_COPY` ids from `lib/companion/copy.ts` (read-only reference).
- Produces: namespaces below; server error bodies UNCHANGED.

Key contract:
- `assistant.*`: `composer.{placeholder, sendAria, sendLabel, stopAria, stopLabel, thinking}`, `list.{titlePattern, newCta, emptyLine, renameTitle, renameAria, deleteTitle, deleteAria, quotaTitle, quotaPattern}`, `dialogs.{deleteTitle, deleteBody, deleteConfirm, cancelAria, confirmAria}`, `errors.{unavailable, loadFailed, tooLong, failed, disconnected, serverUnreachable, renameFailed, deleteFailed}`, `samples[3]`, `hints.{composerHint, floatLabel, openFull, viewPlans, newChatCta, closeAria}`, `citation.{titlePattern, ariaPattern}`, `view.{loading}`, `page.{metadataTitle, metadataDescription, headerTitle}`
- `assistant.errors.*`: stable ids mirroring `lib/assistant/format.ts` (resolve in components; lib UNTOUCHED)
- `plans.*`: `page.{metadataTitle, metadataDescription, title, sub, quotaTitle, quotaBody}`, `tiers.{free.{name,desc,price,cta}, pro.{...}, team.{...}}`, `requestForm.*` (all labels/placeholders/states/errors from request-form.tsx:17-254)
- `memories.*`: EN mirrors of all 18 `MEMORY_COPY` ids (same ids, `memories.*` namespace) + residuals (`dismissAria, cancelAria, approvedAria, onLabel, offLabel, forgetCancel`) + paywall EN (`paywallTitle, paywallCta`)
- `invite.*`: `page.{title, accepted, declined, expired, networkError, requestFailed, bodyText, workingCta, acceptCta, declineCta}` + wire `invite/[token]/page.tsx` to the `locale` param + render `LanguageSwitcher` in its header (the only `[locale]` page missing both)

- [ ] **Step 1: Keys + parity (per file-group, same as Task 2 Step 1)**
- [ ] **Step 2: Wire components (same useTranslations/getTranslations rule as Task 2; `plans/page.tsx:3,31` is server → `getTranslations`; `request-form.tsx:1` is client → `useTranslations`; resolve at the client boundary)**
- [ ] **Step 3: Route metadata locale-aware for assistant + plans pages** via `generateMetadata` reading locale (same pattern as root layout:12-20)
- [ ] **Step 4: Remove 11 Phase-3 exemptions; FULL vitest + tsc + eslint green**
- [ ] **Step 5: Commit per file-group**

```bash
git commit -m "feat(i18n): translate assistant (ar/en)"
# ... plans+request-form, memories, invite
```

---

### Task 4: Phase 4 — Admin console (8 pages + 10 shared components)

**Files:**
- Modify: messages (add `admin` namespace + `admin.dialogs.*`; `shared.*` append-only)
- Modify + wire: `src/app/[locale]/admin/layout.tsx` (+ add missing `/admin/requests` nav entry), `admin/page.tsx`, `admin/analytics/page.tsx`, `admin/content/page.tsx`, `admin/ops/page.tsx`, `admin/users/page.tsx`, `admin/workspaces/page.tsx`, `admin/workspaces/[id]/page.tsx`, `admin/requests/page.tsx`, all 10 `src/components/admin/*.tsx`
- Modify: scan gate (remove Phase-4 exemptions; only `consent-checkbox.tsx` remains)
- Test: parity (auto) + FULL suite + `next build`

**Interfaces:**
- Consumes: Tasks 1-3 (`shared.*`, gate).
- Produces: full coverage; scan gate with zero phase exemptions left.

Key contract (`admin.*`): `shell.{brand, adminTitle, tierPlatform, tierWorkspace, sectionsAria, nav.{overview,users,workspaces,content,analytics,ops,requests}}`, per-page namespaces `admin.overview.*`, `admin.analytics.*`, `admin.content.*`, `admin.ops.*`, `admin.users.*`, `admin.workspaces.*`, `admin.workspaceDetail.*`, `admin.requests.*` (EN values verbatim from current literals; AR mirrors per §6), `admin.dialogs.{revokeConfirmPattern, screenConfirmPattern, suspendPattern}`, `admin.tables.*` (shared headers reused from `shared.*` where identical: search placeholders, empty lines, pagination).

- [ ] **Step 1: Keys + parity per page-group (same pattern)**
- [ ] **Step 2: Wire shell first (nav uses `useTranslations("admin.shell")`; requests nav entry added here), then pages overview → analytics → content → ops → users → workspaces → detail → requests, then the 10 shared components**
- [ ] **Step 3: Remove ALL remaining exemptions; FULL vitest green (scan enforces entire app); tsc + eslint green; `next build` green**
- [ ] **Step 4: Commit per page-group**

```bash
git commit -m "feat(i18n): translate admin shell+overview (ar/en)"
# ... per page
```

---

## Self-Review (run by plan author — done inline)

1. **Spec coverage:** §1 problem → Tasks 1-4; §3 P0 → Task 0, Phase 1 → Task 1, Phases 2-4 → Tasks 2-4 (orphans assigned: float→T3, stage→T2, invite→T3, nav entry→T4); §4 switcher → Task 1 (+R11/R12 rules, tooltip key); §5 namespaces/estimates/plurals → Tasks 2-4 + plural test; §6 conventions/consent-exempt/CSV-out/dir-rule/RTL-rule → Global Constraints + per-task steps; §7 gates → per-task Step green-gates + scan gate Task 1 scaffold; §8 allowlist (paywall dir, MEMORY_COPY mirror, requests nav) → Tasks 2/3/4.
2. **Placeholder scan:** no TBD/TODO/"similar to" without content — repeated patterns (parity run, commit shape) are restated per task with exact commands since implementers may read tasks out of order.
3. **Type consistency:** key paths (`dashboard.dialogs.*`, `admin.dialogs.*`, `assistant.errors.*`, `shared.stages.*`, `shared.pagination.pageXofY`) identical everywhere cited; test assertion references match.
4. **Review Focus:** 5/5 pinned to owning tasks (P0→T0, RTL→T2-4 steps, plurals→T2 test, switch behavior→T1 reviewer check, cookie→T1 reviewer check).
