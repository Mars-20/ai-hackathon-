# Task 6 Report — Search/History counts+order

## Status
Complete. Commit `985e098` on main. TDD RED→GREEN observed (5 fail → 8 pass).

## What changed (zod untouched — T1 owns parse)
- `apps/web/src/app/api/search/route.ts`
  - Real DB counts: `count:"exact"` per type; `total_hits` is now the DB total
    (was the sliced-page sum); new `counts:{startups,assumptions,evidence}`.
  - Chronological order: `.order(created_at desc)` startups/assumptions,
    `.order(collected_at desc)` evidence (evidence has no `created_at`);
    similarity re-rank keeps relevance first with newest-first tie-break.
  - Pagination: manual `page` parse (no schema change) + `.range()` in DB;
    new `meta:{total,page,limit,pages}` (pages covers largest per-type count).
  - Workspace isolation unchanged (`.in(workspace_id)` / `startups!inner`);
    empty-workspace reply now carries the full shape (additive).
  - Thin-evidence: nothing excluded/re-weighted (T7 owns counting rules).
- `apps/web/src/app/api/history/route.ts`
  - Deterministic tie-break `.order("id")` after primary sort;
    non-mutating latest-decision pick; `count ?? 0`.
  - DB count / `range()` pagination / isolation were already correct — kept.
- `apps/web/src/app/api/__tests__/search-history.test.ts` (new, 8 tests):
  DB-total-vs-slice, page-2 range, DB order, tie-break, isolation ×2,
  history total/pages from count, history tie-break order.

## Verification
- RED: 5 failed / 3 passed before the fix (isolation + history-count already green).
- GREEN: `npx vitest run` → 5 files, 52/52 passed; `npx tsc --noEmit` clean.
- UI compat: `history/page.tsx` reads `data/meta` (unchanged);
  global search reads `results.*` (preserved, additive fields only).

## Concerns
- Search `pages` semantics: types paginate independently, so pages = largest
  per-type count / limit — document if a combined feed is ever assumed.
- No live-DB check: counts/order verified against PostgREST mock contract,
  not a real Supabase instance.
- `from`/`to` date strings still unvalidated (T1 deferred minor) — out of scope.

## Fix R1/5 — review round 1, 3 items (zod untouched)
- (1) pages/total consistency: `meta.pages` is now `ceil(total/limit)` where
  `total = sum(per-type DB counts)` — same basis, documented in route header.
  The old `ceil(max/limit)` survives as `meta.pages_per_type` (deepest
  single-type feed; identical to `pages` for single-type queries), so per-type
  clients keep their sizing. Empty-workspace shape carries both (0/0).
- (2) rank-then-slice: each type now fetches candidate window
  `.range(0, min(offset+limit-1, RANK_WINDOW-1))` (RANK_WINDOW=200, chrono
  seed), re-ranks the window by bigram-Dice relevance (newest-first
  tie-break), then `.slice(offset, offset+limit)` for the page. Relevance is
  global within the first 200 matches per type (documented limit); counts stay
  exact regardless of window.
- (3) history order boolean: `const ascending = orderStr === "asc"` replaces
  the `order`-named boolean; both `.order(sortCol, {ascending})` and the `id`
  tie-break use it — no string/bool confusion.
- Tests (+3, 8→11 in file): pages/pages_per_type contract, window fetch
  `[0,3]` for page-2/limit-2, globally-ranked page-2 tail, history asc/desc
  explicit-boolean asserts. Old page-2 `[2,3]` expectation updated to the
  window contract.

## Verification (R1/5)
- `npx vitest run` (apps/web) → 5 files, 55/55 passed.
- `npx tsc --noEmit` (apps/web) → clean.
- `git diff --stat` confirms `apps/web/src/lib/validation.ts` untouched (zod parse owned by T1).
