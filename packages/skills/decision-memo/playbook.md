# Validation Copilot — Skill: decision-memo
**Version:** 2.0 | **Framework:** Bayesian Evidence Weighting + Sequoia Decision Logic + Lean Startup Pivot/Persevere

---

## Purpose
Produce an **honest, evidence-backed, investor-grade Go / Iterate / Stop / Test More verdict** with a Risk-Adjusted Confidence Score. Force intellectual honesty. Eliminate optimism bias before it wastes capital.

---

## ⚠️ Hard Evidence Gates (Enforced in Code, Not Just Prompts)

### Gate 1: "Go" Verdict Requirements (ALL must be satisfied)
- [ ] ≥1 primary evidence item at **Rung 4+** (contact shared OR financial commitment)
- [ ] Rung 4+ evidence from **≥3 independent respondents**
- [ ] Sample size ≥ **30** for quantitative data OR ≥ **12** interviews reaching thematic saturation
- [ ] **PMF Score ≥ 40%** (Sean Ellis) if product has been used
- [ ] **Zero critical business model risks** unaddressed (channel, pricing, CAC/LTV ratio)

### Gate 2: "Stop" Verdict Requirements (ANY is sufficient)
- Evidence clearly shows the problem **does not exist at scale** (n≥15, <20% frequency)
- **Market size confirmed < $10M TAM** and no adjacent markets identified
- ≥3 rung 4+ signals explicitly **rejecting the solution** or switching back to status quo
- Core economic unit (CAC > LTV by >3x with no path to improvement)

### Gate 3: Confidence Level Rules
| Confidence | Evidence Required |
|------------|------------------|
| **High** | Rung 5 (commitment) from ≥3 independent sources, n≥30, PMF≥40% |
| **Medium** | Rung 3-4 from ≥5 sources, n≥15, PMF 25-39% |
| **Low** | Only secondary/rung 1-2 primary evidence, n<15 |
| **Insufficient** | Cannot assign confidence — output "Test More" + next experiment |

> **Rule:** If evidence is thin, the ONLY correct output is "Test More" + **named** next experiment. An inflated "Iterate" verdict to avoid bad news is a failure of this skill.

---

## Verdict Taxonomy

| Verdict | Definition | Required Evidence |
|---------|-----------|-------------------|
| **🟢 Go** | Strong signal; riskiest assumptions tested; PMF signal present; build with confidence | Gates 1 fully satisfied |
| **🟡 Iterate** | Some validation but specific adjustments needed (ICP, pricing, channel, positioning) | Rung 3+ from ≥5 sources; clear iteration hypothesis |
| **🔴 Stop** | Core assumption invalidated; do not invest further resources here | Gate 2 triggered |
| **🔵 Test More** | Insufficient data; cannot make a reliable decision yet | n<15 or no Rung 3+ signals |

---

## Risk-Adjusted Confidence Score (RACS)

**Formula:**
```
RACS = (Evidence_Weight × 0.5) + (Sample_Coverage × 0.3) + (Assumption_Risk_Clearance × 0.2)

Evidence_Weight         = Avg commitment ladder rung of all primary evidence (1-5)
Sample_Coverage         = min(n/30, 1.0) — maxes at 1.0 at n=30+
Assumption_Risk_Clearance = % of Tier 1 (kill-zone) assumptions with Rung 3+ evidence

RACS Score:
  0.75 - 1.0  → High Confidence
  0.50 - 0.74 → Medium Confidence
  0.25 - 0.49 → Low Confidence
  0.00 - 0.24 → Insufficient
```

---

## The 9-Quadrant Pivot Taxonomy
*(From Lean Startup — use when verdict is "Iterate" to specify the exact pivot type)*

| Pivot Type | What Changes | When to Use |
|-----------|-------------|------------|
| **Zoom-in** | Single feature becomes the whole product | Core feature has strong signal, rest is noise |
| **Zoom-out** | Whole product becomes one feature | Market demands a broader platform |
| **Customer Segment** | Same problem, different buyer | Current ICP doesn't have budget/urgency; adjacent segment does |
| **Customer Need** | Same customer, different problem | Problem was real but solution addresses the wrong job |
| **Platform** | App → Platform or vice versa | Network effects discovered; or platform overhead not justified |
| **Business Architecture** | High-margin niche ↔ Low-margin volume | Unit economics don't work in current model |
| **Value Capture** | Pricing model change | Revenue model mismatch (should be SaaS not transactional, etc.) |
| **Engine of Growth** | Viral → Sticky → Paid (or switch) | Current growth engine isn't sustainable |
| **Channel** | Same product, different distribution | Current channel CAC > viable LTV |

