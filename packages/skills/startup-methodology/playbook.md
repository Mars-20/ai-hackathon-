---
name: startup-methodology
description: >
  Comprehensive startup validation and business methodology framework synthesized from Lean Startup, Business Model Canvas, pitching, marketing, and operations management principles. Use this skill when the agent needs to reason about startup stage, validation strategy, business model design, pitch structure, or when coaching a founder through any structured startup methodology. Triggers on: lean startup, assumption mapping, BMC, business model canvas, pitch deck, elevator pitch, go-to-market, PMF, product-market fit, pivot, MVP, customer development.
---

# Startup Methodology — Agent Skill

This skill gives the agent deep, structured knowledge of startup methodologies drawn from Lean Startup, Business Model Canvas, Pitching, Marketing for Startups, and Operations Management frameworks. All content is synthesized to be **directly actionable** for the Validation Copilot agent loop.

---

## 1. Lean Startup Methodology

### Core Philosophy
The Lean Startup is a scientific approach to building startups by **testing hypotheses** rather than executing a fixed plan. The central insight: most startup failures are not technical — they are **validation failures** (the problem didn't exist, or the solution didn't fit).

### The Build-Measure-Learn Loop
Build the smallest thing that tests your riskiest assumption (MVP).
Measure real customer behavior, not opinions.
Learn whether to Persevere or Pivot.

### Problem Formulation (Before Building Anything)
Every startup must first answer:
1. What is the exact problem? (Hair-on-fire pain, not a mild inconvenience)
2. Who has this problem? (The specific ICP — not 'everyone')
3. How are they solving it today? (Current workaround = your real competitor)
4. How often does this problem occur? (Frequency determines urgency)
5. What does a failed solution cost them? (Monetary or opportunity cost)

**Agent Rule:** Never let a founder skip Problem Formulation. The startup-intake skill enforces this. A vague problem statement produces a vague assumption map.

### Customer Personas (The Mom Test principle)
A valid persona must include:
- Who they are (specific role/title, not 'business owners')
- Their current workflow (what tools do they use today?)
- Their hair-on-fire pain (what keeps them up at night?)
- What they've already tried (failed solutions = validated demand)
- Their buying behavior (budget authority, purchase frequency)

Bad persona: 'Entrepreneurs who want to grow'
Good persona: 'Egyptian freelance video editors (solo, 2-5 years experience) who lose clients because WhatsApp compresses their portfolio videos and feedback is scattered across chats'

### Hypothesis Testing Framework
'We believe [customer segment] has [problem/job-to-be-done]. We will test this by [specific method]. We will know we are right if [specific, measurable signal] within [timeframe].'

### The MVP Ladder (Cheapest to Most Expensive)
1. Conversation — customer interview (free, fastest)
2. Landing page smoke test — measure sign-up intent
3. Concierge MVP — do the job manually for first customers
4. Wizard-of-Oz — fake automated backend, manual execution
5. Prototype / Clickable Demo — no working backend
6. Functional MVP — minimal working product (most expensive first test)

**Agent Rule (maps to experiment-designer skill):** Never recommend step 4-6 before exhausting steps 1-3. The cheapest test that generates the required evidence level is always the right recommendation.

### Pivot Types (9-Quadrant Taxonomy)
When to pivot vs. persevere — use this when decision-memo returns 'Iterate':

| Pivot | What Changes | Evidence Signal |
|-------|-------------|-----------------|
| Zoom-In | One feature becomes whole product | That feature has strong signal; rest is noise |
| Zoom-Out | Whole product becomes one feature | Market needs broader platform |
| Customer Segment | Same problem, different buyer | ICP has no budget/urgency; adjacent segment does |
| Customer Need | Same ICP, different problem | Real pain is adjacent to what you built for |
| Platform | App to Platform or reverse | Network effects emerged or not justified |
| Business Architecture | High-margin niche to Low-margin volume | Unit economics broken in current model |
| Value Capture | Pricing model restructure | Revenue model mismatch (SaaS vs. transactional) |
| Engine of Growth | Viral to Sticky to Paid or switch | Current growth engine unsustainable |
| Channel | Same product, different distribution | Channel CAC greater than viable LTV |

---

## 2. Business Model Canvas (BMC)

### The 9 Building Blocks
The BMC describes how a business creates, delivers, and captures value. Every startup being validated implicitly has a BMC hypothesis — the agent should reason through these blocks when doing assumption mapping.

**Block-by-Block Validation Priorities:**

1. Customer Segments (Validate First)
- Is the segment large enough? (TAM to SAM to SOM)
- Is it reachable through affordable channels?
- Do they have urgent, recurring pain? Will they pay?

2. Value Proposition (Second Priority)
- Gain creators: what positive outcomes does it deliver?
- Pain relievers: which specific frustrations does it eliminate?
- Fit test: Do the pain relievers map directly to the customer's stated pains?

3. Channels
- How do customers find out about you? (Awareness)
- How do you deliver the product? (Distribution)
- What is the CAC for each channel? Which channel has the best CAC/LTV ratio?

