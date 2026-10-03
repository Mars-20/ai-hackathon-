# Validation Copilot — Skill: experiment-designer (v2.0 Elite)

## 1. Purpose & Core Methodology
Select, design, and scope the **cheapest, fastest, and most decisive experiment** to test a startup's Kill-Hypothesis.
Based on the **44 Experiment Taxonomy** from *Testing Business Ideas* (David J. Bland & Alexander Osterwalder).

---

## 2. The Golden Rule of Lean Prototyping
> **"Never write code to answer a question that an interview, a spreadsheet, or a landing page could answer in 48 hours."**

A prototype is not a miniature version of your final product; it is an instrument designed to test one specific assumption with maximum speed and minimum capital.

---

## 3. The Experiment Hierarchy Matrix

```
                      ▲ High Evidence Strength (Behavioral & Financial)
                      │
                      │  [Level 4: Pre-orders / Deposits]
                      │  [Level 3: Wizard of Oz / Concierge MVP]
                      │  [Level 2: Fake Door / Smoke Test Landing Page]
                      │  [Level 1: Mom Test Customer Interviews]
                      │  [Level 0: Desk Research & Competitor Reviews]
                      │
                      └───────────────────────────────────────────────► Capital / Time Required
```

### Experiment Archetypes by Phase:

#### Phase A: Discovery Experiments (Goal: Validate Problem & Desirability)
1. **The Mom Test Interview Script ($0 | 2–4 Days):**
   - 8–12 structured 1-on-1 interviews with target ICP exploring past experiences, current workarounds, and emotional friction.
2. **Review Mining ($0 | 1 Day):**
   - Scraping 1-star, 2-star, and 3-star reviews of incumbents on Trustpilot, G2, Capterra, or Google Play to find persistent unaddressed frustrations.
3. **Forum Pain-Hunting ($0 | 2 Days):**
   - Analyzing complaints and recurring workflow questions on niche subreddits, Facebook creator groups, or industry Slack communities.

#### Phase B: Validation Experiments (Goal: Validate Solution & Willingness to Pay)
4. **The Concierge Test ($0–$25 | 3–7 Days):**
   - The founder manually performs the service for 3–5 clients using existing free tools (e.g., manually styling video galleries in Notion/Webflow and sharing with clients) to understand the exact friction points.
5. **The Wizard of Oz Test ($20–$50 | 5–7 Days):**
   - A realistic front-end web interface where the user submits their work, but the backend is processed manually by the founder rather than automated algorithms.
6. **Smoke Test / Fake Door Landing Page ($20–$50 | 3–5 Days):**
   - A single-page site with screenshots, value proposition, and a clear call-to-action (e.g., *"Join Early Access - $10 refundable reservation"* or *"Request Custom Domain Onboarding"*).
7. **Pre-Order / LOI Contract ($0 | 7–14 Days):**
   - Asking prospective B2B customers to sign a non-binding Letter of Intent (LOI) or deposit 10% to secure launch pricing.

---

## 4. Pre-Commitment to Pass/Fail Criteria
To eliminate founder confirmation bias, **every experiment must declare its quantitative falsification metric before execution**:

| Experiment Type | Example Falsifiable Success Metric |
|---|---|
| **Customer Interviews** | $\ge 5$ of 10 interviewees independently state they spent $>2$ hours this week dealing with the specific problem. |
| **Concierge MVP** | $\ge 3$ of 5 pilot users offer to pay for continued service after the manual pilot concludes. |
| **Smoke Test Landing Page** | $>12\%$ conversion rate on the primary high-friction CTA (e.g. entering email + answering 3 workflow questions). |
| **Pre-Sale / LOI** | $\ge 2$ signed LOIs or cash deposits secured from 15 targeted outreach contacts. |

---

## 5. Output Specification Schema
```json
{
  "selected_experiment": {
    "title": "string (name of the test)",
    "archetype": "mom_test_interviews | concierge_mvp | wizard_of_oz | smoke_test | letter_of_intent",
    "target_assumption": "string (which critical assumption this decisively tests)",
    "why_this_experiment": "string (rationale for why this is the cheapest/fastest test)",
    "estimated_cost_usd": "number (target <$50)",
    "estimated_duration_days": "number (target 3-7 days)",
    "target_sample_size": "number (e.g. 10 interviews or 50 landing page visitors)"
  },
  "falsifiable_hypothesis": {
    "pass_criteria": "string (exact numeric threshold required to declare success)",
    "fail_criteria": "string (metric indicating hypothesis is invalidated and requires pivot)"
  },
  "step_by_step_execution_plan": [
    "Step 1: ...",
    "Step 2: ...",
    "Step 3: ..."
  ],
  "required_materials": [
    "string (e.g. Typeform link, Calendly schedule, Notion portfolio template)"
  ]
}
```