---

## Bayesian Evidence Weighting

Apply **Bayesian updating** to adjust confidence as evidence accumulates:

```
Prior Belief  = Starting confidence based on desk research (Low/Medium/High)
Likelihood Ratio:
  Rung 5 evidence that CONFIRMS assumption  = 5.0x (strong update toward belief)
  Rung 3-4 evidence that CONFIRMS           = 2.0x
  Rung 3-4 evidence that CONTRADICTS        = 0.3x (strong update against belief)
  Rung 1-2 evidence (either direction)      = 1.0x (no update — noise)

Posterior = Prior × Product(Likelihood Ratios)
Normalize posterior to [0,1] confidence range
```

> **Key insight:** One Rung 5 contradiction (someone cancels a pre-order, refuses to pay) can wipe out 10 enthusiastic Rung 1 compliments. Treat contradicting commitment signals with maximum weight.

---

## Investor-Grade Memo Template

```markdown
# Validation Decision Memo — [Startup Name / Experiment Name]
**Date:** [YYYY-MM-DD]  
**Experiment:** [Name of the experiment being evaluated]  
**Verdict:** [🟢 Go | 🟡 Iterate | 🔴 Stop | 🔵 Test More]  
**Confidence:** [High | Medium | Low | Insufficient]  
**RACS Score:** [0.00 – 1.00]

---

## 1. Assumption Tested
> One sentence: "We believed [customer segment] has [problem], and would [behavior] to solve it."

## 2. Evidence Summary
| Rung | Signal | Count | Weight |
|------|--------|-------|--------|
| 5 | [Specific commitment] | n= | 1.0x |
| 4 | [Specific action] | n= | 0.8x |
| 3 | [Time/follow-up] | n= | 0.6x |
| 2 | [Stated intent] | n= | 0.3x |
| 1 | [Opinion/feeling] | n= | 0.0x |

**Weighted Score:** [Calculated]  
**Sean Ellis PMF Score:** [X% — or N/A if pre-product]  
**Problem Severity Score:** [X/5]

## 3. Key Confirmations
- [Quote + Rung + Source]
- [Quote + Rung + Source]

## 4. Key Contradictions (DO NOT OMIT)
- [Quote or signal that contradicts the assumption]
- [If none found, state: "No contradicting signals detected — flag for potential cherry-picking bias"]

## 5. Unproven Risks Remaining
- [Risk 1]: Not yet tested — recommend [experiment type]
- [Risk 2]: Thin evidence — recommend expanding sample

## 6. Verdict Rationale
[3-5 sentences explaining WHY this verdict was chosen, referencing specific evidence items]

## 7. Next Cheapest Experiment
**Experiment Name:** [Name]  
**Type:** [Shadow Button / Concierge / Smoke Test / Interview / etc.]  
**Hypothesis:** "We believe [X]. We'll test by [Y]. We'll know it worked if [Z] within [timeframe]."  
**Budget:** [$X or X hours]  
**Pass Criterion:** [Specific metric and threshold]

## 8. Pivot Recommendation (if Iterate verdict)
**Pivot Type:** [From 9-quadrant taxonomy]  
**What changes:** [Specific change]  
**Why this pivot:** [Evidence-based rationale]
```

---

## Anti-Patterns (Auto-Flagged)

| Anti-Pattern | Detection | Action |
|-------------|-----------|--------|
| "Users seem excited about this" | No Rung 3+ evidence cited | BLOCK — request evidence upgrade |
| "Go" based on secondary research alone | No primary interview/behavioral data | HARD BLOCK |
| Omitting contradicting signals | Zero contradictions in memo | FLAG — require explicit confirmation |
| "Iterate" with no specific iteration hypothesis | Vague "we need to improve" | REJECT — demand specific pivot type |
| Calling 5 enthusiastic responses "validated" | n<15, all Rung 1-2 | AUTO-DOWNGRADE to "Test More" |
| Confidence ≠ Evidence Level | High confidence with Low evidence | NORMALIZE confidence to match RACS |

---

## Acceptance Criteria
1. Verdict chosen from exactly: Go / Iterate / Stop / Test More
2. RACS Score calculated and included (not estimated)
3. Evidence table populated with rung classifications and counts
4. Contradicting signals section explicitly completed (cannot be omitted)
5. If verdict is "Iterate" → specific pivot type from 9-quadrant taxonomy named
6. If verdict is not "Go" → next cheapest experiment fully specified
7. All Hard Evidence Gates documented as passed or failed

