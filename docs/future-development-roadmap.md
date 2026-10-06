# Validation Copilot — Future Development Roadmap

| Field         | Value                                                              |
|---------------|--------------------------------------------------------------------|
| **Status**    | `PROPOSED` (not approved for implementation)                        |
| **Version**   | `0.1.0`                                                             |
| **Date**      | `2026-10-05`                                                        |
| **Owner**     | Product / Engineering                                               |
| **Scope**     | Post-stabilization; responsive-design milestone is a prerequisite   |
| **Reviewers** | TBD (requires sign-off before any P0 work starts)                   |

> **How to use this document.** Each initiative (F-01 … F-10) is specified to be
> implementable independently: problem → solution → technical approach →
> acceptance criteria → risks → effort → dependencies → success metrics.
> Nothing in this document is committed work until its status flips to `APPROVED`
> with an owner and a target milestone.

---

## 1. Goal & Guiding Principles

### 1.1 Goal

Evolve Validation Copilot from a single-session validation tool into the
**decision system of record for early-stage founders** — the product they share,
revisit weekly, and pay for continuously — while keeping unit economics
(model spend per validation) sustainable.

### 1.2 Principles (non-negotiable, inherited from current architecture)

1. **Evidence over opinion.** Every verdict must cite retrievable evidence;
   the verifier's unsupported-claim rate is a release-blocking metric.
2. **Workspace isolation.** All new data access goes through `toEnvelope()`,
   is scoped by `workspace_id` in the DB query (never post-fetch), and
   `service-role` stays server-only with `import "server-only"` in the DAL.
3. **Cost-aware AI.** Every new agent/model call path ships with a budget cap,
   metering (`budget-metering` conventions), and a recorded cost basis.
4. **Gates stay green.** `tsc --noEmit`, `eslint`, `next build` (32 routes),
   vitest, and Playwright smoke are required for every initiative — no
   exceptions, no "we'll fix CI later".
5. **TDD red→green** for new logic; e2e coverage for new user-visible routes.
6. **No secrets in code/tests/commits.** Keys via dashboard or local
   `.env.local` only; dummy env values in CI.
7. **Local-first verification.** Never build (`next build`) while `next dev`
   is running against the same `.next` directory (Windows file locks produce
   Franken-builds: mixed dev/prod chunks, phantom 500s). Stop dev → clean
   `.next` → build → serve. This incident is documented; the rule stands.

---

## 2. Baseline (what exists today — do not regress)

- Grounded validation agent (Exa web research → assumptions → evidence →
  verdict memo) with SSE streaming and full trace log.
- Claim verifier that refuses "validated" without primary evidence;
  unsupported-claim warnings surfaced inline.
- Workspace model with roles (owner/admin/member), invite flow, RLS.
- History (search/filter/sort/paginate, CSV export), dashboard metrics,
  admin console (overview/users/workspaces/content/analytics/ops) with
  spend tracking (metering exists, paywall does not).
- Model routing: Gemini primary pool + Groq fallback with quota-only rotation
  semantics (429/quota → rotate; 404/400/503 → fail fast).
- Eval harness (`eval/`) with assertions; production deploys on Vercel,
  Postgres on Supabase.
- Responsive mobile layouts (390/360px verified) across landing, login,
  dashboard, history, validate, admin.

---

## 3. Initiatives

Priority scale: **P0** = compete now · **P1** = differentiate · **P2** = scale & monetize.
Effort scale: **S** ≤ 5 eng-days · **M** 1–3 eng-weeks · **L** 3–6 eng-weeks
(figures assume one senior full-stack engineer, requirements frozen).

---

### F-01 · Public Shareable Validation Memos — P0 · M

**Problem.** Validation output dies inside the founder's account. There is no
artifact to share with co-founders, investors, or accelerators — and therefore
no viral loop. Every memo that is not shared is marketing spend left on the table.

**Solution.** A public, read-only, SEO-friendly memo page per validation run:
`/<locale>/m/<public_id>` rendering verdict, confidence, key evidence with
citations, and the commitment-ladder state — without exposing workspace internals,
PII, or raw tool traces.

**Scope.**
- IN: public page (SSR, no auth), per-memo `is_public` toggle + unlisted
  `public_id` (nanoid, unguessable), revocation, branded header + CTA
  ("Validate your own idea"), `noindex` until explicitly published, OG tags.
