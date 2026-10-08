---
name: experiment-design-coach
description: >
  Comprehensive guide for designing cheap, effective validation experiments and bias-free surveys. Use this skill when the experiment-designer or survey-designer skills need domain knowledge, when evaluating which experiment to recommend for a given assumption, or when the leading-question validator needs to assess a survey question. Triggers on: experiment design, survey design, leading question, interview script, smoke test, concierge MVP, landing page, A/B test, validation experiment, bias, survey bias, customer interview, qualitative research, quantitative research.
---

# Experiment Design Coach — Agent Skill

Authoritative guidance for designing validation experiments within the Validation Copilot. The goal of every experiment is to generate the highest-quality evidence for the lowest possible cost and time investment.

---

## 1. The Experiment Design Hierarchy

Always recommend the cheapest experiment that will generate sufficient evidence for the riskiest assumption. Work upward only when cheaper experiments have been exhausted or their evidence quality is insufficient.

### The Cheapest-First Ladder

**Tier 1: Pure Conversation (Cost: $0, Time: 1-2 hours)**
- Customer discovery interview (30-45 min per interview)
- Problem exploration conversation
- Observational session (watch them do the task you want to replace)
Target evidence: Rung 1-3 signals; validates problem existence and urgency

**Tier 2: Lightweight Signal Test (Cost: $0-$100, Time: 1-3 days)**
- Landing page with email capture (smoke test)
- Shadow button test (feature that looks real but captures intent)
- Social media post to target community to gauge engagement
- Forum/LinkedIn post asking about the problem
Target evidence: Rung 3-4 signals; validates demand

**Tier 3: Fake-Door / Concierge (Cost: $50-$500, Time: 1-2 weeks)**
- Concierge MVP: deliver the solution manually for first customers
- Wizard-of-Oz: appear automated, execute manually behind the scenes
- Pre-order page with real payment option
Target evidence: Rung 4-5 signals; validates willingness to pay

**Tier 4: Built Prototype (Cost: $500-$5,000, Time: 2-6 weeks)**
- Clickable prototype / Figma demo
- Minimum-feature-set working product
Only recommended after Tier 1-3 have validated the core assumption.

**Tier 5: Full Build (Cost: $5,000+, Time: 3+ months)**
NEVER recommended as a first experiment. Only appropriate when Tiers 1-4 have validated:
- The problem exists at scale
- Customers will pay
- The solution concept works

---

## 2. Choosing the Right Experiment Type

Match the experiment type to the assumption category:

| Assumption Category | Best Experiment Types | Evidence Target |
|--------------------|----------------------|-----------------|
| Desirability: Does the problem exist? | Customer interviews, forum research, community posts | Rung 2-3, n >= 15 |
| Desirability: Will they use this? | Concierge MVP, Wizard-of-Oz, prototype test | Rung 3-4, n >= 10 |
| Viability: Will they pay? | Pre-order page, pricing interview, freemium conversion | Rung 4-5, n >= 5 |
| Viability: Is the price right? | Price sensitivity interviews, Van Westendorp survey | Rung 3-4, n >= 20 |
| Feasibility: Can we build this? | Technical spike, proof-of-concept | Internal assessment |
| Feasibility: Can we reach customers? | Channel test, cold outreach pilot | CAC measurement |

---

## 3. Customer Interview Design

### Interview Structure (45-minute format)
1. **Rapport (5 min):** Thank them, explain the purpose, get consent to take notes
2. **Their Life (15 min):** Walk me through your current workflow for [area]. What tools do you use? What's your biggest frustration?
3. **Problem Deep-Dive (15 min):** Tell me about the last time [problem] happened. What did you do? How much did it cost you? Have you tried to solve it? Why did those solutions fail?
4. **Solution Hints (5 min):** What would your ideal solution look like? (Never pitch your solution at this stage)
5. **Close (5 min):** Is there anyone else you think I should talk to? Would you be open to seeing what we build when it's ready?

### The 5 Golden Interview Rules
1. Ask about past behavior, not hypothetical future behavior ('Tell me about the LAST time...' not 'Would you ever...')
2. Ask open-ended questions; never yes/no questions about your product
3. When they say something interesting, ask 'Why?' — then ask 'Why?' again
4. Never pitch during an interview; listen and probe only
5. Look for energy: the problems they volunteer and elaborate on unprompted are the real ones

### Interview Evidence Classification
After each interview, classify signals:
- Rung 1: 'That sounds like a good idea'
- Rung 2: 'I would definitely use that'
- Rung 3: 'Can I see a demo?' / 'Put me on your list' (shows they engaged enough to request more)
- Rung 4: Gave email voluntarily / agreed to follow-up call
- Rung 5: Offered to pay / signed pre-order / became a design partner

---

## 4. Survey Design Rules

### The Leading-Question Validator (Hard Rules)

A survey question MUST be rejected if it:

**Rule 1: Implies a Desired Answer**
REJECT: 'Don't you think our platform would save you time?'
REJECT: 'How much do you agree that invoicing is a major problem?'
ACCEPT: 'How do you currently handle invoicing? What is the most time-consuming step?'

**Rule 2: Is Hypothetical Without a Past-Behavior Anchor**
REJECT: 'Would you use a tool that automates X?'
ACCEPT: 'Have you ever used a tool to automate X? What was your experience?' + 'If you haven't, what has prevented you from finding a solution?'