4. Revenue Streams (Often the Most Under-Validated)
- What are customers actually willing to pay?
- Price validation requires Rung 4+ evidence (someone agreeing to pay, not saying they 'would' pay)

5. Key Resources and Activities
- What does the startup need that it doesn't currently have?
- Which activities, if disrupted, would break the model?

6. Key Partners
- Which dependencies could kill the business? (API rate limits, single supplier, platform risk)

7. Cost Structure
- What are the unit economics? (CAC, LTV, Payback Period, Gross Margin)

### Value Proposition Canvas
- Customer Jobs matched to Product Features (does the product do the job?)
- Customer Pains matched to Pain Relievers (does it address real frustrations?)
- Customer Gains matched to Gain Creators (does it deliver desired outcomes?)

FIT = when Pain Relievers and Gain Creators match Customer Pains and Gains precisely.

**Agent Rule:** When doing assumption mapping, always check for BMC-level gaps. A missing revenue validation, an untested channel, or a key partner dependency are all 'critical' risk-level assumptions.

---

## 3. Pitching Framework

### The 10-Slide Investor Pitch Deck Structure

| Slide | Content | What Judges/Investors Look For |
|-------|---------|-------------------------------|
| 1 | Title | Company name, one-liner, founder name |
| 2 | Problem | Specific, vivid pain. Who suffers? How often? How much? |
| 3 | Solution | The 'aha' moment. Simple. Not a feature list. |
| 4 | Business Model | How do you make money? Revenue mechanics. |
| 5 | Underlying Magic | What makes this defensible? Tech? Data moat? Network effects? |
| 6 | Go-to-Market | How will you acquire first 100 customers? First 1000? |
| 7 | Competitive Analysis | Honest positioning vs. alternatives (including 'do nothing') |
| 8 | Team | Why are you the right team for this specific problem? |
| 9 | Financial Projections | 3-year projections with key assumptions stated |
| 10 | Current Status + Ask | Traction/milestones achieved + what you need + use of funds |

### Pitch Types by Context

Twitter Pitch (140 chars): 'We help [ICP] do [outcome] without [pain]. Currently [traction].'

Elevator Pitch (60 seconds):
1. Hook — the problem (one surprising stat or vivid scenario)
2. Solution — one sentence
3. Traction — most impressive proof point
4. Ask — specific request

Investor Pitch (5-10 minutes): Follow the 10-slide structure above. Every claim must be supported by evidence.

---

## 4. Marketing for Startups

### The Seven Marketing Functions
1. Distribution — how does the product reach end users? (Channel strategy)
2. Financing — what funds the marketing? (CAC budget)
3. Marketing Information — data collection and analysis (analytics, surveys)
4. Pricing — value-based vs. cost-plus vs. competitive
5. Product/Service Management — market response and iteration
6. Promotion — Inform, Persuade, Remind
7. Selling — direct conversion

### Market Sizing Framework
- TAM (Total Available Market): Total demand if 100% market share
- SAM (Serviceable Available Market): Customers you can actually reach
- SOM (Serviceable Obtainable Market): Realistic first-year capture

**Agent Rule (maps to market-research skill):** Never quote TAM as if it's achievable. Always calculate the SOM and sanity-check it against the go-to-market plan. Apollo prospect_search provides real counts for the SAM.

### Growth Hacking Principles

The Content Hacking Framework:
1. Pick ONE metric to grow (not all metrics simultaneously)
2. Set a specific goal for that metric (not 'grow users' — '100 new signups/week')
3. Set a timeline (not open-ended — 'by week 8')
4. Test relentlessly: Social media idea testing, A/B testing, keyword optimization

Classic Growth Hack Patterns:
- Viral loop: every user action brings new users (Hotmail email signature, Dropbox storage referral)
- Referral reward: existing customers recruit new ones (Amazon dollar coupon on both sides)
- Product-led growth: the product itself is the marketing (Notion, Slack)
- Freemium to conversion: free tier proves value; paid tier captures it

### Pricing Strategies Reference
| Strategy | Best For | Risk |
|---------|---------|------|
| Cost-Based | Manufacturing, known unit costs | Ignores customer value perception |
| Value-Based | SaaS, outcomes-focused products | Hard to quantify value precisely |
| Freemium | Software, digital products | Conversion rate is everything |
| Price Discrimination | Airlines, streaming, enterprise | Requires market segmentation control |
| Dynamic Pricing | Demand-variable services | Complexity and customer backlash risk |

### B2C vs. B2B Marketing Distinction
| Dimension | B2C | B2B |
|---------|-----|-----|
| Sales Cycle | Short (minutes to days) | Long (weeks to months) |
| Decision Maker | Individual | Committee |
| Emotion vs. Logic | High emotion | Logic + ROI |
| CAC | Usually lower | Usually higher |
| LTV | Lower per customer | Higher per customer |
| Content | Storytelling, social proof | Case studies, ROI calculators |

---

## 5. Startup Stages and Investment Readiness

### The Five Startup Stages

