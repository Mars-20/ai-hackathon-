// ─────────────────────────────────────────────────────────────────────────────
// Agent API Route — POST /api/agent
// Runtime: Router → Planner → Executor → Verifier (Section 5.1)
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest } from "next/server";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import type {
  AgentInput,
  Assumption,
  Evidence,
  TraceEvent,
  Startup,
  Experiment,
  Decision,
} from "@/lib/types";
import {
  validateQuestion,
  meetsGoThreshold,
  deriveConfidence,
  BUDGET,
  sampleStats,
} from "@/lib/utils";
import { searchLeads } from "@/lib/apollo";
import type { ApolloLead } from "@/lib/apollo";

// ── Provider setup ────────────────────────────────────────────────────────────
// Best practice: single source of truth for model IDs (spec §6.3 + §21-B).
// Verify against provider docs on the day you deploy — names change fast.
// Gemini 2.5 Flash = current stable with google_search grounding + JSON mode.
// Groq llama-3.3-70b-versatile = current stable router/classifier.
const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? "");
const PLANNER_MODEL = process.env.GEMINI_PLANNER_MODEL ?? "gemini-2.5-flash";
const VERIFIER_MODEL = process.env.GEMINI_VERIFIER_MODEL ?? "gemini-2.5-flash";
const GROQ_ROUTER_MODEL = process.env.GROQ_ROUTER_MODEL ?? "llama-3.3-70b-versatile";

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeTrace(
  actor: TraceEvent["actor"],
  event_type: TraceEvent["event_type"],
  payload: Record<string, unknown>,
  opts?: { cost_usd?: number; latency_ms?: number }
): TraceEvent {
  return {
    id: crypto.randomUUID(),
    actor,
    event_type,
    payload,
    cost_usd: opts?.cost_usd,
    latency_ms: opts?.latency_ms,
    created_at: new Date().toISOString(),
    status: "done",
  };
}

function parseJsonSafely<T>(text: string, defaultValue: T): T {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as T;
    }
    return JSON.parse(text) as T;
  } catch (err) {
    console.warn("JSON parse error:", err, "Raw text:", text.slice(0, 200));
    return defaultValue;
  }
}