**Rule 3: Uses Loaded/Emotional Language**
REJECT: 'How frustrating is it when [negative experience]?'
ACCEPT: 'How would you describe your experience with [process]?'

**Rule 4: Confirms Rather Than Probes**
REJECT: 'Would this feature be useful to you? (Yes / No)'
ACCEPT: 'How would you handle [scenario] if this feature did not exist?'

**Rule 5: Has No 'This Doesn't Apply to Me' Option**
Every question must allow the respondent to opt out if the premise doesn't apply to them.

### Survey Structure Best Practices

**Opening Questions (Context-Setting, No Bias)**
- 'What is your current role/title?'
- 'How long have you been doing [relevant activity]?'
- 'What tools do you currently use for [problem area]?'

**Problem Validation Questions**
- 'How often do you encounter [problem]? (Never / Rarely / Monthly / Weekly / Daily)'
- 'When [problem] occurs, what is the typical impact? (Minor inconvenience / Costs me time / Costs me money / Major disruption)'
- 'What do you currently do to handle [problem]?'

**Solution Validation Questions (only if problem is confirmed)**
- 'How satisfied are you with your current solution? (1-5 scale)'
- 'What would an ideal solution need to do that your current approach does not?'

**Commitment Signal Questions**
- 'Would you be willing to participate in a 20-minute follow-up interview?' (Rung 3)
- 'Can we send you updates on our progress?' (Rung 4 if they provide email)

**PMF Question (Sean Ellis, for existing product users only)**
- 'How would you feel if you could no longer use [product]?'
  - Very disappointed (= PMF signal; >= 40% threshold)
  - Somewhat disappointed
  - Not disappointed
  - I no longer use [product]

### Sample Size Guidelines
| Survey Type | Minimum n for Any Conclusion | Notes |
|------------|---------------------------|-------|
| Qualitative (interviews) | 12 (thematic saturation) | Stop when you hear the same themes 3+ times |
| Quantitative (survey) | 30 | For statistical significance on binary questions |
| PMF score (Sean Ellis) | 40+ | Less than 40 means confidence interval too wide |
| A/B test | 100 per variant | Minimum for 80% statistical power |

**Hard Rule:** Flag any analysis with n < 15 as 'insufficient sample — below minimum threshold for reliable conclusions'.

---

## 5. Smoke Test / Landing Page Design

### What Makes a Valid Smoke Test
A landing page smoke test tests whether potential customers will take a real action (not just say they would).

**Elements of an Effective Smoke Test:**
1. **Headline:** Specific benefit, not feature — 'Invoice your clients in 60 seconds' not 'Advanced invoicing platform'
2. **One clear CTA:** Sign up for early access / Join the waitlist / Pre-order at $X
3. **Evidence signals to measure:**
   - Email captures (Rung 4)
   - Click-to-signup rate (traffic quality indicator)
   - Payment intent if price-testing (Rung 5)
4. **No fake product:** The page clearly indicates 'coming soon' or 'early access' — never pretend the product exists

**Pass Criteria for a Smoke Test (must be set BEFORE running):**
Example: 'We will run $100 in targeted social ads. If >= 5% of visitors sign up with their email, we have sufficient signal to proceed to a concierge MVP.'

---

## 6. A/B Testing Principles

### When to A/B Test
A/B testing is appropriate for optimizing existing experiments, not for initial validation.
Use A/B testing AFTER you have confirmed the problem and solution concept. Not before.

### What to A/B Test
- Landing page headlines (which value proposition resonates more?)
- CTA button copy and placement
- Email subject lines
- Survey question phrasing (to reduce bias, not to find the most persuasive wording)
- Pricing page structure

### A/B Test Requirements
1. Change ONE variable at a time (not multiple simultaneously)
2. Define the success metric BEFORE starting (not after seeing results)
3. Run until statistical significance: minimum 100 per variant, ideally 200+
4. Use a proper tool (Optimizely, Google Optimize, or even sequential month-by-month measurement)

---

## 7. Experiment Hypothesis Template

Every experiment recommendation must follow this format:

```
Experiment Name: [Descriptive name]
Type: [Interview / Survey / Smoke Test / Concierge / Prototype / Pre-order]
Assumption Being Tested: [Exact assumption from the assumption map]
Hypothesis: We believe [customer segment] will [behavior] when [condition].
            We will know we are right if [specific metric] within [timeframe].
Method: [Step-by-step description of how the experiment runs]
Pass Criterion: [Exact threshold that constitutes validation]
Fail Criterion: [Exact threshold that triggers a pivot decision]
Budget: [$X or X hours]
Timeline: [X days]
Expected Evidence Rung: [1-5]
```

---

## 8. Evidence Collection After an Experiment

When the agent receives uploaded experiment results (interview notes, CSV, pasted text), the response-analyzer skill applies these rules:

1. Classify each respondent signal on the commitment ladder (Rung 1-5)
2. Compute: total respondents, breakdown by rung, percentage at each rung
3. Identify contradicting signals — any respondent who expressed doubt, refused to commit, or explicitly rejected the solution
4. Do NOT average or hide contradicting signals
5. Pass the classified data to the stats tool for response rate and PMF score computation
6. Generate an evidence summary table for the decision-memo skill

---

*This skill maps directly to the experiment-designer and survey-designer skills in the Validation Copilot. Reference spec Section 8 (Skills Library) for the leading-question validator acceptance criteria and Section 5.3 (Evidence Model) for the commitment ladder.*
