# Validation Copilot — Skill: response-analyzer
**Version:** 2.0 | **Framework:** Grounded Theory + Mom Test Signal Filtering + Sean Ellis PMF Score

---

## Purpose
Transform raw interview transcripts, survey data, and behavioral logs into **objective, evidence-graded, bias-free validation signals**. Kill founder confirmation bias before it corrupts decisions.

---

## Core Principle: The Signal Hierarchy

Not all customer words are equal. The Response Analyzer applies a strict **Signal Hierarchy** to every piece of data:

```
Tier S  →  Rung 5 (Financial / Hard Commitment)          → Weight: 1.0x  [GOLD]
Tier A  →  Rung 4 (Contact Shared / Referral Given)      → Weight: 0.8x  [STRONG]
Tier B  →  Rung 3 (Time Invested / Follow-up requested)  → Weight: 0.6x  [MODERATE]
Tier C  →  Rung 2 (Stated Behavioral Intent)             → Weight: 0.3x  [WEAK]
Tier D  →  Rung 1 (Opinion / Emotional Reaction)        → Weight: 0.0x  [NOISE]
```

> **Critical Rule:** Compliments, enthusiasm, and "Great idea!" are Rung 1 — zero weight evidence. They MUST be stripped from validation scoring.

---

## Signal-to-Noise Separation Engine

### Phase 1: Noise Elimination (Pre-Processing)
Strip the following patterns from all transcripts before scoring:

| Pattern | Examples | Action |
|---------|----------|--------|
| Social Pleasantry | "That's amazing!", "Love this!" | Remove from evidence pool |
| Hypothetical Agreement | "I would definitely use that" | Downgrade to Rung 2 max |
| Feature Request (Unanchored) | "You should add X" | Log as signal, not validation |
| Polite Deflection | "Interesting, I'll think about it" | Mark as Rung 0 rejection signal |
| Recency Bias Phrasing | "Just last week, I was thinking..." | Flag for temporal anchoring check |

### Phase 2: Behavioral Story Extraction (JTBD Protocol)
For every interview, extract the **Jobs-to-Be-Done story arc**:

```
SITUATION:  What was happening when the problem occurred?
MOTIVATION: Why did they need to solve it? (functional, social, emotional job)
ACTION:     What did they actually do? (current workaround / solution)
OUTCOME:    What happened? Were they satisfied? What was the cost?
```

> **Golden Moment:** If they describe a specific past incident with a workaround they paid for in time or money — that is Tier A/S evidence.

### Phase 3: Commitment Ladder Classification
Classify every statement into the Commitment Ladder:

| Rung | Signal Type | Example Quote | Weight |
|------|------------|---------------|--------|
| 5 | Pre-order / Payment / Contract | "Here's my credit card" / "We signed an LOI" | 1.0x |
| 4 | Intro Given / Contact Shared | "Talk to my CFO" / "Let me cc my team" | 0.8x |
| 3 | Time Invested / Follow-up Requested | "Can we schedule another call?" / "Send me the report" | 0.6x |
| 2 | Stated Intent | "I'd pay $X for that" / "We'd switch from Y" | 0.3x |
| 1 | Opinion / Emotion | "That sounds great!" / "I hate this problem" | 0.0x |

---

## Quantitative Scoring Systems

### Sean Ellis PMF Score (Survey Cohort)
**Question:** "How would you feel if you could no longer use [solution]?"
- A = Very Disappointed
- B = Somewhat Disappointed
- C = Not Disappointed
- D = N/A (never tried it)

**Formula:**
```
PMF Score = (Count_A / Total_Valid_Responses) × 100
Valid responses = exclude D (N/A)
PMF Threshold: ≥ 40% → Early PMF signal | 25-39% → Iterate | < 25% → Insufficient
```

### Net Promoter Score (NPS)
```
Promoters   = responses 9-10
Detractors  = responses 0-6
Passives    = responses 7-8

NPS = ((Promoters - Detractors) / Total) × 100
Benchmark: > 50 = Excellent | 30-49 = Good | 0-29 = Neutral | < 0 = Danger
```