- OUT: public commenting, editing, API access to memos (see F-10), white-label.

**Technical approach.**
- Migration: `startups.public_id text unique`, `startups.is_public bool default false`,
  `startups.published_at timestamptz`; RLS: public read allowed **only** via a
  `SECURITY DEFINER` function `get_public_memo(public_id)` that returns a
  whitelisted projection (never base-table select).
- Route: `apps/web/src/app/m/[public_id]/page.tsx` (server component, cached,
  `revalidate = 3600`); share controls in validate/history UI (`share-button.tsx`).
- Abuse: rate-limit memo reads per IP (reuse `lib/rate-limit.ts`); strip PII
  from excerpts at publish time (server-side allowlist of fields).
- Analytics: `memo_views` table (public_id, referrer, day) for the growth loop.

**Acceptance criteria.**
- [ ] Unauthenticated GET of a published memo returns 200 with verdict +
      ≥3 cited evidence items; unpublished/revoked returns 404 (not 403, to
      avoid ID oracle).
- [ ] Toggling off `is_public` invalidates within 60s (cache + function).
- [ ] No workspace member list, emails, tokens, or raw traces in HTML/JSON.
- [ ] Playwright: publish → open incognito → revoke → 404.

**Risks & mitigations.**
- Scraping/PII leak → projection function + field allowlist + tests asserting
  absent keys. Scraping at scale → IP rate limits + optional CAPTCHA on spikes.
- SEO spam liability → `noindex` default; `index` only after explicit publish.

**Dependencies.** None (greenfield route + one migration).
**Success metrics.** % of runs published; referral signups per 100 published
memos; target: ≥5 within 60 days of launch.

---

### F-02 · Progressive Web App (PWA) — P0 · S

**Problem.** After the responsive milestone the product is mobile-usable but not
mobile-*present*: no installability, no icon, no offline tolerance. A native app
costs months; a PWA captures ~80% of the value in days.

**Solution.** Installable PWA: `manifest.webmanifest` (name, icons 192/512
maskable, `theme_color #080b14`, `display: standalone`), service worker caching
app-shell + static assets (never API/SSE), install prompt affordance, iOS
`apple-touch-icon` + meta, offline fallback page.

**Scope.**
- IN: manifest, SW (Workbox or hand-rolled; versioned cache, skip-while-revalidate
  for static), offline `/offline` route, install CTA.
- OUT: push notifications (future, needs keys + prefs UI), background sync.

