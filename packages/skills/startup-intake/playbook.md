# Validation Copilot — Skill: startup-intake (v2.0 Elite)

## 1. Purpose & Philosophy
Extract structured, razor-sharp startup intelligence from unstructured founder pitch text.
A startup idea is not merely a product description; it is a **falsifiable business model hypothesis**.
This skill forces precision on the **Ideal Customer Profile (ICP)**, the **hair-on-fire problem**, the **value equation**, and the **business model archetype**.

---

## 2. Core Methodologies & Frameworks Applied
- **Steve Blank Customer Development:** "There are no facts inside your building, so get the heck outside."
- **Alex Hormozi Value Equation:**
  $$\text{Value} = \frac{\text{Dream Outcome} \times \text{Perceived Likelihood of Achievement}}{\text{Time Delay} \times \text{Effort \& Sacrifice}}$$
- **Clayton Christensen Jobs-to-be-Done (JTBD):** People don't buy a quarter-inch drill; they buy a quarter-inch hole.

---

## 3. Strict Operating Rules
1. **Zero Validation Theater:** Do not flatter the idea. Strip marketing buzzwords ("revolutionary", "Uber for X", "disruptive AI platform").
2. **Hair-on-Fire ICP Discipline:** A target customer cannot be "everyone", "businesses", or "students". It must specify the exact persona experiencing acute, recurring friction (e.g., *"Egyptian freelance video editors losing clients due to clunky Google Drive video delivery"*).
3. **Existing Workaround Detection:** Identify what the customer is using *right now* (Excel, WhatsApp, paper, hiring an assistant, or doing nothing). If there is no current workaround, the problem is rarely urgent.
4. **Never Exceed 3 Clarifying Questions:** Only ask if the critical ICP, revenue model, or stage cannot be logically deduced.
5. **Default Stage:** If not explicitly stated as having paying customers, default to `"idea"`.

---

## 4. Business Model Archetype Taxonomy
The skill must classify the idea into one of these standard operational archetypes:
- **Vertical B2B SaaS:** Specialized software for a specific niche (e.g. dental clinics, construction subcontractors).
- **Two-Sided Marketplace:** Connecting supply and demand (requires solving the cold-start chicken-and-egg problem).
- **API / Infrastructure / DevTool:** Developer-facing, usage-based or tiered billing.
- **Service-as-a-Software (SaaS + Concierge):** AI-augmented agency/managed service transforming into automated workflow.
- **Transactional FinTech / Payments:** Take-rate or interchange-fee based.
- **DTC / Consumer Subscription:** High churn sensitivity, requires virality or low CAC.

---

## 5. Output Specification Schema
```json
{
  "name": "string (clear brand or working title)",
  "one_liner": "string (≤15 words: We help [ICP] do [Outcome] without [Pain])",
  "domain": "string (specific vertical, e.g., 'Creative Tech / Freelancer SaaS')",
  "target_customer": {
    "persona": "string (specific job title or role)",
    "context": "string (company size, geography, or current workflow)",
    "hair_on_fire_pain": "string (the exact daily frustration or monetary loss)",
    "current_workaround": "string (what they currently use: WhatsApp, Drive, Sheets, etc.)"
  },
  "stage": "idea | prototype | live | scaling",
  "business_model": {
    "archetype": "vertical_saas | marketplace | devtool | service_as_software | transactional",
    "revenue_mechanic": "string (e.g., monthly subscription per seat, 10% commission per gig)",
    "pricing_hypothesis": "string (estimated target price point, e.g. $19-$49/mo or 250 EGP/mo)"
  },
  "clarifying_questions": [
    "string (at most 3 high-impact clarifying questions if critical gaps exist)"
  ]
}
```

---

## 6. Real-World Benchmark Examples

### Example 1: B2B Creative SaaS (Picaura)
**Founder Input:**
> "Startup SaaS اسمه picaura لمنصة فري لانس تسهل لصانعي المحتوى والمصورين والمنتير تقديم اعمالهم للعملاء في صورة جالري احترافيه مع تقسيمات وترانزيشن وباعلي جودة ممكنة وأريد معرفة ما أول شيء يجب أن أتحقق منه؟"

**Structured Output:**
```json
{
  "name": "Picaura",
  "one_liner": "Client presentation gallery and video review platform for freelance videographers and content creators.",
  "domain": "Creative SaaS / Freelancer Tooling",
  "target_customer": {
    "persona": "Freelance videographers, colorists, and video editors",
    "context": "Solo creators & boutique creative studios working with remote clients",
    "hair_on_fire_pain": "Clients complaining about compressed video quality on WhatsApp/Drive and messy timestamp feedback via chat",
    "current_workaround": "Google Drive links, WeTransfer, Frame.io (expensive enterprise), and unlisted YouTube links"
  },
  "stage": "idea",
  "business_model": {
    "archetype": "vertical_saas",
    "revenue_mechanic": "Tiered monthly subscription based on active storage (GB) and custom domain branding",
    "pricing_hypothesis": "$15 - $35/month (or equivalent in local currency)"
  },
  "clarifying_questions": [
    "Are you targeting individual solo videographers or marketing agencies with multiple review tiers?",
    "Will clients only view and approve videos, or also pay invoices and download raw source files?"
  ]
}
```
