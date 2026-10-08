---
name: icp-market-sizing
description: >
  Deep guidance on Ideal Customer Profile (ICP) definition, TAM/SAM/SOM market sizing, competitive landscape analysis, and how to use Apollo prospect_search for real market counts. Use this skill when running the market-research or icp-targeting skills, when validating customer segment assumptions, or when the founder needs help defining who their real customer is. Triggers on: ICP, ideal customer profile, target customer, market size, TAM, SAM, SOM, competitive analysis, SWOT, market research, customer segment, B2B, B2C, persona.
---

# ICP and Market Sizing — Agent Skill

Authoritative reference for customer definition and market sizing within the Validation Copilot. A badly defined ICP or an unrealistic market size claim is one of the most common startup mistakes — and one of the most commonly hallucinated outputs from AI systems. This skill prevents both.

---

## 1. ICP Definition Framework

The ICP (Ideal Customer Profile) is the most important thing to get right in a startup. Every other decision — pricing, channel, feature priority — derives from it.

### What Makes an ICP Valid
An ICP is valid only if all five dimensions are specified:

1. **Role/Title Precision:** Not 'business owners' — 'Head of Operations at a Series A Egyptian B2B SaaS company'
2. **Context:** Company size (employees, ARR), geography, current tech stack or workflow
3. **Hair-on-Fire Pain:** The specific, recurring frustration that costs them time or money daily
4. **Current Workaround:** What they are using right now (Excel, WhatsApp, a human, doing nothing)
5. **Buying Authority:** Do they have budget? Is it their decision or do they need approval?

### ICP Specificity Test
Ask: 'If I stood in a crowded room of 1000 people and described this ICP, would I be able to point to exactly who I mean?'
- If the answer is 'most people in the room' — the ICP is too broad. Narrow it.
- If the answer is 'about 5-10 people' — the ICP is valid.

### ICP vs. Persona Distinction
- **ICP** = the company or segment you sell to (used for B2B targeting, Apollo searches)
- **Persona** = the individual human at that company who experiences the pain and makes the decision
For B2C startups: ICP and persona collapse into one concept (the individual consumer).

---

## 2. Market Sizing (TAM / SAM / SOM)

### The Three Levels

**TAM (Total Available Market)**
Total market demand for the product category if you had 100% market share.
Use grounded_search to find published industry reports.
Cite the source — never invent a TAM number.
Example: 'The global freelancer platform market is estimated at $X billion (Source: [URL])'

**SAM (Serviceable Available Market)**
The subset of TAM that your product can realistically reach given your channels, geography, and language.
For Egyptian startups: the Egyptian TAM fraction + MENA expansion potential.
Use Apollo prospect_search to get real firmographic counts for B2B SAM validation.
Example: 'Apollo data shows 2,340 companies in Egypt matching our ICP criteria (Titles: Head of Operations, Company size: 50-500, Industry: Logistics)'

**SOM (Serviceable Obtainable Market)**
The realistic market share you can capture in Year 1-3.
Calculated from: SOM = SAM x realistic conversion rate given your GTM capacity
Example: 'If we can reach 10% of our SAM with our current channel capacity, SOM = 234 companies'

### How to Calculate SOM Honestly
1. Start from your planned go-to-market capacity (how many calls per week? how many cold emails per day?)
2. Apply realistic conversion rates (cold email: 2-5%, warm intro: 20-40%, content/inbound: 1-3%)
3. Calculate: Monthly outreach capacity x conversion rate x 12 months = Year 1 SOM

**Agent Rule:** Never present TAM as the relevant market for a startup. Always anchor to SOM. If a founder says 'the market is $5 billion', ask them: 'What is your realistic Year 1 SOM?'

---

## 3. Apollo prospect_search Usage Rules

Apollo is the most powerful tool for B2B market sizing — it replaces guessing with real counts.

### When to Use prospect_search
- When the market-research skill needs to validate B2B market size with real numbers
- When the icp-targeting skill needs to produce a founder shortlist for manual outreach
- When a founder asks 'how many companies like this actually exist?'

### Search Criteria Mapping (ICP to Apollo Parameters)
| ICP Dimension | Apollo Parameter |
|--------------|----------------|
| Job title / role | titles (array) |
| Seniority level | seniority (e.g., 'director', 'c_suite', 'manager') |
| Company industry | industry |
| Company size | company_size (e.g., '50,200') |
| Geography | location |
| Keywords | keywords |

