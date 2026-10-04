# Demo Script — Validation Copilot (Spec §17, v2.3)

> Source of truth for the live demo. The golden path is spec §3; the 7 beats
> below are spec §17 verbatim in order. Total time: ~10–12 minutes + Q&A.
> Rehearse out loud twice on the actual presentation hardware (§16).

## Pre-demo checklist (Day-3-proof)

- [ ] Paid Gemini key live (`GEMINI_API_KEY` — free tier 429s mid-demo, §6.1).
- [ ] Groq key live (`GROQ_API_KEY` — router/classifier, §6.2).
- [ ] Supabase project with migrations `0000`–`0008` applied in order
      (see `docs/runbook-validation.md` §1; backfill `0006`, NOT NULL verify `0008`).
- [ ] Logged in as the demo founder (dashboard is auth-required — anon/demo
      single-tenant mode was considered and rejected, §14 resolved OPENs).
- [ ] One fresh startup slot ready + one pre-run startup with history
      (for Beat 6 continuity — do NOT run Beat 2's idea beforehand).
- [ ] Fail-safe video: TODO-human — record one full golden-path run and paste
      the link here. No video has been recorded yet; do NOT present a
      recording as live (§17 fail-safe rule).

**Fail-safe video link:** `TODO-human: paste link after recording (one full golden-path run).`

---

## Beat 1 — Open with the founder's real problem (~1 min)

Say why this exists before showing anything: founders fail on validation, not
execution — building on opinions and polite lies instead of evidence. The two
skipped steps this product forces: structured assumption testing before
building, and primary evidence from real, consenting people (§2). One line on
personal motivation (two prior startups, PMF was the costliest problem) — then
move. No slides; the product is the pitch.

## Beat 2 — Run the golden path live (~4 min)

Use a real idea — ideally one of the founder's own past startups, so the
outcome can be sanity-checked against what actually happened (§17.2):

1. Paste free text into intake (`/validate`) — point out the extracted domain,
   target customer, stage, business model (`startup-intake` skill).
2. Show the risk-ranked assumption map — desirability / viability / feasibility
   with the riskiest assumption on top (`assumption-mapping`).
3. Run grounded market research on the riskiest assumption — every claim must
   carry a citation or be labeled "insufficient evidence" (`market-research`
   + `google_search` grounding, §12).
4. Open the decision memo — verdict (Go / Iterate / Stop / Test More) with an
   explicit confidence tier and the next cheapest experiment (`decision-memo`).

If any step stalls (rate limit, slow grounding): say so plainly, move to the
fail-safe video — never fake a live run.

## Beat 3 — Show the trace panel as it runs (~1.5 min)

With the run visible, open the trace panel: sources, tool calls, verifier
checks, per-task cost/latency (`trace_events`). This is the live proof against
hallucination — not a claim, a log (§17.3). Point at one Verifier check that
ran and one cost line under the per-task budget cap (§6.3).

## Beat 4 — Trigger the planted-error case on purpose (~1.5 min)

Feed the system a deliberately leading survey question (or reference the
golden-task report): `survey-designer` must visibly reject it — screenshot
moment (§16, Block 6). Then cite the planted-unsupported-claim catch: the
Verifier strips or flags what it cannot match to a source (§12, §13 metrics:
planted-error catch rate, leading-question catch rate). This beat is the
thesis: a generic chatbot would have answered; this system refuses.

## Beat 5 — Show a second idea from a different domain (~1 min)

Run a second, clearly different-domain idea through the same skills with no new
code — methodology generalizes because domain knowledge is fetched at run time
via grounded search, not retrained (§1, §17.5). Keep it to intake + assumption
map; depth was already proven in Beat 2.

## Beat 6 — Reopen the first idea: continuity (~1 min)

Close and reopen the first startup: saved assumptions and decision history are
already there (§5.4). Say the line once: "a co-founder that remembers you."
This is the cheapest proof of the continuity layer HERMAS will later own
across packs (§5.0 — full HERMAS loop deferred, shared-table continuity now).

## Beat 7 — Close with metrics + roadmap (~1.5 min)

Show the real Section 13 numbers from the golden-task run (8–12 tasks across
2–3 domains minimum, §16 Block 9): citation coverage, unsupported-claim rate,
planted-error catch rate, leading-question catch rate, latency/cost per task.
Real numbers only — never placeholders (§16). Then frame the roadmap: "Skill
Pack #1 works — Brand & Identity, Customer Communication, and Business Health
plug into the same runtime next" (§4.1). Close on scope discipline: Day 3 was
proof and rehearsal only, never new capability (§16/§18).

---

## Spoken fallback line (say verbatim if going to video)

> "The live run hit a snag — here is one full successful golden-path run I
> recorded earlier, so you can see exactly what just worked. I will say
> plainly: this is the recording, not the live run."

## Never cut (even if running long)

The Verifier, the leading-question validator, the evidence-strength
distinction (§16). Cut instead, in order: golden-task count (never below 6,
never zero) → domain coverage (2 domains instead of 3) → dashboard polish.
