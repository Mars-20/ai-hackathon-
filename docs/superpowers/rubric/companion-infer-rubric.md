# Companion inference rubric R (spec §11, plan Task 6)

Method: each fixture feeds raw LLM JSON through
`parseExtractionResult` → `filterExtractionCandidates`
(secret scan → third-party-PII scan with the user's own contact allowlisted →
approved-dupe suppress → within-batch dupe suppress).
`pass` = kept values exactly equal `expect`.
Bar: **≥24/30 pass AND zero secret-bearing values in any kept set**
(hard per-fixture assertion, not an aggregate).
Measured at Task 6 commit: **30/30, zero secret flags**.

Fixtures mirror `apps/web/src/lib/__tests__/companion-infer.test.ts`
(single executable source; this file is the human-readable record).

| # | name | expectation |
|---|------|-------------|
| 1 | keep-preference | kept (kind preference, conf 0.9) |
| 2 | keep-fact | kept (kind fact, conf 0.85) |
| 3 | keep-constraint | kept as preference (no `constraint` kind in vocabulary) |
| 4 | keep-episode | kept (kind episode, conf 0.75) |
| 5 | threshold-edge-keep | kept (conf exactly 0.7) |
| 6 | threshold-drop | dropped (conf 0.62 < 0.7) |
| 7 | threshold-drop-low | dropped (conf 0.3) |
| 8 | secret-sk | dropped (`sk-live` secret scan) |
| 9 | secret-aws | dropped (`AKIA` secret scan) |
| 10 | secret-private-key | dropped (private-key secret scan) |
| 11 | secret-github | dropped (`ghp_` secret scan) |
| 12 | pii-third-party-email | dropped (third-party email) |
| 13 | pii-phone | dropped (third-party phone) |
| 14 | self-email-kept | kept (own contact is allowlisted) |
| 15 | dupe-approved-exact | dropped (exact approved dupe) |
| 16 | dupe-approved-normalized | dropped (tanween-normalized approved dupe) |
| 17 | near-miss-kept | kept (near-miss is NOT a dupe) |
| 18 | within-batch-dupe | kept once (batch-internal dupe suppressed) |
| 19 | malformed-nonjson | dropped (unparsable, no throw) |
| 20 | malformed-not-array | dropped (top-level object, no throw) |
| 21 | malformed-missing-kind | dropped |
| 22 | malformed-missing-value | dropped |
| 23 | malformed-bad-kind | dropped (`secret` outside vocabulary) |
| 24 | malformed-confidence-string | dropped (non-numeric confidence) |
| 25 | malformed-empty-value | dropped (blank after trim) |
| 26 | malformed-overlong | dropped (501 chars > DB CHECK 500) |
| 27 | fenced-json | kept (```json fences stripped) |
| 28 | mixed-batch | 1 kept, 0.62 + secret dropped |
| 29 | multi-keep | both kept (distinct values) |
| 30 | conflict-near-miss-kept | kept by inference; `flagPossibleConflicts` fires so Task 7 surfaces it at decide time |

Kind vocabulary is FIXED to `fact | preference | style | episode`
(DB CHECK + `memoryKindSchema`); fixture expectations use only these kinds.