**Technical approach.**
- `apps/web/public/manifest.webmanifest` + icons; `metadata` icons/viewport
  wiring in `layout.tsx` (viewport export already exists — extend, don't fork).
- SW registered only in production (`process.env.NODE_ENV === "production"`),
  scope `/`, excluded paths: `/api/*`, `/_next/webpack-hmr`.
- Playwright: assert manifest 200 + valid JSON; Lighthouse PWA checklist
  ≥90 in CI (budget-gated, non-blocking first month).

**Acceptance criteria.**
- [ ] Chrome install prompt fires on Android; iOS "Add to Home Screen" icon correct.
- [ ] Airplane-mode reload of a visited page shows `/offline`, not browser error.
- [ ] No SW interference with SSE streams or auth cookies (regression tests).

**Risks.** Stale-cache confusion → versioned caches + `skipWaiting`+`clientsClaim`
only on user-accepted update toast. **Dependencies.** None.
**Success metrics.** Installs/week; PWA session share; target: ≥10% of mobile
sessions within 90 days.

---

### F-03 · Automatic Landing-Page Teardown (Dogfooding Entry Point) — P0 · M

**Problem.** The strongest demo of a validation product is validating the
prospect's *own* landing page, yet today input is free-text only. Prospects
with a live page get a weaker experience than prospects with none.

**Solution.** "Paste your landing URL → get a scored teardown": fetch + render
the page server-side, extract hero/value-prop/CTA/social-proof structure,
run the existing verifier stack over its claims, and output score + concrete
fixes + evidence — reusing the LeadsPanel scoring core as the entry funnel.

**Scope.**
- IN: URL input on landing + `/teardown` route, fetch with SSRF guard
  (private-IP blocklist, redirect cap, size/time caps), readability extraction,
  claim-check pass, score card UI, "validate the business behind this page" CTA.
- OUT: JS-heavy SPA rendering (document limitation; use static HTML + note).

**Technical approach.**
- Reuse `packages/tools/fetch_page.ts` hardened: SSRF allowlist (http/https,
  public IPs only via DNS-pin check), 5s timeout, 2MB cap, 3-redirect max.
- Extraction: headings/CTA/forms/testimonials/pricing signals → structured
  `page_profile` JSON (zod-validated, stored on the run).
- Scoring prompt versioned (`teardown/v1`) with eval fixtures in `eval/`
  (5 reference pages, expected-issue recall ≥80%).
- Metering: teardown billed at 0.5 validation-unit (cheaper, capped depth).

**Acceptance criteria.**
- [ ] 5 reference landings produce score + ≥3 actionable issues each, grounded
      with page quotes (no invented copy).
- [ ] SSRF suite: `169.254.x`, `localhost`, `file://`, redirect-to-private all blocked.
- [ ] Malformed/slow pages degrade to partial teardown, never 500.

**Risks.** Fetch abuse → per-IP quotas + domain blocklist. Legal (ToS of
scraped sites) → respect robots.txt for non-user-owned domains; user asserts
ownership/permission via checkbox.
**Dependencies.** F-04 metering conventions (shared).
**Success metrics.** Teardown→signup conversion; target: ≥15% of teardowns.

---

### F-04 · Semantic Cache for Validations — P0 · M

**Problem.** The same ideas are validated repeatedly (17 near-duplicate startups
observed in one workspace). Each repeat burns full Groq/Gemini + Exa spend and
user waiting time for substantially identical output.

**Solution.** Two-tier cache: (1) exact cache on normalized idea text hash;
(2) semantic cache on embeddings (cosine ≥ threshold → reuse memo with
freshness stamp + "based on a similar validation" disclosure).

**Scope.**
- IN: normalization (lowercase, strip URLs/emojis), pgvector or external
  embeddings, hit/miss metering, TTL + invalidation on evidence-schema change,
  UI disclosure + "re-run fresh" option.
- OUT: cross-workspace reuse without explicit opt-in (privacy default: off).

**Technical approach.**
- Migration: `validation_cache(id, workspace_id, idea_hash unique per workspace,
  embedding vector, memo jsonb, model_versions, evidence_cutoff, hits, created_at)`.
- Embeddings via current provider stack; threshold tuned on eval set
  (precision ≥95% on "same idea" pairs, recall reported not gated).
- Cache key includes prompt-version + evidence-source versions (never serve
  stale-grounding memos silently: stamp `grounded_as_of`).
- Cost ledger records avoided spend (feeds F-09 unit economics).

**Acceptance criteria.**
- [ ] Identical idea → byte-comparable memo, 0 model calls, marked cached.
- [ ] Paraphrase above threshold → reused with disclosure; below → fresh run.
- [ ] Prompt/version bump invalidates affected entries (no silent reuse).
- [ ] Load test: 95th-percentile cached response <2s.

**Risks.** Wrong reuse erodes trust → conservative default threshold + always
visible disclosure + one-click fresh re-run. Embedding drift → re-embed job
on model change.
**Dependencies.** pgvector extension (or provider decision) — infra task first.
**Success metrics.** Cache-hit rate; avoided model spend/run; target: ≥30% hits
on repeat-heavy workspaces within 60 days.

---

### F-05 · Real Primary-Evidence Collection (Surveys & Interview Tracking) — P1 · L

**Problem.** "Primary evidence" today is a paste box. Founders don't lack the
*field* — they lack the *loop*: ask → collect → analyze → feed the memo.
Whoever automates this loop owns the moat.

**Solution.** Guided collection kit: (a) survey-link builder (5–7
methodology-backed questions from assumption gaps), (b) response inbox with
dedup + spam filter, (c) interview-note importer (markdown/CSV) with
claim-extraction into the evidence ladder, (d) one-click "fold into memo"
re-verification.

**Scope.**
- IN: per-run survey links (`/s/<token>` public responder page, no auth),
  responses table, claim extraction prompt (v1), memo re-run integration.
- OUT: video calls, transcription, incentives/payments to respondents.

**Technical approach.**
- Tables: `surveys`, `survey_responses` (token-scoped RLS; public insert only
  via RPC withphone/email optional + honeypot + rate limit).
- Question generation keyed to open assumptions (traceability: each question
  cites `assumption_id`).
- Claim extraction reuses verifier stack; extracted claims enter ladder at
  rung-4 (primary) only after source fields present (who/when/how-many).
- Methodology guardrails: minimum-sample warnings (<5 responses flagged
  "directional only").

**Acceptance criteria.**
- [ ] Survey built from a run's gaps in <60s; responder needs no account.
- [ ] ≥5 real responses fold into a re-run that changes ≥1 assumption status
      on the fixture run.
- [ ] Spam flood (100 bot posts) absorbed without corrupting the memo.

**Risks.** Garbage-in verdicts → sample-size gates + disclosure. Abuse of public
forms → CAPTCHA + token entropy + per-survey caps.
**Dependencies.** F-01 publication patterns (public-token handling) — reuse, don't duplicate.
**Success metrics.** % of runs with ≥1 primary source; uplift in verdict
calibration (ties to F-06).

---

### F-06 · Decision Calibration Dashboard — P1 · M

**Problem.** No competitor — and currently not us — answers "were our STOP/GO
calls right?". Without calibration, confidence scores are decoration.

**Solution.** Longitudinal tracking: scheduled founder check-ins ("where is this
startup now?"), outcome labels (shut down / pivoted / growing / exited),
calibration curves (predicted confidence vs. actual outcomes), public
methodology note.

**Scope.**
- IN: outcome check-in emails + in-app prompts at +90/+180 days, outcome table,
  calibration chart (admin + per-workspace), Brier-score trend.
- OUT: automated outcome scraping (unreliable); manual founder input only.

**Technical approach.**
- Tables: `startup_outcomes(startup_id, status, revenue_band, team_size, note,
  reported_at, source)`; RLS owner-write.
- Gentle nagging: at most 2 emails per startup per window; unsubscribe-first.
- Charts: server-computed buckets (no client-side PII); public aggregate page
  only after n≥30 labeled outcomes (anti-cherry-picking rule, documented).

**Acceptance criteria.**
- [ ] With 30+ labels, calibration curve renders with confidence intervals.
- [ ] No outcome data ever leaks across workspaces (RLS tests).
- [ ] Unsubscribe honored within 24h (tested).

**Risks.** Low response → make check-in 3 clicks max + show founder their own
history ("your 2026 in decisions" recap). Survivorship bias → disclose
methodology + response rates alongside every public number.
**Dependencies.** Email infra (shared with F-07 digests).
**Success metrics.** Label coverage (% of eligible startups); public calibration
report published (binary milestone).

---

### F-07 · Market & Competitor Watch (Continuous Validation) — P1 · L

**Problem.** Validation is sold as a session; markets move as a stream. A memo
goes stale the day a competitor reprices — and the founder never learns.

**Solution.** Watchlists per startup (competitor domains, pricing pages,
key topics) with scheduled re-checks, diffing, and alert digests; one-click
memo refresh that versions the verdict (v1 → v2 with changelog, never rewrite).

**Scope.**
- IN: watchlist CRUD, weekly Exa re-query job, change detection (hash + LLM
  significance filter to kill noise), email/in-app digest, memo versioning.
- OUT: real-time monitoring (<daily); legal-sensitive intel (non-public sources).

**Technical approach.**
- Tables: `watch_targets`, `watch_snapshots(content_hash, extracted jsonb)`,
  `watch_alerts(significance, dismissed_at)`; cron via pg_cron or Vercel Cron
  (decision recorded in implementation plan, not here).
- Significance filter prompt (v1) with eval set: 20 real diffs labeled
  signal/noise; precision ≥85% before enabling auto-email.
- Memo versions immutable (`memos` append-only; `current_memo_id` pointer).

**Acceptance criteria.**
- [ ] Competitor price change detected ≤8 days and reported with before/after quotes.
- [ ] Noise week (no material change) produces zero emails (tested with fixtures).
- [ ] Memo v1 bytes never mutate after v2 exists (immutability test).

**Risks.** Alert fatigue → significance gate + weekly digest default + per-target
mute. Crawl cost → snapshot hashing before any LLM call; LLM only on diff.
**Dependencies.** Email infra; F-04 cache (re-runs should hit cache where valid).
**Success metrics.** Watch adoption/run; digest open rate; refresh-to-paid
conversion (ties to F-09).

---

### F-08 · Arabic (MENA) Support — P1 · M

**Problem.** The product is English-only while the operator's unfair advantage
(Egypt/MENA examples, PDPL awareness, Arabic-speaking founder network) is
unserved by incumbents. RTL + Arabic grounding is a defensible niche.

**Solution.** Full Arabic track: RTL layout, Arabic UI strings (i18n infra),
Arabic-first prompts, MENA source weighting in Exa queries (regional domains,
Arabic queries), Arabic evidence citations, PDPL-compliant data story.

**Scope.**
- IN: `next-intl` (or equivalent) with `en` default + `ar` (RTL: `dir`,
  logical properties audit — no physical `ml-/mr-` leftovers), Arabic prompt
  pack v1, MENA domain allowlist for grounding, Arabic eval fixture set.
- OUT: full marketing-site translation in v1 (product first).

**Technical approach.**
- i18n keys namespaced by route; `translate="no"` on brand/code tokens
  (per Web Interface Guidelines).
- Prompts: separate versioned pack (`ar/v1`) — never machine-translate `en`
  prompts at runtime (quality + determinism).
- Grounding: dual-query (Arabic + English) with source-locale tags on citations.
- Eval: 10 Arabic-idea fixtures with MENA-grounded expectations.

**Acceptance criteria.**
- [ ] Full validation run in Arabic end-to-end (idea → memo) with Arabic memo.
- [ ] Zero mirrored-layout breakage at 390px RTL (visual checklist).
- [ ] Arabic unsupported-claim rate within 5pp of English on fixtures.

**Risks.** Translation quality → native-speaker review gate before launch.
Prompt parity drift → versioned packs + side-by-side eval on every pack change.
**Dependencies.** None.
**Success metrics.** ar-track runs/week; MENA signup share.

---

### F-09 · Plans, Quotas & Paywall (Monetization) — P2 · M

**Problem.** Spend metering exists in admin, but anyone can burn unlimited model
budget. This is a cost incident waiting for scale, not a business.

**Solution.** Tiers (Free / Pro / Team) with metered units: validations, depth
(evidence count), watch targets, seats. Stripe subscriptions + usage-based
overages; hard stops with graceful degradation (cached/lite runs offered).

**Scope.**
- IN: `plans`, `subscriptions`, `entitlements` (cached per request, <10ms),
  checkout portal, quota-exhausted UX (never a raw 402 during a run — checkpoint
  + resume after upgrade), invoices.
- OUT: custom enterprise contracts in v1 (manual via admin flag).

**Technical approach.**
- Entitlement check in DAL (`requireQuota(action)`) — same layer as auth gates,
  tested like auth gates. Stripe webhooks idempotent (`event_id` dedup table).
- Unit model: 1 validation-unit = standard run; teardown = 0.5; refresh = 0.5;
  cache hits = 0.1 (still metered: anti-abuse).
- Free tier designed from F-04 data (hits subsidize free users).

**Acceptance criteria.**
- [ ] Quota-exhausted mid-run checkpoints state; post-upgrade resumes (e2e).
- [ ] Webhook replay storm creates exactly one subscription (dedup test).
- [ ] Admin can grant/revoke manually with audit row (ties to ops audit).

**Risks.** False declines → checkpoint/resume + support override path. Gaming
(cache-hit farming) → 0.1-unit floor + anomaly alerts.
**Dependencies.** F-04 (unit economics input). Email receipts (shared infra).
**Success metrics.** Free→paid %; gross margin per validation; target: margin
positive on Pro within one quarter.

---

### F-10 · Developer API + Public Verifier Leaderboard — P2 · M

**Problem.** Accelerators, funds, and tool-builders can't embed validation; and
our best technical asset (verifier precision) has no public proof.

**Solution.** (a) Versioned REST API (`/v1/validations`, `/v1/memos`,
webhooks on completion) with keys + scopes. (b) Public leaderboard: verifier
precision/recall and hallucination rate on a frozen public benchmark, updated
per model-pack release.

**Scope.**
- IN: API keys (prefix + hash, scopes `read`/`run`), docs + OpenAPI, rate
  limits per key, webhook signatures (HMAC), benchmark repo public with frozen
  fixtures.
- OUT: SLA guarantees in v1; white-label UI.

**Technical approach.**
- Keys: `vcp_live_` prefix, SHA-256 stored, last-4 shown; rotation + instant
  revoke; per-key metering reusing F-09 units.
- Benchmark: frozen fixture set in-repo, CI-run per prompt-pack change;
  leaderboard page SSR from results table (append-only, signed runs).
- Never expose workspace data via API beyond key's scope (scope tests mirror
  RLS tests).

**Acceptance criteria.**
- [ ] Third-party script can run validation → webhook → fetch memo with key only.
- [ ] Revoked key fails closed within 60s.
- [ ] Benchmark reproducible: same fixtures + same pack = same scores (±noise documented).

**Risks.** Key leak blast radius → scopes + spend caps per key + anomaly auto-
revoke. Benchmark gaming → frozen fixtures + hidden holdout split.
**Dependencies.** F-09 metering.
**Success metrics.** API design partners (target: 3); leaderboard cited externally.

---

## 4. Cross-Cutting Requirements (apply to every F)

1. **Security & privacy.** RLS on every new table with owner/workspace tests;
   `SECURITY DEFINER` functions minimal + audited; public surfaces get
   abuse tests (spam, scraping, SSRF, ID oracles) before launch.
2. **Cost control.** New model/LLM path ships with: unit cost table, cap,
   meter, and an eval-set cost ceiling. No uncapped loops.
3. **Observability.** Structured logs with run/workspace IDs; new alerts for
   error-rate and spend anomalies; dashboards before launch, not after.
4. **Data & migrations.** Backward-compatible migrations only (expand →
   migrate → contract); every migration reviewed for RLS + index impact;
   seed/rollback notes in the migration file.
5. **Quality gates.** tsc, eslint, build, vitest (new logic), Playwright (new
   routes/states), mobile 390px check for UI work, Web Interface Guidelines
   pass for new components.
6. **Docs.** User-facing change → docs update in the same PR; API change →
   OpenAPI + changelog; prompt-pack change → version + eval diff attached.

## 5. Suggested Sequencing

| Phase | Initiatives | Rationale |
|-------|-------------|-----------|
| **Wave 1** (months 1–2) | F-04 → F-01 → F-02 | Cut unit cost first (funds everything else), then growth loop, then mobile presence. F-04's savings directly improve F-09 pricing later. |
| **Wave 2** (months 3–4) | F-03 → F-05 → F-08 | Entry funnel + primary-evidence moat + MENA niche; F-03 feeds F-05 (teardown users need evidence). |
| **Wave 3** (months 5–6) | F-09 → F-07 → F-06 → F-10 | Monetize (needs F-04 economics), then retention (watch), then proof (calibration), then platform (API). |

Sequencing is advisory; dependencies (noted per initiative) are mandatory.

## 6. Decisions Needed Before Approval

1. Pricing units and free-tier size (needs F-04 measured costs — decide after F-04).
2. Cron/queue substrate for F-07 (pg_cron vs. Vercel Cron vs. external worker).
3. Embeddings home for F-04 (pgvector on Supabase vs. provider API).
4. Email provider for digests/check-ins/receipts (single provider for F-06/F-07/F-09).
5. Public benchmark scope and holdout policy for F-10.
6. Arabic launch bar: native-speaker reviewer identified (F-08 gate).

## 7. Glossary

- **Grounded / مؤرض:** backed by retrievable external evidence with citations.
- **Verifier:** the claim-checking pass that withholds "validated" status.
- **Evidence ladder:** runged evidence hierarchy (primary user data outranks secondary reports).
- **Validation-unit:** internal cost unit (1.0 = standard run; see F-09).
- **Franken-build:** mixed dev/prod `.next` artifacts from building while dev
  runs — causes phantom 500s; prevented by the §1.2(7) rule.
- **PDPL:** Personal Data Protection Law (Egypt/MENA context for F-08 messaging).

---

*End of roadmap v0.1.0. Status: PROPOSED. Next step: review §6 decisions, then
approve Wave 1 with owners and dates.*