| Stage | What It Means | Funding Sources | Primary Metric |
|-------|-------------|-----------------|----------------|
| 1. Empathy | Validated problem + solution hypothesis | Self-fund, friends/family, grants, incubators | Problem interview completion rate |
| 2. Stickiness | Tech product with high retention / low churn | Accelerators (pre-seed), angel investors | Retention rate, Churn rate |
| 3. Virality | Organic user growth >5% weekly | Accelerators (seed), angels | Weekly growth rate |
| 4. Revenue | Healthy unit economics + continuous growth | Venture Capital | CAC, LTV, Payback Period |
| 5. Scaling | Massive growth and geographic expansion | Growth VCs, strategic investors | Revenue, market share |

### 8 Investor-Readiness Signals

1. Strong Team — domain expertise, diversity (business + tech + product), market understanding, commitment, speed
2. Promising Market — large and growing, high profit potential (now or future), weak/no competitors
3. Strong Product — smooth UX, in-house tech capability, product management discipline
4. Scalable Business Model — can grow revenue faster than costs
5. Promising Brand — distinctive name, marketing capability, exceptional customer experience
6. Validated Traction — sales evidence, market progress (investors back products, not ideas)
7. Clear Plan — expansion, marketing, financial, product roadmap + specific funding ask
8. Persuasion Ability — pitching skills, investor communication

**Agent Rule:** When a founder asks about investment readiness, map their current state to the stage table above. Do not use the word 'ready' unless Stages 1-3 are fully validated.

### Key Financial Metrics Reference
| Metric | Healthy Signal |
|--------|----------------|
| CAC | Trending down over time |
| LTV | LTV > 3x CAC |
| Payback Period | Less than 12 months (SaaS) |
| Burn Rate | Runway > 12 months |
| Runway | At least 18 months at all times |
| Gross Margin | Greater than 70% for software |
| PMF Score | Greater than or equal to 40% (Sean Ellis) |

### Scalability Assessment Criteria
| Factor | What to Assess |
|--------|---------------|
| Single core product | Is there one flagship thing that scales, vs. a scattered portfolio? |
| Light asset base | Can you grow without proportional capex? (Software over physical assets) |
| Product ecosystem | Do others do work on your platform? (Marketplace, API, app store) |
| Automated processes | What % of operations can run without human intervention? |
| Replicability | Can the model be copy-pasted to a new geography/vertical? |

---

## 6. Operations Management

### 5 Core Operations Principles
1. Continuous Improvement (CIP/Kaizen): improvement is embedded in daily operations
2. Respect for People: the team is the most valuable asset
3. Right Process = Right Results: standardize what works
4. Add Value to Operations: eliminate non-value-adding activities
5. Root Cause Problem Solving: treat causes, not symptoms (Five Whys)

### The PDCA Cycle
PLAN -> DO -> CHECK -> ACT -> back to PLAN
Apply to: customer acquisition funnels, product iteration cycles, team workflows, marketing campaigns.

### The 7 Wastes (Startup Context)
| Waste | Startup Equivalent |
|-------|-------------------|
| Overproduction | Building features nobody asked for |
| Waiting | Blocked PRs, slow customer decisions, approval bottlenecks |
| Unnecessary Transport | Handoffs between teams without clear docs |
| Over-processing | Gold-plating features beyond what the MVP needs |
| Excess Inventory | Half-built features, untested code, large content backlogs |
| Unnecessary Movement | Meetings that could be async messages |
| Defects | Bugs shipped to customers, wrong assumptions shipped as features |

### The Five Whys (Root Cause Analysis)
Start with the problem statement and ask 'Why?' five times, drilling down to the root cause. Address the root cause, not the symptom.

---

## 7. Agent Behavioral Rules (Synthesized)

### On Idea Intake
- Never validate an idea in the same breath you receive it
- Always force the founder to name the current workaround — it is the real competitor
- Never accept 'everyone' as the target customer

### On Assumptions
- Every assumption must be falsifiable (testable with a pass/fail criterion)
- Risk rank = Probability of being wrong x Impact if wrong
- Desirability risk > Viability risk > Feasibility risk (in most early-stage startups)

### On Evidence
- Secondary evidence forms hypotheses; primary evidence tests them
- Compliments are not commitments (The Mom Test)
- 'I would use this' (Rung 2) + 'Here is my email' (Rung 4) + 'Here is my credit card' (Rung 5)
- Never conflate positive sentiment with purchase intent

### On Experiments
- Cheapest test first — always
- A conversation is cheaper than a landing page; a landing page is cheaper than code
- Every experiment needs a pre-committed pass criterion before it runs

### On Decision Memos
- 'Test More' is a valid and often correct verdict — never suppress it
- Every non-Go verdict must name the next experiment
- Contradicting signals must never be omitted from a memo
- RACS score must be calculated, not estimated

---

*This skill is authoritative for startup methodology reasoning within the Validation Copilot agent. Reference spec Section 5.3 (Evidence Model), Section 8 (Skills Library), and Section 5.1 (Runtime Loop) for implementation boundaries.*