### Citing Apollo Results Correctly
Apollo counts are cited as secondary evidence, just like web search results:
'[X] companies matching [ICP criteria] found in Apollo database as of [date] (Apollo.io research)'
Never present Apollo counts as confirmed customers. They are research data only.

### The Hard Compliance Boundary
prospect_search writes ONLY to the prospects table — never to leads or messages.
Apollo data is research-only. The only path to outreach is: Founder contacts manually outside the platform → Gets explicit consent → Manually converts to lead with full consent fields.
This boundary is non-negotiable. See spec Section 11.4 before any modification.

---

## 4. Competitive Analysis Framework

### Mapping Competitors Correctly
Four quadrants to plot competitors:

| Quadrant | Price | Value/Benefits | Label |
|---------|-------|---------------|-------|
| Leaders | High price | High benefits | Strongest direct competitors |
| Contenders | Low price | High benefits | Price-war risk |
| Challengers | High price | Low benefits | Vulnerable positioning |
| Laggards | Low price | Low benefits | 'Do nothing' / status quo |

### The 'Do Nothing' Competitor
ALWAYS include 'the customer does nothing' as a competitor option.
If 'doing nothing' is not significantly worse for the customer than using your product, the problem is not urgent enough.

### Competitive Research Process (for market-research skill)
1. Use grounded_search to find direct competitors: '[problem description] tool/software/service [industry]'
2. Use fetch_page to read competitor pricing pages
3. Classify each competitor on the 2x2 above
4. Identify the 'gap' — what quadrant is empty? What pain is nobody solving well?

### Competitive Moat Assessment
For each potential competitive advantage, classify its durability:
- **Weak moat:** Features (easily copied in 3-6 months)
- **Medium moat:** Workflow integration (switching costs)
- **Strong moat:** Network effects (value grows with users), Proprietary data, Regulatory advantage, Brand trust

---

## 5. SWOT Analysis (For Startup Context)

Use SWOT to frame the startup's strategic position, not as a generic exercise:

| | Internal | External |
|-|---------|---------|
| Positive | **Strengths:** What you do better than any competitor today | **Opportunities:** Market gaps, underserved segments, timing advantages |
| Negative | **Weaknesses:** Missing skills, thin resources, unvalidated assumptions | **Threats:** Competitor moves, regulatory risk, market timing risks |

### SWOT to Assumption Mapping
Every SWOT item that involves an unproven claim becomes an assumption:
- 'Our product is faster than competitors' = Assumption (feasibility category)
- 'The Egyptian market is ready for this pricing' = Assumption (viability category)
- 'Founders want to solve this problem' = Assumption (desirability category)

---

## 6. Market Research Output Standards

When producing market-research skill output, the agent must:

1. **State every factual claim with its source**
   Format: '[Claim] (Source: [URL], accessed [date])'
   No URL = output 'Insufficient evidence — unable to verify'

2. **Distinguish estimate from fact**
   'The Egyptian edtech market was valued at $X in 2023 (Source: Y)' = fact with source
   'We estimate the market to be around $X' = NOT acceptable unless explicitly labeled as estimate with methodology

3. **Present market size at all three levels**
   Always show TAM, SAM, SOM — never just one number

4. **Include at least 3 named competitors**
   With their pricing, positioning, and known weaknesses if available

5. **Flag market risks**
   Regulatory environment, seasonality, economic conditions, platform dependency

---

## 7. Customer Needs Profile (Jobs-to-be-Done)

Map the customer's situation across three dimensions:

**Customer Jobs** (what they are trying to accomplish):
- Functional jobs: practical tasks ('invoice my clients faster')
- Social jobs: how they want to be perceived ('look professional to clients')
- Emotional jobs: how they want to feel ('not stressed about late payments')

**Customer Pains** (what goes wrong):
- Undesired outcomes: what currently fails?
- Obstacles: what gets in the way?
- Risks: what might go wrong that they fear?

**Customer Gains** (what they want more of):
- Required gains: minimum acceptable outcome
- Expected gains: what a good solution should do
- Desired gains: what would delight them
- Unexpected gains: something they didn't know they needed

**FIT** occurs when your Pain Relievers directly address their Pains, and your Gain Creators directly create their Gains. This is product-market fit at the micro level.

---

*This skill maps directly to the market-research and icp-targeting skills in the Validation Copilot. Reference spec Section 7 (prospect_search tool), Section 11.4 (compliance boundary), and Section 8 (Skills Library) for implementation details.*
