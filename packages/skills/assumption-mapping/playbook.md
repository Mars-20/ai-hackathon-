# Validation Copilot — Skill: assumption-mapping (v2.0 Elite)

## 1. Purpose & Theoretical Foundation
Systematically deconstruct a startup hypothesis into discrete, falsifiable bets using the **Strategyzer Testing Business Ideas** framework (David J. Bland & Alexander Osterwalder).
Founders rarely fail from building the product wrong; they fail from building the *wrong thing* because they assumed answers to questions they never tested.

---

## 2. The 3 Pillars of Venture Risk

```
                ┌────────────────────────────────┐
                │          DESIRABILITY          │
                │     "Do they actually care?"   │
                └───────────────┬────────────────┘
                                │
        ┌───────────────────────┴───────────────────────┐
        ▼                                               ▼
┌───────────────────────────────┐       ┌───────────────────────────────┐
│          FEASIBILITY          │       │           VIABILITY           │
│     "Can we deliver it?"      │       │     "Can we make a profit?"   │
└───────────────────────────────┘       └───────────────────────────────┘
```

### A. Desirability (Value & Market Risk)
- **Problem Significance:** Does the customer genuinely suffer from this friction, or is it merely an inconvenience?
- **Urgency & Priority:** Is solving this in the customer's top 3 daily priorities this quarter?
- **Switching Motivation:** Is the value improvement $\ge 10\times$ better than the status quo/workaround to overcome user inertia?

### B. Feasibility (Execution & Delivery Risk)
- **Technical Feasibility:** Can the core experience be delivered within acceptable latency, reliability, and cost?
- **Workflow Integration:** Will the target user actually adopt this into their existing stack without massive retraining?
- **Regulatory & Legal Compliance:** Does it comply with local data protection laws (e.g., Egypt PDPL Law 151/2020, electronic marketing licenses)?

### C. Viability (Economic & Business Model Risk)
- **Willingness to Pay (WTP):** Will customers part with hard cash, or do they only offer polite compliments?
- **Unit Economics Viability:** Can Customer Acquisition Cost ($\text{CAC}$) be kept at less than $\frac{1}{3}$ of Customer Lifetime Value ($\text{LTV}$)?
- **Payback Velocity:** Can CAC be recouped within 6–12 months?

---

## 3. The 2x2 Risk-Certainty Matrix

Every assumption must be plotted across two dimensions:
1. **Impact (Low vs. Critical):** If this assumption is false, how severe is the damage? (Critical = Business Dies Instantly).
2. **Evidence Level (High Evidence vs. Zero Evidence):** What verified customer behavior or hard commitments do we already possess?

```
               ▲ Critical Impact (Fatal if wrong)
               │
    Zone 2     │     ZONE 1: THE KILL-ZONE
 (Known Risks) │ (Must Test First — Top Priority)
               │
───────────────┼───────────────────────────────► Zero / Low Evidence
               │
    Zone 4     │            Zone 3
 (Irrelevant)  │       (Watch & Monitor)
               │ Low Impact
```

### The "Kill Hypothesis":
Every startup has **ONE single assumption** that is the most lethal. If that assumption is disproven, the venture cannot survive in its current form. **This assumption MUST be tested before writing a single line of production code.**

---

## 4. Syntactical Grammar of an Assumption
Every generated assumption MUST strictly follow this exact linguistic contract:
> **"We assume that [Specific Target Persona] will [Specific Measurable Action or WTP] because of [Underlying Driver], even though [Primary Obstacle/Inertia]."**

### ❌ Bad Examples (Vague, Untestable Opinions):
- *"Videographers want a better platform to share work."* (Untestable, subjective).
- *"Clients will love the video transition effects."* (Flattery, non-falsifiable).

### ✅ Good Examples (Precise, Falsifiable Hypotheses):
- *"We assume that freelance videographers in Egypt will pay 250 EGP/month for custom-branded video galleries because current Google Drive links look unprofessional to high-ticket corporate clients."*
- *"We assume that non-technical clients will successfully leave timestamped feedback on mobile web without being forced to download an app or create an account."*

---

## 5. Output Specification Schema
```json
{
  "kill_hypothesis": {
    "statement": "string (the single most lethal assumption that must be tested first)",
    "category": "desirability | viability | feasibility",
    "rationale": "string (why disproving this kills the startup)"
  },
  "assumptions": [
    {
      "id": "uuid",
      "statement": "We assume that...",
      "category": "desirability | viability | feasibility",
      "risk_level": "critical | high | medium | low",
      "reasoning": "string (evidence needed to validate or invalidate)",
      "validation_metric": "string (falsifiable quantitative threshold, e.g. '≥4 of 10 pilot videographers take payment via the link')"
    }
  ]
}
```
