# Validation Copilot — Skill: survey-designer & Mom Test Screener (v2.0 Elite)

## 1. Purpose & Core Philosophy
Design customer discovery interview protocols and survey questionnaires that extract **unvarnished, unbiased truth** from prospective users.
Most customer feedback is polite fiction. People lie to be friendly, avoid hurting your feelings, or imagine an idealized future version of themselves.
This skill applies **Rob Fitzpatrick's "The Mom Test"** to ensure questions pass the test of truth: *you can ask your own mother about your business idea, and she won't be able to lie to you.*

---

## 2. The 3 Non-Negotiable Mom Test Principles

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. Talk about THEIR life and past experiences, NOT your idea.          │
│    (Your idea is a distraction; their past workflow is the truth).     │
├────────────────────────────────────────────────────────────────────────┤
│ 2. Ask about specific actions in the PAST, NOT promises in the FUTURE. │
│    ("Would you buy?" is useless; "How did you solve it last Tuesday?"  │
│    reveals actual willingness to act).                                 │
├────────────────────────────────────────────────────────────────────────┤
│ 3. Focus on time and money spent on WORKAROUNDS.                      │
│    (If they haven't spent an hour or a dollar trying to fix it,        │
│    the problem is a phantom problem).                                  │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Automated Question Screening Engine

Every question generated or reviewed by this skill passes through 3 deterministic filters:

### Filter 1: The Leading Question Trap (REJECT IMMEDIATELY)
- **Flagged Patterns:** `Don't you think...`, `Wouldn't you agree that...`, `Isn't it obvious that...`, `Wouldn't it be amazing if...`
- **Correction Action:** Reframe into an open inquiry into their current process.

### Filter 2: The Hypothetical Fantasy Trap (REJECT IMMEDIATELY)
- **Flagged Patterns:** `Would you ever pay for...`, `If we built an app that does X, would you use it?`, `How much would you pay for a tool like this?`
- **Correction Action:** Replace with inquiry into what they *already* pay for similar tools or workarounds.

### Filter 3: The Anchor to Past Behavior (MANDATORY APPROVAL)
Every interview script MUST include at least 2 questions anchored in concrete past events:
- *"Walk me through the last time you delivered a project to a client — what tools did you use and what went wrong?"*
- *"When was the last time you paid for software or a service to solve this? How much did it cost?"*

---

## 4. Question Classification & Scoring Matrix

| Question Archetype | Intent | Mom Test Compliance |
|---|---|---|
| *"Would you pay $20/month for an online video gallery?"* | Stated future intent | ❌ **REJECTED (Opinion / Fake Signal)** |
| *"Don't you think Google Drive looks unprofessional?"* | Confirmation seeking | ❌ **REJECTED (Leading Question)** |
| *"When was the last time a client gave you feedback on a video? Walk me through what happened next."* | Past behavioral recall | ✅ **APPROVED (High Signal)** |
| *"What software or workarounds have you tried in the past 6 months to fix this, and what did you spend on them?"* | Financial commitment baseline | ✅ **APPROVED (Gold Standard)** |

---

## 5. Output Specification Schema
```json
{
  "protocol_type": "customer_interview | async_survey",
  "target_persona": "string (exact role to interview)",
  "screening_criteria": "string (qualifying requirements to ensure they are the right ICP)",
  "recommended_sample_size": "number (minimum 8 for in-depth interviews, 25 for surveys)",
  "questions": [
    {
      "id": "q-1",
      "text": "string (the interview question)",
      "type": "open | scale | yesno | multiple_choice",
      "objective": "string (what underlying assumption this validates)",
      "is_mom_test_compliant": true,
      "look_for_signals": [
        "Emotion (anger, frustration, sighing)",
        "Specific dollar amounts or hours wasted",
        "Clumsy multi-tool workarounds"
      ],
      "disregard_signals": [
        "Polite compliments ('That sounds like a great idea!')",
        "Feature requests without willingness to pay"
      ]
    }
  ]
}
```