### Problem Severity Score (Custom)
```
Score = (Frequency × 0.4) + (Intensity × 0.4) + (Workaround_Cost × 0.2)
Where:
  Frequency       = How often does the problem occur? (1=Rarely, 5=Daily)
  Intensity       = How bad is it when it does? (1=Minor, 5=Business-Critical)
  Workaround_Cost = What do they spend to work around it? ($0=1, >$1000/mo=5)

Score > 3.5 → High-priority problem worth solving
Score 2.0-3.5 → Medium-priority — needs more discovery
Score < 2.0 → Low-priority — may not be a real problem
```

### Statistical Significance Gates
| Metric | Minimum Sample | Warning Threshold | Valid Threshold |
|--------|--------------|-------------------|-----------------|
| Survey PMF Score | n=15 | 15-29 (flag) | ≥30 (valid) |
| NPS Calculation | n=10 | 10-19 (flag) | ≥20 (valid) |
| Interview Saturation | n=5 | 5-9 (flag) | ≥10 (saturated) |
| A/B Test Conversion | n=100/variant | 50-99 (insufficient) | ≥100 (valid) |

> **MANDATORY:** All scores calculated via deterministic math tools. LLM prose estimations of percentages are FORBIDDEN.

---

## Thematic Analysis Protocol (Grounded Theory Lite)

### Step 1: Open Coding
Tag every meaningful statement with a descriptor:
- `PAIN:[specific pain]` — confirms a problem
- `WORKAROUND:[current solution]` — reveals active behavior
- `TRIGGER:[event that causes problem]` — maps the context
- `GOAL:[outcome they want]` — surfaces the real job
- `COST:[time/money/effort currently spent]` — quantifies urgency

### Step 2: Axial Coding (Pattern Clustering)
Group open codes into themes. A theme is valid only when:
- It appears in ≥ 3 independent interviews (or ≥ 15% of survey respondents)
- It includes at least one Rung 3+ commitment signal

### Step 3: Saturation Detection
Declare **thematic saturation** when:
- Last 3 consecutive interviews produced 0 new themes
- OR n≥12 for a well-defined ICP segment
- OR n≥25 for a broad consumer segment

---

## Confirmation Bias Detection (5-Layer Filter)

| Bias Type | Detection Method | Correction |
|-----------|-----------------|------------|
| **Cherry-Picking** | Count total negative signals — if none found, flag for re-review | Force-document all contradictory quotes |
| **Hypothetical Inflation** | Identify all "would/could/might" language | Downgrade to Rung 2 max |
| **Leading Question Contamination** | Flag if question contains solution mention | Invalidate response, mark as tainted |
| **Small Sample Overconfidence** | Auto-warn if n<15 for PMF scoring | Add mandatory disclaimer to report |
| **Recency Bias** | Flag if >60% of quotes are from last 2 interviews | Weight older interviews equally |

---

## Output Structure (Evidence Report)

```json
{
  "evidenceReport": {
    "assumptionTested": "string",
    "sampleSize": "number",
    "saturationReached": "boolean",
    "pmfScore": "number | null",
    "npsScore": "number | null",
    "problemSeverityScore": "number",
    "commitmentLadderBreakdown": {
      "rung5": "number",
      "rung4": "number",
      "rung3": "number",
      "rung2": "number",
      "rung1": "number"
    },
    "keyThemes": [
      {
        "theme": "string",
        "frequency": "number",
        "representativeQuotes": ["string"],
        "highestRungEvidence": "number"
      }
    ],
    "biasFlags": ["string"],
    "confirmedInsights": ["string"],
    "contradictingSignals": ["string"],
    "recommendedVerdictInput": "Go | Iterate | Stop | Test More"
  }
}
```

---

## Acceptance Criteria
1. All Rung 1 (compliment/opinion) evidence stripped from primary validation score
2. JTBD story extracted for ≥ 50% of interview subjects
3. PMF and NPS scores calculated deterministically (not estimated)
4. Sample size warnings applied wherever n is below threshold
5. Confirmation bias filter applied — contradicting signals explicitly documented
6. Output JSON conforms to `evidenceReport` schema above
7. Thematic saturation status declared (reached / not yet reached / approaching)

