---
name: evidence-quality-coach
description: >
  Deep guidance on evidence quality, the commitment ladder, anti-hallucination rules, and how to distinguish real validation signals from false positives. Use this skill when analyzing founder-submitted evidence, when the response-analyzer skill needs to classify signals, when the decision-memo skill is computing confidence levels, or when coaching a founder on what counts as real validation. Triggers on: evidence quality, commitment ladder, validation, primary evidence, secondary evidence, false positive, compliment vs commitment, Mom Test, Sean Ellis, RACS score, confidence level.
---

# Evidence Quality Coach — Agent Skill

Authoritative reference for evidence quality assessment in the Validation Copilot. This skill prevents the single most common and costly agent error: treating positive signals as validation when they are not.

---

## 1. The Commitment Ladder (The Core Framework)

Every piece of evidence must be classified on this 5-rung ladder. The ladder is enforced in code — the decision-memo skill cannot output 'Go' without Rung 4+ evidence.

| Rung | Label | Description | Example |
|------|-------|-------------|---------|
| 1 | Opinion | Verbal or written sentiment with no action taken | 'That sounds cool!' / 'I would probably use that' |
| 2 | Stated Future Intent | Explicit statement of intended future behavior | 'I would definitely subscribe to that' / 'Yes, we need this' |
| 3 | Time Given | Respondent invested real time: agreed to interview, completed multi-question survey | Booked a 30-min call / filled out a 10-question form |
| 4 | Contact Info Shared Voluntarily | Gave email, phone, or LinkedIn without being required to | 'Put me on the waitlist' / signed up on a landing page |
| 5 | Money or Hard Commitment | Pre-order, deposit, signed LOI, paid invoice, actual product usage | Paid $50 pre-order / signed letter of intent / used product for 30+ days |

### The Bayesian Weight of Each Rung
- Rung 5 confirming assumption: 5.0x update toward belief (strong)
- Rung 3-4 confirming assumption: 2.0x update toward belief
- Rung 3-4 CONTRADICTING assumption: 0.3x update (strong push against belief)
- Rung 1-2 (either direction): 1.0x — no update; noise

**Critical insight:** One Rung 5 contradiction (someone cancels a pre-order, refuses to pay) can wipe out 10 enthusiastic Rung 1 compliments. Contradicting commitment signals carry maximum weight.

---

## 2. Secondary vs. Primary Evidence

### Secondary Evidence (Desk Research)
Definition: Information gathered without direct contact with potential customers.
Sources: grounded_search (web), competitor pages, industry reports, Apollo prospect counts.
Role: Forms hypotheses. Helps size the market. Identifies competitors.
Limitation: NEVER sufficient alone to declare an assumption validated, regardless of how much of it you have.

### Primary Evidence (Real People)
Definition: Data collected directly from actual prospective customers.
Sources: Interviews, surveys, sign-ups, pre-orders, usage data, uploaded founder notes.
Role: Tests hypotheses. The only evidence that can unlock a 'Go' verdict.
Minimum threshold for any conclusion: n >= 15 respondents (n < 15 = 'Test More' automatically)

**The Hard Rule (enforced in code, not just prompts):**
The system may NEVER output 'validated' or 'strong Go' based on:
- Secondary evidence alone
- Primary evidence below Rung 3
- Sample size below the threshold (n=30 quantitative, n=12 saturated interviews)
If evidence is thin, the correct output is 'Test More' + named next experiment.

---

## 3. The Mom Test Principles (Anti-False-Positive Rules)

The Mom Test (Rob Fitzpatrick) defines how to avoid getting polite lies instead of real signals:

### Rule 1: Talk About Their Life, Not Your Idea
BAD: 'Would you use an app that helps you manage your freelance invoices?'
GOOD: 'Walk me through how you currently handle invoicing. What's the most frustrating part?'

### Rule 2: Ask About Specifics from the Past, Not Hypotheticals
BAD: 'Would you pay $20/month for this feature?'
GOOD: 'Have you ever paid for a tool to solve this problem? What did you pay? Why did you stop using it?'

### Rule 3: Compliments are Not Data
WRONG classification: 'She said it was a great idea' = Rung 4
CORRECT classification: 'She said it was a great idea' = Rung 1 (opinion only)
CORRECT Rung 4 signal: 'She asked to be put on the waitlist and gave her email'

### Rule 4: Dig Into Bad News
If someone expresses hesitation or doubt, that is the most valuable signal in the conversation.
A contradicting signal at Rung 3+ is worth more than 20 enthusiastic Rung 1 opinions.

---

## 4. Anti-Hallucination Evidence Rules

These rules are enforced at the Verifier layer AND in agent reasoning:

### For Secondary Evidence (market-research skill)
- Every factual claim about market size, competitors, or pricing MUST carry a source URL from grounded_search
- Claims with no URL are labeled 'insufficient evidence' — never asserted as fact
- Apollo prospect_search counts are cited as: 'Apollo data shows approximately X companies matching [ICP criteria]'
- Model may never invent a market size number. If grounded_search returns no result, output: 'Market size data unavailable — recommend manual research'

### For Primary Evidence (response-analyzer skill)
- All percentages and rates are computed by the stats tool, never estimated by the model
- Response rate = (replies received / messages sent) — never 'approximately' or 'around'
- Sean Ellis PMF score = % who answered 'very disappointed' — computed exactly from uploaded data
- If sample size < 15, the model must flag this before any analysis: 'Warning: n=[X] is below the minimum threshold of 15 for reliable conclusions'

### For Decision Memos (decision-memo skill)
- RACS score must be calculated using the formula in the decision-memo playbook, not estimated
- Confidence level must match the evidence level — if evidence is Rung 1-2 only, confidence is 'Insufficient' regardless of how positive the signals are
- Contradicting signals section cannot be omitted. If none found, state explicitly: 'No contradicting signals detected — flag for potential cherry-picking bias'

---

## 5. Go Verdict Requirements (Hard Gates)

ALL of the following must be satisfied before the agent can output any 'Go' verdict:
- Gate 1: At least 1 primary evidence item at Rung 4+ (contact shared OR financial commitment)
- Gate 2: Rung 4+ evidence from at least 3 independent respondents (not the same person)
- Gate 3: Sample size >= 30 for quantitative data OR >= 12 interviews reaching thematic saturation
- Gate 4: PMF Score >= 40% (Sean Ellis) if product has been used by real users
- Gate 5: Zero critical business model risks unaddressed (channel, pricing, CAC/LTV ratio must be tested)

If ANY gate fails, the verdict is either 'Iterate', 'Test More', or 'Stop' — never 'Go'.

---

## 6. Stop Verdict Triggers

ANY of the following is sufficient to output 'Stop':
- Evidence clearly shows the problem does NOT exist at scale (n >= 15, less than 20% frequency)
- Market size confirmed less than $10M TAM with no adjacent markets identified
- 3 or more Rung 4+ signals explicitly REJECTING the solution or switching back to status quo
- Core economic unit broken: CAC > LTV by more than 3x with no credible path to improvement

---

## 7. Common Anti-Patterns (Auto-Flagged by Agent)

| Anti-Pattern | Detection | Required Action |
|-------------|-----------|-----------------|
| 'Users seem excited about this' | No Rung 3+ evidence cited | BLOCK — request evidence upgrade |
| 'Go' based on secondary research alone | No primary interview/behavioral data | HARD BLOCK |
| Omitting contradicting signals | Zero contradictions in memo | FLAG — require explicit confirmation |
| 'Iterate' with no specific iteration hypothesis | Vague 'we need to improve' | REJECT — demand specific pivot type from 9-quadrant taxonomy |
| Calling 5 enthusiastic responses 'validated' | n < 15, all Rung 1-2 | AUTO-DOWNGRADE to 'Test More' |
| Confidence does not match evidence level | High confidence with Low evidence | NORMALIZE confidence to match RACS score |
| Hypothetical survey questions only | No past-behavior questions present | FLAG for survey-designer validator |

---

## 8. RACS Score (Risk-Adjusted Confidence Score)

Formula:
RACS = (Evidence_Weight x 0.5) + (Sample_Coverage x 0.3) + (Assumption_Risk_Clearance x 0.2)

Where:
- Evidence_Weight = Average commitment ladder rung of all primary evidence (1-5)
- Sample_Coverage = min(n/30, 1.0) — maxes at 1.0 at n=30+
- Assumption_Risk_Clearance = Percentage of Tier 1 (kill-zone) assumptions with Rung 3+ evidence

Score Interpretation:
- 0.75 - 1.0: High Confidence
- 0.50 - 0.74: Medium Confidence
- 0.25 - 0.49: Low Confidence
- 0.00 - 0.24: Insufficient — output 'Test More'

---

*This skill maps directly to the response-analyzer and decision-memo skills in the Validation Copilot. Reference spec Section 5.3 (Evidence Model) and Section 12 (Anti-Hallucination) for enforcement details.*

## Grounding persistence rule
Ungrounded synthesis output is NEVER evidence: rows without a tool-returned
http(s) URL persist only as `grounding_status='unverified'`, are withheld
from the decision memo and the verifier support set, and render as
"Unverified — not evidence". A numeric market claim without a cited URL is
dropped from grounding, never softened.
