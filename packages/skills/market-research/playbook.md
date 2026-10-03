# Validation Copilot — Skill: market-research (v2.0 Elite)

## 1. Purpose & Analytical Rigor
Conduct rigorous secondary market research, competitive benchmarking, and pricing intelligence using grounded web discovery.
Secondary research forms the **contextual baseline** for an idea. It tells us what has already failed, what incumbents charge, and where the market whitespace exists.

---

## 2. Hard Anti-Hallucination Rules (Non-Negotiable)
1. **The 100% Citation Mandate:** Every claim citing market size, CAGR, competitor pricing, or user numbers MUST include a verified source URL.
2. **Ban on Top-Down TAM Vanity:** Top-down market sizing (e.g., *"The global video market is $100 Billion, we only need 1%"*) is banned. All market estimations must use **Bottom-Up Unit Economics**.
3. **Explicit Disclosure of Unknowns:** If reliable secondary data cannot be verified, the output MUST explicitly state: `[insufficient evidence — requires primary testing]` rather than extrapolating speculative estimates.
4. **Secondary Research Cannot Validate Desirability:** Desk research proves that a market exists; it **never** proves that customers will buy *your* specific product.

---

## 3. The 4-Tier Competitive Matrix

Founders frequently claim "we have no competitors". In reality, customers always have alternatives:

| Tier | Category | Definition | Example for Video Creator Platform (Picaura) |
|---|---|---|---|
| **Tier 1** | **Direct Competitors** | Companies solving the same problem with a similar software mechanic. | Frame.io, Wipster, Vidflow, Motion Array Review. |
| **Tier 2** | **Indirect Competitors** | Products solving the broader job-to-be-done with a different workflow. | Behance Pro, Vimeo Pro, WeTransfer Showcase, Dropbox Replay. |
| **Tier 3** | **The Clumsy Status Quo** | Free or general-purpose tools the customer already uses daily. | Google Drive folders + WhatsApp chat timestamps + unlisted YouTube links. |
| **Tier 4** | **The "Do Nothing" Inertia** | Customer tolerating the pain because switching costs or learning curve feel too high. | "My clients complain, but I just deal with it because Drive is free." |

---

## 4. Bottom-Up TAM / SAM / SOM Mathematical Formula

The agent calculates market potential using unit multiplication:

$$\text{TAM} = \text{Total Potential Customers in the World} \times \text{Realistic Annual Contract Value (ACV)}$$

$$\text{SAM} = \text{Customers in Target Geography / Segment You Can Legally \& Language-Wise Reach} \times \text{ACV}$$

$$\text{SOM} = \text{Realistic Market Share Capturable within 18–36 Months Given Go-to-Market Budget} \times \text{ACV}$$

---

## 5. Output Specification Schema
```json
{
  "market_dynamics": {
    "sector": "string (industry classification)",
    "market_trend": "string (key tailwinds or headwinds cited with URLs)",
    "bottom_up_tam_sam_som": {
      "acv_estimate": "string (annual revenue per customer unit)",
      "sam_reachable_units": "string (estimated reachable audience)",
      "calculation_method": "string (e.g. 50,000 creators in MENA × $240/yr = $12M SAM)"
    }
  },
  "competitive_landscape": [
    {
      "name": "string (competitor or alternative)",
      "tier": "direct | indirect | status_quo | inertia",
      "pricing_model": "string (e.g. $15/seat/mo, freemium, or free)",
      "strengths": "string (what they do exceptionally well)",
      "vulnerabilities": "string (where customers express churn friction)",
      "source_url": "string (URL proving this pricing or model exists)"
    }
  ],
  "pricing_benchmarks": {
    "industry_standard_model": "per_seat | usage_based | flat_subscription | take_rate",
    "typical_entry_price": "string",
    "typical_pro_price": "string",
    "recommended_validation_price_point": "string"
  },
  "evidence_claims": [
    {
      "claim": "string (specific cited fact)",
      "source_url": "string (verifiable URL)",
      "published_at": "string (date or ISO string)"
    }
  ]
}
```