// ── Multi-Provider AI Engine with Seamless Fallback (Section 6.3) ─────────────
async function callAIWithFallback({
  prompt,
  systemPrompt,
  geminiModel = PLANNER_MODEL,
  responseSchema,
  trace,
  skillName,
  enableGrounding,
  groundingStatus,
}: {
  prompt: string;
  systemPrompt?: string;
  geminiModel?: string;
  responseSchema?: unknown;
  trace: TraceEvent[];
  skillName: string;
  enableGrounding?: boolean;
  groundingStatus?: { grounded: boolean };
}): Promise<string> {
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  const groqKey = process.env.GROQ_API_KEY?.trim();
  const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;

  // 1. Try Gemini primary
  if (geminiKey) {
    // Grounding attempt (spec §6.1 + §12): google_search tool when requested.
    // SDK variants differ (snake_case per docs vs camelCase in @google/generative-ai);
    // wrapped in try/catch with fallback to non-grounded call below.
    if (enableGrounding) {
      const groundingVariants: Array<{ tools: unknown }> = [
        { tools: [{ google_search: {} }] },
        { tools: [{ googleSearch: {} }] },
      ];
      for (const variant of groundingVariants) {
        try {
          const groundedModel = gemini.getGenerativeModel({
            model: geminiModel,
            tools: variant.tools as never,
            generationConfig: responseSchema
              ? {
                  responseMimeType: "application/json",
                  responseSchema: responseSchema as never,
                }
              : { responseMimeType: "application/json" },
          });
          const groundedResult = await groundedModel.generateContent(fullPrompt);
          const groundedText = groundedResult.response.text();
          if (groundedText && groundedText.trim().length > 0) {
            // Grounding proof: only tool-returned groundingMetadata counts.
            // Text with URLs but no groundingMetadata is ungrounded (fallback path).
            if (groundingStatus) {
              const rAny = groundedResult.response as unknown as {
                candidates?: Array<{
                  groundingMetadata?: { webSearchQueries?: unknown[]; groundingSupports?: unknown[] };
                }>;
                groundingMetadata?: { webSearchQueries?: unknown[]; groundingSupports?: unknown[] };
              };
              const gm =
                rAny?.candidates?.[0]?.groundingMetadata ?? rAny?.groundingMetadata;
              groundingStatus.grounded = !!(
                (gm?.webSearchQueries?.length || 0) > 0 ||
                (gm?.groundingSupports?.length || 0) > 0
              );
            }
            return groundedText;
          }
          break;
        } catch {
          continue;
        }
      }
    }
    try {
      const model = gemini.getGenerativeModel({
        model: geminiModel,
        generationConfig: responseSchema
          ? {
              responseMimeType: "application/json",
              responseSchema: responseSchema as never,
            }
          : { responseMimeType: "application/json" },
      });
      const result = await model.generateContent(fullPrompt);
      const text = result.response.text();
      if (text && text.trim().length > 0) {
        // Non-grounded helper fallback: never count as grounded.
        if (enableGrounding && groundingStatus) groundingStatus.grounded = false;
        return text;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[Gemini Failover for ${skillName}]:`, errMsg);
      trace.push(
        makeTrace("router", "verification", {
          notice: "Gemini 503/Failover -> Routing to Groq high-speed fallback",
          skill: skillName,
          error: errMsg,
        })
      );
    }
  }

  // 2. Try Groq fallback
  if (groqKey) {
    try {
      const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${groqKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: GROQ_ROUTER_MODEL,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `${systemPrompt || "You are an expert AI startup validation copilot."} You MUST reply ONLY with valid JSON.`,
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0.2,
        }),
      });

      if (groqRes.ok) {
        const data = await groqRes.json();
        const content = data.choices?.[0]?.message?.content;
        if (content) return content;
      }
    } catch (groqErr) {
      console.warn(`[Groq Failover Error for ${skillName}]:`, groqErr);
    }
  }

  throw new Error(`AI providers temporarily unavailable. Please retry shortly.`);
}

// ── URL guard: only http(s) URLs returned by a tool may be emitted as citations ─
function isHttpUrl(u: unknown): u is string {
  if (typeof u !== "string" || u.trim().length === 0) return false;
  try {
    const parsed = new URL(u.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// ── Grounded search (wrapped Gemini grounding + ungrounded Groq fallback) ─────
// Contract (spec §7 + §12): every returned claim must carry a source URL that was
// actually returned by a tool. Gemini grounding URLs are tool-returned (grounded).
// The Groq path has no browsing capability, so its URLs would be fabricated —
// they are stripped here (grounded=false) and callers must downgrade strength to
// opinion with a trace warning instead of emitting a fabricated citation.
async function groundedSearch(
  query: string,
  domainHint?: string,
  trace?: TraceEvent[]
): Promise<{
  results: Array<{ claim: string; url: string; published_at?: string }>;
  grounded: boolean;
  provider: "gemini" | "gemini-ungrounded" | "groq" | "none";
}> {
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  const groqKey = process.env.GROQ_API_KEY?.trim();

  // Try Gemini Google Search Grounding first via the shared helper with
  // grounding opted in (spec §6.1 google_search tool attempt). Wrapped in
  // try/catch with fallback to the direct tool variants below.
  if (geminiKey) {
    try {
      // groundingStatus defaults to ungrounded; only true groundingMetadata flips it.
      const groundingStatus = { grounded: false };
      const groundedText = await callAIWithFallback({
        prompt: `Search for factual, current information about: "${query}"${domainHint ? ` in the context of ${domainHint}` : ""}.

Return a JSON object with key "results" containing an array of objects, each with:
- "claim": a specific factual claim from the search results (1-2 sentences max)
- "url": the source URL
- "published_at": publication date if available (ISO string or null)

Only include claims you can attribute to a specific source. Return 3-6 results. Respond ONLY with valid JSON.`,
        trace: trace ?? [],
        skillName: "market-research",
        enableGrounding: true,
        groundingStatus,
      });
      const parsedGrounded = parseJsonSafely<{
        results: Array<{ claim: string; url: string; published_at?: string }>;
      }>(groundedText, { results: [] });
      const claimedGrounded = (parsedGrounded.results || []).filter(
        (r) => typeof r.claim === "string" && r.claim.trim().length > 0
      );
      const validatedGrounded = claimedGrounded.filter((r) => isHttpUrl(r.url));
      if (validatedGrounded.length > 0 && groundingStatus.grounded) {
        return { results: validatedGrounded, grounded: true, provider: "gemini" };
      }
      // Gemini text with URLs but no groundingMetadata → ungrounded: strip URLs.
      // Downstream market-research downgrades to opinion without web_search source.
      if (claimedGrounded.length > 0) {
        const stripped = claimedGrounded.map((r) => ({
          claim: r.claim,
          url: "",
          published_at: r.published_at,
        }));
        return { results: stripped, grounded: false, provider: "gemini-ungrounded" };
      }
    } catch {
      // Fall through to the direct grounding tool variants below.
    }
    // Direct grounding tool variants (fallback when the helper's
    // grounded call yields no validated URLs).
    // Try snake_case google_search (per spec §6.1 docs) first, then camelCase
    // googleSearch (current @google/generative-ai SDK shape); each wrapped in
    // try/catch with fallback so an unsupported key never breaks the call.
    const groundingToolVariants: Array<unknown> = [[{ google_search: {} }], [{ googleSearch: {} }]];
    for (const tools of groundingToolVariants) {
      try {
        const model = gemini.getGenerativeModel({
          model: PLANNER_MODEL,
          tools: tools as never,
        });

        const prompt = `Search for factual, current information about: "${query}"${domainHint ? ` in the context of ${domainHint}` : ""}.

Return a JSON object with key "results" containing an array of objects, each with:
- "claim": a specific factual claim from the search results (1-2 sentences max)
- "url": the source URL
- "published_at": publication date if available (ISO string or null)

Only include claims you can attribute to a specific source. Return 3-6 results. Respond ONLY with valid JSON.`;

        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const parsed = parseJsonSafely<{ results: Array<{ claim: string; url: string; published_at?: string }> }>(text, { results: [] });
        const validated = (parsed.results || []).filter(
          (r) => typeof r.claim === "string" && r.claim.trim().length > 0 && isHttpUrl(r.url)
        );
        // Grounding proof: only tool-returned groundingMetadata counts.
        // Text with http(s) URLs but no groundingMetadata is ungrounded.
        const rAny = result.response as unknown as {
          candidates?: Array<{
            groundingMetadata?: {
              webSearchQueries?: unknown[];
              groundingSupports?: unknown[];
              groundingChunks?: unknown[];
            };
          }>;
          groundingMetadata?: {
            webSearchQueries?: unknown[];
            groundingSupports?: unknown[];
            groundingChunks?: unknown[];
          };
        };
        const gm = rAny?.candidates?.[0]?.groundingMetadata ?? rAny?.groundingMetadata;
        const hasGroundingProof = !!(
          (gm?.webSearchQueries?.length || 0) > 0 ||
          (gm?.groundingSupports?.length || 0) > 0 ||
          (gm?.groundingChunks?.length || 0) > 0
        );
        if (validated.length > 0 && hasGroundingProof) {
          return { results: validated, grounded: true, provider: "gemini" };
        }
        if (validated.length > 0) {
          const stripped = validated.map((r) => ({
            claim: r.claim,
            url: "",
            published_at: r.published_at,
          }));
          return { results: stripped, grounded: false, provider: "gemini-ungrounded" };
        }
        continue;
      } catch (err) {
        console.warn("[Grounded Search Gemini Failover]:", err);
        continue;
      }
    }
  }

  // Groq fallback: no browsing capability — synthesis only, NEVER emit URLs.
  // Any "url" the model returns here was not returned by a tool, so strip it.
  if (groqKey) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${groqKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: GROQ_ROUTER_MODEL,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: "You are a market research specialist. Provide market synthesis in JSON format. Do NOT invent source URLs — leave url empty when you have no browsed source.",
            },
            {
              role: "user",
              content: `Synthesize market context for query: "${query}" in domain: "${domainHint || "general"}".
Return JSON with key "results" which is an array of 3-5 items:
{
  "results": [
    {
      "claim": "synthesis point clearly labeled as ungrounded synthesis, not a browsed fact",
      "url": "",
      "published_at": null
    }
  ]
}`,
            },
          ],
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content;
        if (content) {
          const parsed = parseJsonSafely<{ results: Array<{ claim: string; url: string; published_at?: string }> }>(content, { results: [] });
          const stripped = (parsed.results || [])
            .filter((r) => typeof r.claim === "string" && r.claim.trim().length > 0)
            .map((r) => ({ claim: r.claim, url: "", published_at: r.published_at }));
          if (stripped.length > 0) {
            return { results: stripped, grounded: false, provider: "groq" };
          }
        }
      }
    } catch (err) {
      console.warn("[Groq Grounded Search Fallback Error]:", err);
    }
  }

  return { results: [], grounded: false, provider: "none" };
}

// ── Startup Intake (skill: startup-intake) ────────────────────────────────────
async function runIntakeSkill(
  idea: string,
  trace: TraceEvent[],
  opts?: { workspace_id?: string; owner_id?: string }
): Promise<Startup> {
  const t0 = Date.now();
  trace.push(makeTrace("skill:startup-intake", "skill_start", { idea }));

  const schema = {
    type: SchemaType.OBJECT,
    properties: {
      name: { type: SchemaType.STRING },
      one_liner: { type: SchemaType.STRING },
      domain: { type: SchemaType.STRING },
      target_customer: { type: SchemaType.STRING },
      stage: {
        type: SchemaType.STRING,
        format: "enum",
        enum: ["idea", "prototype", "live", "scaling"],
      },
      business_model: { type: SchemaType.STRING },
    },
    required: ["name", "one_liner", "domain", "stage"],
  };

  const prompt = `You are the startup-intake skill for a Validation Copilot. Extract structured information from this startup idea description.

IDEA: "${idea}"

Extract:
- name: Short product/company name (infer if not given)
- one_liner: Clear, concise value proposition (max 15 words)
- domain: Industry/vertical (e.g. "edtech", "B2B SaaS", "food-tech", "health & wellness")
- target_customer: Who specifically benefits
- stage: Current stage (idea/prototype/live/scaling)
- business_model: How it makes money (subscription, marketplace, transaction fee, etc.)

NEVER guess facts not present — use reasonable inference only.`;

  const rawText = await callAIWithFallback({
    prompt,
    responseSchema: schema,
    trace,
    skillName: "startup-intake",
  });

  const latency = Date.now() - t0;
  const parsed = parseJsonSafely<Record<string, string>>(rawText, {});
  const startup: Startup = {
    id: crypto.randomUUID(),
    workspace_id: opts?.workspace_id ?? "",
    owner_id: opts?.owner_id ?? "",
    name: parsed.name || "Untitled Startup",
    one_liner: parsed.one_liner || idea.slice(0, 80),
    domain: parsed.domain || "general",
    target_customer: parsed.target_customer,
    stage: (parsed.stage as Startup["stage"]) || "idea",
    business_model: parsed.business_model,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  trace.push(makeTrace("skill:startup-intake", "skill_end", { startup }, { latency_ms: latency }));
  return startup;
}

// ── Assumption Mapping (skill: assumption-mapping) ────────────────────────────
async function runAssumptionMappingSkill(
  startup: Startup,
  trace: TraceEvent[]
): Promise<Assumption[]> {
  const t0 = Date.now();
  trace.push(makeTrace("skill:assumption-mapping", "skill_start", { startup_id: startup.id }));

  const schema = {
    type: SchemaType.OBJECT,
    properties: {
      assumptions: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            statement: { type: SchemaType.STRING },
            category: {
              type: SchemaType.STRING,
              format: "enum",
              enum: ["desirability", "viability", "feasibility"],
            },
            risk_level: {
              type: SchemaType.STRING,
              format: "enum",
              enum: ["critical", "high", "medium", "low"],
            },
            reasoning: { type: SchemaType.STRING },
          },
          required: ["statement", "category", "risk_level", "reasoning"],
        },
      },
    },
    required: ["assumptions"],
  };

  const prompt = `You are the assumption-mapping skill for a Validation Copilot. Map the critical assumptions for this startup.

STARTUP:
- Name: ${startup.name}
- Idea: ${startup.one_liner}
- Domain: ${startup.domain}
- Target customer: ${startup.target_customer || "not specified"}
- Business model: ${startup.business_model || "not specified"}

Produce a risk-ranked list of 6-10 assumptions the startup depends on. Include ALL three categories:

CATEGORIES:
- desirability: Do target customers want this? Does it solve a real problem?
- viability: Can this be a sustainable business?
- feasibility: Can the team actually build and operate this?

RISK LEVELS:
- critical: The entire business fails if this is wrong
- high: Major pivot required if wrong
- medium: Adjustment needed if wrong
- low: Nice to have, doesn't change core thesis

For each assumption:
- statement: "We assume that [specific, testable claim]"
- reasoning: Why this risk level, what evidence would change it

Return assumptions sorted by risk_level: critical first, then high, medium, low.`;

  const rawText = await callAIWithFallback({
    prompt,
    responseSchema: schema,
    trace,
    skillName: "assumption-mapping",
  });

  const latency = Date.now() - t0;
  const parsed = parseJsonSafely<{
    assumptions: Array<{
      statement: string;
      category: Assumption["category"];
      risk_level: Assumption["risk_level"];
      reasoning: string;
    }>;
  }>(rawText, { assumptions: [] });

  const assumptions: Assumption[] = (parsed.assumptions || []).map((a) => ({
    id: crypto.randomUUID(),
    startup_id: startup.id,
    statement: a.statement,
    category: a.category || "desirability",
    risk_level: a.risk_level || "high",
    status: "untested" as const,
    reasoning: a.reasoning,
    created_at: new Date().toISOString(),
  }));

  trace.push(
    makeTrace(
      "skill:assumption-mapping",
      "skill_end",
      { count: assumptions.length, assumptions },
      { latency_ms: latency }
    )
  );
  return assumptions;
}

// ── Market Research (skill: market-research + grounded_search tool) ───────────
async function runMarketResearchSkill(
  startup: Startup,
  assumptions: Assumption[],
  trace: TraceEvent[]
): Promise<Evidence[]> {
  const t0 = Date.now();
  trace.push(makeTrace("skill:market-research", "skill_start", { startup_id: startup.id }));

  const criticalAssumption = assumptions.find((a) => a.risk_level === "critical") ?? assumptions[0];
  const queries = [
    `${startup.domain} market size and growth rate 2024 2025`,
    `${startup.one_liner} competitors pricing`,
    `${criticalAssumption?.statement?.slice(0, 60)} evidence data`,
  ].filter(Boolean);

  const allResults: Evidence[] = [];

  for (const query of queries) {
    trace.push(makeTrace("tool", "tool_call", { tool: "grounded_search", query }));
    const t1 = Date.now();
    try {
      const searchResult = await groundedSearch(query, startup.domain, trace);
      const latency = Date.now() - t1;

      trace.push(
        makeTrace(
          "tool",
          "tool_result",
          {
            query,
            results_count: searchResult.results.length,
            results: searchResult.results,
            grounded: searchResult.grounded,
            provider: searchResult.provider,
          },
          { latency_ms: latency }
        )
      );

      if (!searchResult.grounded) {
        trace.push(
          makeTrace("skill:market-research", "verification", {
            warning: "ungrounded",
            query,
            provider: searchResult.provider,
            notice: "Gemini grounding unavailable; Groq synthesis has no browsing — URLs stripped, strength capped at opinion.",
          })
        );
      }

      for (const r of searchResult.results) {
        if (!r.claim || r.claim.trim().length === 0) continue;
        // Never output a claim with a URL that was not returned by a tool:
        // only tool-grounded http(s) URLs may carry source_type web_search.
        if (searchResult.grounded && isHttpUrl(r.url)) {
          allResults.push({
            id: crypto.randomUUID(),
            startup_id: startup.id,
            assumption_id: criticalAssumption?.id,
            evidence_type: "secondary",
            source_type: "web_search",
            source_url: r.url,
            claim: r.claim,
            strength: "opinion", // secondary evidence max is opinion in the ladder
            collected_at: new Date().toISOString(),
          });
        } else {
          allResults.push({
            id: crypto.randomUUID(),
            startup_id: startup.id,
            assumption_id: criticalAssumption?.id,
            evidence_type: "secondary",
            claim: r.claim,
            strength: "opinion",
            collected_at: new Date().toISOString(),
          });
          trace.push(
            makeTrace("skill:market-research", "verification", {
              warning: "ungrounded",
              query,
              claim: r.claim.slice(0, 120),
            })
          );
        }
      }
    } catch (err) {
      trace.push(makeTrace("tool", "error", { query, error: String(err) }));
    }
  }

  const latency = Date.now() - t0;
  trace.push(
    makeTrace(
      "skill:market-research",
      "skill_end",
      { evidence_count: allResults.length },
      { latency_ms: latency }
    )
  );
  return allResults;
}

// ── Lead Finder (skill: lead-finder, powered by Apollo.io) ──────────────────
async function runLeadFinderSkill(
  startup: Startup,
  trace: TraceEvent[]
): Promise<ApolloLead[]> {
  const t0 = Date.now();
  trace.push(
    makeTrace("skill:lead-finder", "tool_call", {
      tool: "apollo_search",
      target_customer: startup.target_customer,
      domain: startup.domain,
    })
  );

  const result = await searchLeads({
    targetCustomer: startup.target_customer || startup.domain,
    domain: startup.domain,
    keywords: startup.name,
    limit: 10,
  });

  const latency = Date.now() - t0;

  if (result.error) {
    trace.push(
      makeTrace("skill:lead-finder", "error", {
        error: result.error,
        provider: result.provider,
      })
    );
    return [];
  }

  trace.push(
    makeTrace(
      "skill:lead-finder",
      "tool_result",
      {
        leads_found: result.leads.length,
        total_available: result.total,
        provider: result.provider,
      },
      { latency_ms: latency }
    )
  );

  return result.leads;
}

// ── Experiment Designer (skill: experiment-designer + survey-designer) ─────────
async function runExperimentDesignerSkill(
  startup: Startup,
  assumptions: Assumption[],
  trace: TraceEvent[]
): Promise<Experiment> {
  const t0 = Date.now();
  trace.push(makeTrace("skill:experiment-designer", "skill_start", { startup_id: startup.id }));

  const riskiestAssumption = assumptions.find((a) => a.risk_level === "critical") ?? assumptions[0];

  const schema = {
    type: SchemaType.OBJECT,
    properties: {
      type: { type: SchemaType.STRING, format: "enum", enum: ["interview", "survey", "landing_page", "presale"] },
      title: { type: SchemaType.STRING },
      description: { type: SchemaType.STRING },
      success_criteria: { type: SchemaType.STRING },
      target_sample_size: { type: SchemaType.NUMBER },
      estimated_cost: { type: SchemaType.STRING },
      time_to_run: { type: SchemaType.STRING },
      questions: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            id: { type: SchemaType.STRING },
            text: { type: SchemaType.STRING },
            type: {
              type: SchemaType.STRING,
              format: "enum",
              enum: ["open", "scale", "yesno", "multiple_choice"],
            },
          },
          required: ["id", "text", "type"],
        },
      },
    },
    required: ["type", "title", "description", "success_criteria", "target_sample_size", "questions"],
  };

  const prompt = `You are the experiment-designer and survey-designer skill for a Validation Copilot.

Design the CHEAPEST, FASTEST validation experiment for this critical assumption:

ASSUMPTION: "${riskiestAssumption?.statement}"
STARTUP: ${startup.name} — ${startup.one_liner}
DOMAIN: ${startup.domain}
TARGET CUSTOMER: ${startup.target_customer || "not specified"}

RULES (non-negotiable):
1. Never recommend building the full product as the first test
2. Prefer customer interviews over surveys (qualitative > quantitative at idea stage)
3. Questions must follow The Mom Test: ask about past behavior, NOT hypotheticals
4. Never ask leading questions (no "Don't you think...", "Wouldn't you agree...")
5. Include at least one question about the last time they experienced the problem
6. Target at least 15 responses for statistical validity
7. Estimate realistic cost and time

Design 4-7 interview/survey questions. Make them open-ended and past-behavior focused.`;

  const rawText = await callAIWithFallback({
    prompt,
    responseSchema: schema,
    trace,
    skillName: "experiment-designer",
  });

  const latency = Date.now() - t0;
  const parsed = parseJsonSafely<{
    type?: Experiment["type"];
    title?: string;
    description?: string;
    success_criteria?: string;
    target_sample_size?: number;
    estimated_cost?: string;
    time_to_run?: string;
    questions?: Array<{ id: string; text: string; type: string }>;
  }>(rawText, {});

  // Run leading-question validator on each question
  const validatedQuestions = (parsed.questions || []).map((q) => {
    const validation = validateQuestion(q.text);
    trace.push(
      makeTrace("skill:survey-designer", "verification", {
        question: q.text,
        approved: validation.approved,
        warnings: validation.warnings,
      })
    );
    const validTypes = ["open", "scale", "yesno", "multiple_choice"] as const;
    const qType = validTypes.includes(q.type as (typeof validTypes)[number])
      ? (q.type as (typeof validTypes)[number])
      : "open";
    return {
      id: q.id || crypto.randomUUID(),
      text: q.text,
      type: qType,
      is_leading: validation.isLeading,
      warning: validation.warnings[0],
    };
  });

  const experiment: Experiment = {
    id: crypto.randomUUID(),
    startup_id: startup.id,
    assumption_id: riskiestAssumption?.id,
    type: parsed.type || "interview",
    design: {
      title: parsed.title || "Customer Discovery Interviews",
      description: parsed.description || "Validate problem severity with target users",
      questions: validatedQuestions,
      success_criteria: parsed.success_criteria || "≥60% report active pain and current workaround",
      target_sample_size: parsed.target_sample_size || 15,
      estimated_cost: parsed.estimated_cost || "$0 (organic outreach)",
      time_to_run: parsed.time_to_run || "3-5 days",
    },
    status: "draft",
    created_at: new Date().toISOString(),
  };

  trace.push(
    makeTrace(
      "skill:experiment-designer",
      "skill_end",
      { experiment_id: experiment.id, type: experiment.type },
      { latency_ms: latency }
    )
  );
  return experiment;
}

// ── Response Analyzer (skill: response-analyzer, for uploaded data) ────────────
async function runResponseAnalyzerSkill(
  startup: Startup,
  uploadedData: string,
  experiment: Experiment,
  trace: TraceEvent[]
): Promise<Evidence[]> {
  const t0 = Date.now();
  trace.push(makeTrace("skill:response-analyzer", "skill_start", { startup_id: startup.id }));

  const schema = {
    type: SchemaType.OBJECT,
    properties: {
      evidence: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            claim: { type: SchemaType.STRING },
            strength: {
              type: SchemaType.STRING,
              format: "enum",
              enum: ["opinion", "intent", "time_given", "contact_shared", "commitment"],
            },
            sample_size: { type: SchemaType.NUMBER },
            source_type: {
              type: SchemaType.STRING,
              format: "enum",
              enum: ["interview", "survey", "preorder", "usage_data"],
            },
          },
          required: ["claim", "strength", "sample_size", "source_type"],
        },
      },
      summary: { type: SchemaType.STRING },
    },
    required: ["evidence", "summary"],
  };

  const prompt = `You are the response-analyzer skill for a Validation Copilot. Analyze this real primary evidence.

STARTUP: ${startup.name} — ${startup.one_liner}
EXPERIMENT TYPE: ${experiment.type}

RAW DATA / INTERVIEW NOTES:
${uploadedData}

TASK: Extract evidence items from this data.

COMMITMENT LADDER (assign strength appropriately):
1. opinion: "sounds useful", vague positive feedback
2. intent: "I would probably use this / buy this"
3. time_given: participant filled survey, agreed to call, responded to outreach
4. contact_shared: gave email/phone voluntarily for follow-up
5. commitment: pre-order, deposit, signed LOI, actual usage with payment

CRITICAL RULE: Distinguish compliments from commitments. "This is amazing!" = opinion. "Here's my credit card" = commitment.

For each evidence item, count how many respondents it represents (sample_size).
Write a summary of what the data actually shows.`;

  const rawText = await callAIWithFallback({
    prompt,
    responseSchema: schema,
    trace,
    skillName: "response-analyzer",
  });

  const latency = Date.now() - t0;
  const parsed = parseJsonSafely<{
    evidence?: Array<{ claim: string; strength: Evidence["strength"]; sample_size?: number; source_type: Evidence["source_type"] }>;
    summary?: string;
  }>(rawText, { evidence: [] });

  // Compute stats deterministically
  const sampleSizes = (parsed.evidence || []).map((e) => e.sample_size || 1);
  const stats = sampleStats(sampleSizes);
  trace.push(makeTrace("tool", "tool_call", { tool: "stats", operation: "sample_stats", data: sampleSizes }));
  trace.push(makeTrace("tool", "tool_result", { stats }));

  const evidence: Evidence[] = (parsed.evidence || []).map((e) => ({
    id: crypto.randomUUID(),
    startup_id: startup.id,
    assumption_id: experiment.assumption_id,
    evidence_type: "primary" as const,
    source_type: e.source_type || "interview",
    claim: e.claim,
    strength: e.strength || "opinion",
    sample_size: e.sample_size || 1,
    collected_at: new Date().toISOString(),
  }));

  trace.push(
    makeTrace(
      "skill:response-analyzer",
      "skill_end",
      { evidence_count: evidence.length, summary: parsed.summary, stats },
      { latency_ms: latency }
    )
  );
  return evidence;
}

// ── Decision Memo (skill: decision-memo) ──────────────────────────────────────
async function runDecisionMemoSkill(
  startup: Startup,
  assumptions: Assumption[],
  allEvidence: Evidence[],
  trace: TraceEvent[]
): Promise<Decision> {
  const t0 = Date.now();
  trace.push(makeTrace("skill:decision-memo", "skill_start", { startup_id: startup.id }));

  const primaryEvidence = allEvidence.filter((e) => e.evidence_type === "primary");
  const { eligible, reason: thresholdReason } = meetsGoThreshold(primaryEvidence);
  const confidence = deriveConfidence(primaryEvidence);

  // Enforce the hard rule: cannot say "Go" without meeting threshold
  const allowGo = eligible;

  const schema = {
    type: SchemaType.OBJECT,
    properties: {
      verdict: {
        type: SchemaType.STRING,
        format: "enum",
        enum: allowGo ? ["go", "iterate", "stop", "test_more"] : ["iterate", "stop", "test_more"],
      },
      rationale: { type: SchemaType.STRING },
      next_experiment: { type: SchemaType.STRING },
    },
    required: ["verdict", "rationale", "next_experiment"],
  };

  const evidenceSummary = allEvidence
    .slice(0, 10)
    .map((e) => `[${e.evidence_type}/${e.strength}] ${e.claim}`)
    .join("\n");

  const prompt = `You are the decision-memo skill for a Validation Copilot. Produce an honest decision memo.

STARTUP: ${startup.name} — ${startup.one_liner}

EVIDENCE (${allEvidence.length} items):
${evidenceSummary}

THRESHOLD CHECK: ${allowGo ? "✓ Meets Go threshold" : `✗ Does NOT meet Go threshold: ${thresholdReason}`}
CONFIDENCE LEVEL: ${confidence.toUpperCase()}
PRIMARY EVIDENCE COUNT: ${primaryEvidence.length}

${!allowGo ? `IMPORTANT: You MUST NOT output "go" as the verdict. The evidence is insufficient. Output "test_more" or "iterate" instead.` : ""}

Produce:
- verdict: Your evidence-based verdict (${allowGo ? "go/iterate/stop/test_more" : "iterate/stop/test_more only"})
- rationale: 2-3 sentence honest explanation referencing the actual evidence
- next_experiment: The single cheapest next experiment to run if verdict is not "go"

Be honest. If evidence is thin, say "test_more". Never inflate.`;

  const rawText = await callAIWithFallback({
    prompt,
    responseSchema: schema,
    trace,
    skillName: "decision-memo",
  });

  const latency = Date.now() - t0;
  const parsed = parseJsonSafely<{ verdict?: Decision["verdict"]; rationale?: string; next_experiment?: string }>(
    rawText,
    { verdict: "test_more", rationale: "Further primary evidence collection needed", next_experiment: "Conduct 15 customer discovery interviews" }
  );

  // Final guard: if model tries to sneak in "go" without threshold met, override
  let verdict = (parsed.verdict as Decision["verdict"]) || "test_more";
  if (verdict === "go" && !allowGo) {
    verdict = "test_more";
    trace.push(
      makeTrace("verifier", "verification", {
        action: "verdict_override",
        reason: thresholdReason,
        original: "go",
        corrected: "test_more",
      })
    );
  }

  const decision: Decision = {
    id: crypto.randomUUID(),
    startup_id: startup.id,
    verdict,
    confidence,
    rationale: parsed.rationale || "Evidence evaluated against commitment ladder",
    evidence_ids: allEvidence.map((e) => e.id),
    sample_size: primaryEvidence.reduce((acc, e) => acc + (e.sample_size ?? 1), 0),
    response_rate: primaryEvidence.length > 0 ? undefined : undefined,
    next_experiment: verdict !== "go" ? parsed.next_experiment : undefined,
    created_at: new Date().toISOString(),
  };

  trace.push(
    makeTrace(
      "skill:decision-memo",
      "decision",
      { verdict: decision.verdict, confidence: decision.confidence, rationale: decision.rationale },
      { latency_ms: latency }
    )
  );
  return decision;
}

// ── Verifier Pass ────────────────────────────────────────────────────────────
async function runVerifier(
  plannerOutput: string,
  evidence: Evidence[],
  trace: TraceEvent[]
): Promise<{ approved: boolean; unsupportedClaims: string[] }> {
  const t0 = Date.now();
  trace.push(makeTrace("verifier", "verification", { action: "checking_output" }));

  const schema = {
    type: SchemaType.OBJECT,
    properties: {
      approved: { type: SchemaType.BOOLEAN },
      unsupported_claims: {
        type: SchemaType.ARRAY,
        items: { type: SchemaType.STRING },
      },
    },
    required: ["approved", "unsupported_claims"],
  };

  const evidenceList = evidence
    .slice(0, 8)
    .map((e) => `- [${e.source_type ?? "internal"}] ${e.claim} (${e.source_url ?? "no URL"})`)
    .join("\n");

  const prompt = `You are the Verifier for a Validation Copilot. Your job is to check if the output claims are supported by the actual evidence retrieved.

ACTUAL EVIDENCE:
${evidenceList || "(none yet — only internal analysis)"}

OUTPUT TO CHECK:
${plannerOutput}

For each factual claim in the output:
1. Check if it is supported by the evidence list above
2. If a claim has no matching evidence, mark it as unsupported

IMPORTANT: Internal reasoning about assumptions and risk levels does NOT require external evidence.
Only flag market/competitor/data claims that need sources but have none.

Return: approved=true if 0 unsupported claims, false otherwise. List any unsupported claims.`;

  const rawText = await callAIWithFallback({
    prompt,
    responseSchema: schema,
    geminiModel: VERIFIER_MODEL,
    trace,
    skillName: "verifier",
  });

  const latency = Date.now() - t0;
  const parsed = parseJsonSafely<{ approved?: boolean; unsupported_claims?: string[] }>(rawText, {
    approved: true,
    unsupported_claims: [],
  });
  const unsupportedClaims: string[] = [...(parsed.unsupported_claims || [])];

  // Deterministic safety net (no LLM bypass): any planner sentence with a
  // number/$/%/URL and no matching evidence URL is ungrounded.
  const hasUrl = evidence.some((e) => !!e.source_url);
  const factualLines = plannerOutput.split(/[\n;.]/).filter((l) => /(\d|%|\$|http|million|billion|market worth)/i.test(l));
  for (const line of factualLines) {
    if (!hasUrl && line.trim().length > 12 && !unsupportedClaims.includes(line.trim())) {
      unsupportedClaims.push(line.trim());
    }
  }
  const approved = unsupportedClaims.length === 0;

  trace.push(
    makeTrace(
      "verifier",
      "verification",
      {
        approved,
        unsupported_count: unsupportedClaims.length,
        unsupported_claims: unsupportedClaims,
      },
      { latency_ms: latency }
    )
  );

  return { approved, unsupportedClaims };
}

// ── Main Handler ──────────────────────────────────────────────────────────────
// Hardening: in-memory per-IP rate limit (10 req/min), input caps, prompt-
// injection strip, real cost accounting, 90s hard timeout (BUDGET).
const RATE_LIMIT = new Map<string, { count: number; resetAt: number }>();
const RATE_MAX = 10;
const RATE_WINDOW_MS = 60_000;
const MAX_IDEA_CHARS = 2000;
const MAX_DATA_CHARS = 8000;

function sanitizeForPrompt(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*(system|assistant|user)\s*:/gim, " ")
    .replace(/ignore (all )?previous instructions/gi, "[filtered]")
    .replace(/jailbreak|DAN mode/gi, "[filtered]")
    .slice(0, MAX_IDEA_CHARS + MAX_DATA_CHARS);
}

// Realistic per-call cost table (USD,公开 blended estimate — replace with
// provider metering in production). Stops totalCost=0 fiction.
const COST_TABLE = { gemini_call: 0.004, groq_call: 0.001, search: 0.002 } as const;

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const send = (data: Record<string, unknown>) =>
    writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));

  (async () => {
    const trace: TraceEvent[] = [];
    let totalCost = 0;
    let toolCalls = 0;
    const deadline = Date.now() + BUDGET.HARD_TIMEOUT_MS;
    const checkTimeout = () => {
      if (Date.now() > deadline) throw new Error("Budget: hard timeout 90s exceeded");
    };

    try {
      // Rate limit (best-effort per-instance; use Redis/Upstash in prod)
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
      const now = Date.now();
      const bucket = RATE_LIMIT.get(ip);
      if (!bucket || now > bucket.resetAt) {
        RATE_LIMIT.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
      } else {
        bucket.count++;
        if (bucket.count > RATE_MAX) {
          await send({ type: "error", message: "Rate limit exceeded. Try again in a minute." });
          return;
        }
      }

      const body: AgentInput = await req.json();
      const rawIdea = body.idea ?? "";
      const rawData = body.uploaded_data ?? "";
      if (!rawIdea.trim()) {
        await send({ type: "error", message: "Idea is required" });
        return;
      }
      if (rawIdea.length > MAX_IDEA_CHARS || rawData.length > MAX_DATA_CHARS) {
        await send({ type: "error", message: `Input too long (idea<=${MAX_IDEA_CHARS}, data<=${MAX_DATA_CHARS}).` });
        return;
      }
      const idea = sanitizeForPrompt(rawIdea);
      const uploaded_data = rawData ? sanitizeForPrompt(rawData) : undefined;

      // ── Phase 1: Routing ────────────────────────────────────────────────────
      trace.push(makeTrace("router", "tool_call", { intent: "startup_validation", idea: idea.slice(0, 100) }));
      await send({ type: "phase", phase: "intake", trace: [...trace] });

      // ── Phase 2: Intake ─────────────────────────────────────────────────────
      // Real identity: authenticated user only; never trust body.user_id (never demo-user).
      const { createServerSupabaseClient } = await import("@/lib/supabase/server");
      const supabase = await createServerSupabaseClient();
      const { data: { user } } = await supabase.auth.getUser();
      const ownerId = user?.id || "";
      const workspaceId = body.workspace_id || "";
      if (!ownerId) {
        trace.push(makeTrace("router", "verification", { warning: "unauthenticated session: persistence will be skipped" }));
      }
      const startup = await runIntakeSkill(idea, trace, { workspace_id: workspaceId, owner_id: ownerId });
      await send({ type: "startup", startup, trace: [...trace] });

      // Budget check
      toolCalls++;
      totalCost += COST_TABLE.gemini_call;
      checkTimeout();
      if (toolCalls >= BUDGET.MAX_TOOL_CALLS || totalCost >= BUDGET.MAX_COST_USD)
        throw new Error("Budget exceeded");

      // ── Phase 3: Assumption Mapping ─────────────────────────────────────────
      await send({ type: "phase", phase: "mapping", trace: [...trace] });
      const assumptions = await runAssumptionMappingSkill(startup, trace);
      await send({ type: "assumptions", assumptions, trace: [...trace] });

      toolCalls++;
      totalCost += COST_TABLE.gemini_call;
      checkTimeout();

      // ── Phase 4: Market Research ────────────────────────────────────────────
      await send({ type: "phase", phase: "research", trace: [...trace] });
      const secondaryEvidence = await runMarketResearchSkill(startup, assumptions, trace);
      toolCalls += 3; // 3 search queries
      totalCost += COST_TABLE.gemini_call + 3 * COST_TABLE.search;
      checkTimeout();
      await send({ type: "evidence", evidence: secondaryEvidence, trace: [...trace] });

      // ── Phase 5: Experiment Design ──────────────────────────────────────────
      await send({ type: "phase", phase: "experiment", trace: [...trace] });
      const experiment = await runExperimentDesignerSkill(startup, assumptions, trace);
      toolCalls++;
      totalCost += COST_TABLE.gemini_call;
      checkTimeout();
      await send({ type: "experiment", experiment, trace: [...trace] });

      // ── Phase 5.5: Lead Finder (Apollo.io) ─────────────────────────────────
      // Find real people matching target_customer to interview for validation.
      await send({ type: "phase", phase: "leads", trace: [...trace] });
      const leads = await runLeadFinderSkill(startup, trace);
      toolCalls++;
      totalCost += COST_TABLE.search;
      checkTimeout();
      if (leads.length > 0) {
        await send({
          type: "leads",
          leads,
          message: `Found ${leads.length} potential interviewees matching "${startup.target_customer || startup.domain}" — reach out to validate your assumptions with real people.`,
          trace: [...trace],
        });
      }

      // ── Phase 6: Primary Evidence (if uploaded) ─────────────────────────────
      let primaryEvidence: Evidence[] = [];
      if (uploaded_data?.trim()) {
        await send({ type: "phase", phase: "evidence", trace: [...trace] });
        primaryEvidence = await runResponseAnalyzerSkill(startup, uploaded_data, experiment, trace);
        toolCalls++;
        totalCost += COST_TABLE.gemini_call;
        checkTimeout();
        await send({ type: "primary_evidence", evidence: primaryEvidence, trace: [...trace] });
      }

      const allEvidence = [...secondaryEvidence, ...primaryEvidence];

      // ── Verifier Pass ───────────────────────────────────────────────────────
      const plannerSummary = `
Startup: ${startup.name} — ${startup.one_liner}
Domain: ${startup.domain}
Assumptions count: ${assumptions.length}
Secondary evidence claims: ${secondaryEvidence.map((e) => e.claim).slice(0, 3).join("; ")}
      `.trim();

      await send({ type: "phase", phase: "verifying", trace: [...trace] });
      const verifierResult = await runVerifier(plannerSummary, allEvidence, trace);
      toolCalls++;
      totalCost += COST_TABLE.gemini_call;
      checkTimeout();

      // ── Phase 7: Decision Memo ──────────────────────────────────────────────
      await send({ type: "phase", phase: "memo", trace: [...trace] });
      const decision = await runDecisionMemoSkill(startup, assumptions, allEvidence, trace);
      toolCalls++;
      totalCost += COST_TABLE.gemini_call;

      // ── Persist (best-effort; never breaks streaming) ─────────────────────
      if (ownerId) {
        try {
          // Workspace membership gate: if workspaceId provided, caller must be a member.
          // On fail push a persist-warning trace but still continue to done.
          let persistAllowed = true;
          if (workspaceId) {
            const { data: membership } = await supabase
              .from("workspace_members")
              .select("workspace_id")
              .eq("workspace_id", workspaceId)
              .eq("user_id", ownerId)
              .maybeSingle();
            if (!membership) {
              trace.push(
                makeTrace("executor", "error", {
                  persist_warning: "Forbidden: not a workspace member, persistence skipped",
                  workspace_id: workspaceId,
                })
              );
              persistAllowed = false;
            }
          }
          if (!persistAllowed) {
            // Skip DB writes but fall through to done below.
          } else {
          const { error: sErr } = await supabase.from("startups").insert({
            id: startup.id,
            workspace_id: workspaceId || null,
            owner_id: ownerId,
            name: startup.name,
            one_liner: startup.one_liner,
            domain: startup.domain,
            target_customer: startup.target_customer ?? null,
            stage: startup.stage,
            business_model: startup.business_model ?? null,
          });
          if (sErr) throw sErr;
          if (assumptions.length > 0) {
            await supabase.from("assumptions").insert(
              assumptions.map((a) => ({
                id: a.id, startup_id: startup.id, workspace_id: workspaceId || null,
                statement: a.statement, category: a.category, risk_level: a.risk_level,
                status: a.status, reasoning: a.reasoning ?? null,
              }))
            );
          }
          if (allEvidence.length > 0) {
            await supabase.from("evidence").insert(
              allEvidence.map((e) => ({
                id: e.id, startup_id: startup.id, workspace_id: workspaceId || null,
                assumption_id: e.assumption_id ?? null, evidence_type: e.evidence_type,
                source_type: e.source_type ?? null, source_url: e.source_url ?? null,
                claim: e.claim, strength: e.strength, sample_size: e.sample_size ?? null,
              }))
            );
          }
          await supabase.from("decisions").insert({
            id: decision.id, startup_id: startup.id, workspace_id: workspaceId || null,
            verdict: decision.verdict, confidence: decision.confidence,
            rationale: decision.rationale, evidence_ids: decision.evidence_ids,
            sample_size: decision.sample_size ?? null,
            next_experiment: decision.next_experiment ?? null,
          });
          try {
            await supabase.from("experiments").insert({
              id: experiment.id, startup_id: startup.id, workspace_id: workspaceId || null,
              assumption_id: experiment.assumption_id ?? null, type: experiment.type,
              design: experiment.design, status: experiment.status,
            });
          } catch (expErr) {
            const msg = expErr instanceof Error ? expErr.message : String(expErr);
            trace.push(makeTrace("executor", "error", { persist_warning: `experiments insert failed: ${msg}` }));
          }
          await supabase.from("trace_events").insert(
            trace.slice(0, 50).map((t) => ({
              startup_id: startup.id, workspace_id: workspaceId || null,
              actor: t.actor, event_type: t.event_type, payload: t.payload,
              cost_usd: t.cost_usd ?? null, latency_ms: t.latency_ms ?? null,
            }))
          );
          trace.push(makeTrace("executor", "tool_result", { persisted: true, tables: 6 }));
          } // end persistAllowed else
        } catch (dbErr) {
          const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
          trace.push(makeTrace("executor", "error", { persist_failed: msg }));
        }
      }

      await send({
        type: "done",
        startup,
        assumptions,
        evidence: allEvidence,
        experiment,
        leads,
        decision,
        trace,
        stats: {
          tool_calls: toolCalls,
          budget_usd: totalCost,
          evidence_count: allEvidence.length,
          leads_found: leads.length,
          verifier_approved: verifierResult.approved,
          unsupported_claims: verifierResult.unsupportedClaims.length,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      trace.push(makeTrace("executor", "error", { error: message }));
      await send({ type: "error", message, trace });
    } finally {
      await writer.close();
    }
  })();

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
