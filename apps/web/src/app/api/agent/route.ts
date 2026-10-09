// ─────────────────────────────────────────────────────────────────────────────
// Agent API Route — POST /api/agent
// Runtime: Router → Planner → Executor → Verifier (Section 5.1)
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest } from "next/server";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import type { Tool } from "@google/generative-ai";
import type {
  AgentInput,
  Assumption,
  Evidence,
  TraceEvent,
  Startup,
  Experiment,
  Decision,
  IcpProfile,
  InvestorScorecard,
} from "@/lib/types";
import {
  buildIcpSummary,
  buildMarketCtx,
  fallbackIcpProfile,
  marketBlock,
  normalizeVerdict,
  parseIcpProfile,
  parseInvestorScorecard,
  shouldRunInvestorReadiness,
  sliceTraceForPersist,
  isGroundedEvidence,
  splitEvidenceByGrounding,
  claimHasNumericContent,
  type MarketNumbers,
} from "@/lib/skills-helpers";
import {
  validateQuestion,
  meetsGoThreshold,
  deriveConfidence,
  applyVerifierGate,
  findUnsupportedFactualClaims,
  combineVerifierWithMemoScan,
  BUDGET,
  isBudgetExceeded,
  responseRate,
  sampleStats,
} from "@/lib/utils";
import {
  checkRateLimit,
  resolveRateLimitKey,
  getClientIp,
  RATE_MAX,
  RATE_WINDOW_MS,
} from "@/lib/rate-limit";
import {
  checkBudget,
  extractUsageCost,
  recordSpendAsync,
} from "@/lib/cost";
import type { CostKind } from "@/lib/cost";
import { searchLeads } from "@/lib/apollo";
import { searchSnovLeads } from "@/lib/snov";
import type { ApolloLead } from "@/lib/apollo";
import { resolveEffectiveWorkspaceId } from "@/lib/agent-workspace";
import { withTimeout, resolveTimeoutMs } from "@/lib/timeout";
import { getGeminiKeys, getGroqKeys, isQuotaError } from "@/lib/provider-keys";
import { matchClaimsToSources, searchExa } from "@/lib/exa-search";
import { resolveAgentGate } from "@/lib/entitlements";
import type { EntitlementStatus } from "@/lib/entitlements";
import { evaluateTrialStart } from "@/lib/trial-claims";
import type { ClaimsDb } from "@/lib/trial-claims";
import { composePrompt } from "@/lib/companion/prompt";
import type { PostSessionCapture } from "@/lib/companion/hook";
import { normalizeIntakeStage } from "@/lib/progress/tracks";

// ── Provider setup ────────────────────────────────────────────────────────────
// Best practice: single source of truth for model IDs (spec §6.3 + §21-B).
// Verify against provider docs on the day you deploy — names change fast.
// gemini-3.5-flash-lite = cheapest Gemini with JSON mode (grounding support
// varies — the helper below falls back to ungrounded automatically).
// openai/gpt-oss-120b = cheapest working Groq classifier on this account
// (proven 200 in our own Groq logs; all llama-* IDs 404 — retired/removed).
// Env overrides (GEMINI_PLANNER_MODEL / GEMINI_VERIFIER_MODEL /
// GROQ_ROUTER_MODEL) win without a code change.
// Quota resilience: GEMINI_API_KEYS (comma-separated) registers a key pool;
// the executor below rotates to the next key on 429/quota errors. A single
// GEMINI_API_KEY keeps working exactly as before (pool of one).
const PLANNER_MODEL = process.env.GEMINI_PLANNER_MODEL ?? "gemini-3.5-flash-lite";
const VERIFIER_MODEL = process.env.GEMINI_VERIFIER_MODEL ?? "gemini-3.5-flash-lite";
// Grounded search rides gemini-3.5-flash-lite: Google's recommended model for
// new projects, with Search grounding support (verified in the Gemini docs
// capability table). 2026-10-05: gemini-2.5-flash-lite 404s with "no longer
// available to new users" on fresh keys (prod grounded_error proof), so the
// 2.5 line is unusable here. Note: Search grounding needs the paid tier
// (5,000 free searches/mo shared across Gemini 3.x); on a free-tier key the
// grounded attempt fails and the helper falls back to ungrounded synthesis.
// Planner/verifier share the same cheap 3.5-flash-lite default.
const GROUNDING_MODEL = process.env.GEMINI_GROUNDING_MODEL ?? "gemini-3.5-flash-lite";
// Per-request upstream timeouts (RC1 fix): one hung provider call must fail
// fast into the Gemini→Groq→error failover chain instead of eating the 90s
// run budget. Gemini grounded search is agentic (can legitimately run ~30s),
// so it gets the roomier budget; Groq classifier/synthesis stays tight.
// Env-overridable without a code change (same convention as the models).
const GEMINI_CALL_TIMEOUT_MS = resolveTimeoutMs(process.env.GEMINI_CALL_TIMEOUT_MS, 45_000);
const GROQ_CALL_TIMEOUT_MS = resolveTimeoutMs(process.env.GROQ_CALL_TIMEOUT_MS, 30_000);
const GROQ_ROUTER_MODEL = process.env.GROQ_ROUTER_MODEL ?? "openai/gpt-oss-120b";

// ── Task 3: runtime metering + per-phase budget + prompt delimiters + router/backoff ──
// Provider usage is accumulated per phase into caller-owned arrays (never
// module state — Next.js serves concurrent POSTs sharing this module).
export interface AiUsage {
  totalTokenCount?: number;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
}

// Raw Groq (OpenAI-compatible) chat-completion payload shape — only the
// fields this route reads. Keeps `fetchGroqWithBackoff` free of `any`
// without changing any runtime behavior.
export interface GroqChatCompletion {
  choices?: Array<{ message?: { content?: string | null } | null } | null> | null;
  usage?: {
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  } | null;
}

// Per-field cap for untrusted content embedded in prompts: each
// user-controlled field is truncated individually so one huge field cannot
// crowd out the rest of the prompt.
const UNTRUSTED_FIELD_CHARS = 500;

function truncateField(s: string, max: number = UNTRUSTED_FIELD_CHARS): string {
  return s.length <= max ? s : s.slice(0, max - 3) + "...";
}

// Wrap user-controlled content so the model can tell instructions apart from
// untrusted data (prompt-injection hardening — never render raw user text as
// instructions).
function toUntrusted(s: string): string {
  return `<untrusted>${truncateField(s)}</untrusted>`;
}

// Re-injected model output (startup.name/one_liner/...) is untrusted too:
// re-sanitize on every re-injection so a stored injection cannot escalate
// downstream.
function sanitizeStartupField(s: string | undefined | null): string {
  return truncateField(sanitizeForPrompt(String(s ?? "")));
}

// Sum real provider metering when available; COST_TABLE fallback (inside
// extractUsageCost) ONLY when no call returned usageMetadata. Search-tool
// spend has no metering — its extractUsageCost(undefined, "search") fallback
// is legitimate and preserved.
function costFromUsage(acc: AiUsage[], fallbackKind: CostKind): number {
  const metered = acc.filter(
    (u) => typeof u?.totalTokenCount === "number" && (u.totalTokenCount ?? 0) > 0
  );
  if (metered.length > 0) {
    return metered.reduce(
      (sum, u) =>
        sum +
        extractUsageCost(
          {
            totalTokenCount: u.totalTokenCount,
            promptTokenCount: u.promptTokenCount,
            candidatesTokenCount: u.candidatesTokenCount,
          },
          fallbackKind
        ),
      0
    );
  }
  return extractUsageCost(undefined, fallbackKind); // FALLBACK: no provider metering
}

// Per-phase budget gate: throws 429 with retryAfter (not a bare Error) so the
// SSE catch below propagates { retryAfter } mid-loop instead of a bare message.
function assertPhaseBudget(totalCost: number, toolCalls: number): void {
  if (isBudgetExceeded(totalCost, toolCalls)) {
    throw Object.assign(new Error("Budget exceeded"), { status: 429, retryAfter: 60 });
  }
}

// Timeout/budget discriminator for fail-soft skills: only OUR two budget
// signals count — assertPhaseBudget throws Error("Budget exceeded") and the
// executor deadline throws "Budget: hard timeout 90s exceeded". Provider 429s
// (Groq/Gemini quota, which carry status 429 with retryAfter) are transient
// provider errors and must degrade via fail-soft, not abort the run.
function isBudgetError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return /Budget exceeded|Budget: hard timeout/.test(e.message);
}

// Groq fetch with exponential backoff (3 attempts) + multi-key rotation.
// Reads x-ratelimit-* headers for observability; on a final 429/5xx throws
// with `retryAfter` so callers propagate Retry-After instead of swallowing
// the signal. Each attempt cycles the key pool (GROQ_API_KEYS,
// comma-separated, else the legacy single GROQ_API_KEY): a 429/5xx/401 on one
// key retries with the NEXT key, so one exhausted or dead key never sinks the
// run while siblings have quota. Single-key setups behave exactly as before.
async function fetchGroqWithBackoff(
  body: Record<string, unknown>,
  trace: TraceEvent[],
  skillName: string
): Promise<{ data: GroqChatCompletion; usage?: AiUsage }> {
  const groqKeys = getGroqKeys();
  if (groqKeys.length === 0) throw new Error("Groq API key not configured");
  let lastErr: unknown = new Error(`Groq unavailable for ${skillName}`);
  for (let attempt = 0; attempt < 3; attempt++) {
    const groqKey = groqKeys[attempt % groqKeys.length];
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    }
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${groqKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: GROQ_ROUTER_MODEL, ...body }),
        // Per-attempt bound: a hung Groq socket must not wedge the run.
        signal: AbortSignal.timeout(GROQ_CALL_TIMEOUT_MS),
      });
      const rlRemaining = res.headers.get("x-ratelimit-remaining");
      const rlLimit = res.headers.get("x-ratelimit-limit");
      if (rlRemaining !== null || rlLimit !== null) {
        trace.push(
          makeTrace("router", "verification", {
            notice: "groq x-ratelimit headers",
            skill: skillName,
            remaining: rlRemaining,
            limit: rlLimit,
          })
        );
      }
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get("retry-after"));
        const retryAfter = Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : 60;
        lastErr = Object.assign(new Error(`Groq ${res.status} for ${skillName}`), {
          status: res.status,
          retryAfter,
        });
        continue;
      }
      // Quota guard: 429/5xx retry (with the next key in the pool);
      // 401 means THIS key is dead, so rotate past it too. Other permanent
      // 4xx (400/403/404 — bad request or dead model) fail fast with the
      // status attached; no key can fix those.
      if (res.status === 401) {
        lastErr = Object.assign(new Error(`Groq 401 (dead key) for ${skillName}`), {
          status: res.status,
        });
        continue;
      }
      if (!res.ok)
        throw Object.assign(new Error(`Groq ${res.status} for ${skillName}`), {
          status: res.status,
        });
      const data = await res.json();
      const u = data?.usage;
      const usage: AiUsage | undefined =
        typeof u?.total_tokens === "number"
          ? {
              totalTokenCount: u.total_tokens,
              promptTokenCount: u.prompt_tokens,
              candidatesTokenCount: u.completion_tokens,
            }
          : undefined;
      return { data, usage };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Dedicated Groq Router classifier (openai/gpt-oss-120b) — runs BEFORE the Planner
// (intake) so routing intent is decided by the fast classifier, not the
// planner. Fail-open with a trace warning: a blip here must not hard-block
// validation (the planner is primary); 429s still propagate retryAfter.
async function runRouterClassifier(
  idea: string,
  trace: TraceEvent[],
  usageAcc?: AiUsage[]
): Promise<{ intent: string }> {
  const t0 = Date.now();
  const fallback = { intent: "startup_validation" };
  trace.push(makeTrace("router", "skill_start", { skill: "router-classifier", model: GROQ_ROUTER_MODEL }));
  try {
    const { data, usage } = await fetchGroqWithBackoff(
      {
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: 'You are the Router classifier for a startup validation copilot. Reply ONLY with valid JSON: {"intent": string}.',
          },
          { role: "user", content: toUntrusted(idea) },
        ],
        temperature: 0.1,
        // Quota guard: a classifier needs ~dozens of tokens, not thousands.
        max_tokens: 300,
      },
      trace,
      "router-classifier"
    );
    if (usage?.totalTokenCount) usageAcc?.push(usage);
    const content = data?.choices?.[0]?.message?.content;
    const parsed = parseJsonSafely<{ intent?: string }>(String(content ?? ""), fallback);
    const intent = parsed.intent || fallback.intent;
    trace.push(makeTrace("router", "skill_end", { intent }, { latency_ms: Date.now() - t0 }));
    return { intent };
  } catch (err) {
    const retryAfter = (err as { retryAfter?: unknown })?.retryAfter;
    trace.push(
      makeTrace("router", "verification", {
        warning: "router-classifier fallback",
        error: String(err),
        ...(typeof retryAfter === "number" ? { retryAfter } : {}),
      })
    );
    if (typeof retryAfter === "number") throw err; // propagate Retry-After
    return fallback;
  }
}

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

// ── Gemini executor with multi-key rotation on quota errors ─────────────────
// Runs `run` against per-key clients in order. Quota/429 errors advance to
// the next key (each key carries its own quota); every other error throws
// immediately so 404s/400s/503s keep today's fail-fast-to-Groq behavior.
// Single-key setups behave exactly as before (one attempt, same error path).
// The politeness pause between keys is bounded (≤8s) so rotation cannot eat
// the 90s run budget; per-attempt withTimeout still bounds each call.
async function withGeminiKeyRotation<T>(
  run: (client: GoogleGenerativeAI) => Promise<T>,
  skillName: string
): Promise<T> {
  const keys = getGeminiKeys();
  let lastErr: unknown = new Error("No Gemini keys configured");
  for (let i = 0; i < keys.length; i++) {
    try {
      return await run(new GoogleGenerativeAI(keys[i]));
    } catch (err) {
      lastErr = err;
      if (!isQuotaError(err) || i === keys.length - 1) throw err;
      console.warn(
        `[Gemini key rotation for ${skillName}]: key ${i + 1}/${keys.length} hit quota, trying next`
      );
      await new Promise((r) => setTimeout(r, Math.min(2000 * (i + 1), 8000)));
    }
  }
  throw lastErr;
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
  usageAcc,
}: {
  prompt: string;
  systemPrompt?: string;
  geminiModel?: string;
  responseSchema?: unknown;
  trace: TraceEvent[];
  skillName: string;
  enableGrounding?: boolean;
  groundingStatus?: { grounded: boolean; error?: string };
  usageAcc?: AiUsage[];
}): Promise<string> {
  const geminiKeys = getGeminiKeys();
  const groqKey = process.env.GROQ_API_KEY?.trim();
  // Split system/user prompts: instructions travel as systemInstruction (or
  // the system role on Groq), never concatenated into the user content where
  // untrusted data could blur the boundary.
  const systemInstruction = systemPrompt?.trim() ? systemPrompt : undefined;
  const fullPrompt = prompt;
  const pushUsage = (r: unknown) => {
    const um = (r as { usageMetadata?: AiUsage } | null | undefined)?.usageMetadata;
    if (um && typeof um.totalTokenCount === "number" && um.totalTokenCount > 0) {
      usageAcc?.push({
        totalTokenCount: um.totalTokenCount,
        promptTokenCount: um.promptTokenCount,
        candidatesTokenCount: um.candidatesTokenCount,
      });
    }
  };

  // 1. Try Gemini primary
  if (geminiKeys.length > 0) {
    // Grounding attempt (spec §6.1 + §12): googleSearchRetrieval tool when
    // requested. This is the ONLY shape the installed SDK (@google/
    // generative-ai v0.24 `Tool` union) defines — the old google_search /
    // googleSearch keys were silently ignored, so grounding never fired.
    // No generationConfig here: search grounding is not combined with JSON
    // response mode; the prompt constrains JSON and parseJsonSafely
    // extracts it. Failure falls through to the non-grounded call below.
    if (enableGrounding) {
      try {
        const groundedResult = await withGeminiKeyRotation(
          (client) => {
            const groundedModel = client.getGenerativeModel({
              model: geminiModel,
              ...(systemInstruction ? { systemInstruction } : {}),
              tools: [{ googleSearchRetrieval: {} }],
            });
            return withTimeout(
              groundedModel.generateContent(fullPrompt),
              GEMINI_CALL_TIMEOUT_MS,
              `gemini:grounded:${skillName}`
            );
          },
          skillName
        );
        pushUsage(groundedResult.response);
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
    } catch (err) {
      // Record the exact API failure so the trace can report WHY grounding
      // did not fire; the plain call below remains the safe fallback.
      if (groundingStatus) {
        groundingStatus.error =
          err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
      }
    }
    }
    try {
      // Model construction AND the network call both live inside the
      // closure: construction is local (never throws quota), so rotation
      // must wrap generateContent where 429s actually surface.
      const result = await withGeminiKeyRotation(
        (client) => {
          const model = client.getGenerativeModel({
            model: geminiModel,
            ...(systemInstruction ? { systemInstruction } : {}),
            generationConfig: responseSchema
              ? {
                  responseMimeType: "application/json",
                  responseSchema: responseSchema as never,
                }
              : { responseMimeType: "application/json" },
          });
          return withTimeout(
            model.generateContent(fullPrompt),
            GEMINI_CALL_TIMEOUT_MS,
            `gemini:${skillName}`
          );
        },
        skillName
      );
      pushUsage(result.response);
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

  // 2. Try Groq fallback (exponential backoff x3, x-ratelimit observed,
  // Retry-After propagated via the shared helper).
  if (groqKey) {
    try {
      const { data, usage } = await fetchGroqWithBackoff(
        {
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `${systemInstruction || "You are an expert AI startup validation copilot."} You MUST reply ONLY with valid JSON.`,
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0.2,
        },
        trace,
        skillName
      );
      if (usage?.totalTokenCount) usageAcc?.push(usage);
      const content = data.choices?.[0]?.message?.content;
      if (content) return content;
    } catch (groqErr) {
      console.warn(`[Groq Failover Error for ${skillName}]:`, groqErr);
      const retryAfter = (groqErr as { retryAfter?: unknown })?.retryAfter;
      if (typeof retryAfter === "number") {
        throw Object.assign(
          new Error("AI providers temporarily unavailable. Please retry shortly."),
          { status: 429, retryAfter }
        );
      }
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
  trace?: TraceEvent[],
  usageAcc?: AiUsage[]
): Promise<{
  results: Array<{ claim: string; url: string; published_at?: string }>;
  grounded: boolean;
  provider: "exa" | "gemini" | "gemini-ungrounded" | "groq" | "none";
  grounded_error?: string;
}> {
  const geminiKeys = getGeminiKeys();
  const groqKey = process.env.GROQ_API_KEY?.trim();

  // Exa-first (DIY grounding): the free Search API returns tool-grounded
  // URLs + highlights, then our own LLM chain turns them into attributed
  // claims. The allowlist gate (matchClaimsToSources) is the
  // anti-hallucination proof — only URLs the Exa tool returned may carry
  // source_type web_search downstream. Fail-soft: empty search or zero
  // matched claims falls through to the Gemini → Groq chain below.
  const exaSources = await searchExa(query);
  if (exaSources.length > 0) {
    try {
      const sourceList = exaSources
        .slice(0, 8)
        .map(
          (s, i) =>
            `[${i + 1}] ${s.title} — ${s.url}${s.publishedDate ? ` (${s.publishedDate})` : ""}${
              s.highlights.length > 0 ? `\n${s.highlights.slice(0, 2).join("\n")}` : ""
            }`
        )
        .join("\n\n");
      const exaText = await callAIWithFallback({
        prompt: `Using ONLY the web search sources below about: "${query}"${domainHint ? ` in the context of ${domainHint}` : ""}.

SOURCES:
${sourceList}

Return a JSON object with key "results" containing an array of 3-6 objects, each with:
- "claim": a specific factual claim stated by the sources (1-2 sentences max)
- "url": the EXACT URL of the source it came from, copied verbatim from the list above
- "published_at": the source date in parentheses if shown, else null

Rules: every claim MUST come from the sources; every url MUST be copied exactly from the list — never invent, shorten, or guess a URL. If a source gives no usable fact, skip it. Respond ONLY with valid JSON.`,
        trace: trace ?? [],
        skillName: "market-research",
        usageAcc,
      });
      const parsedExa = parseJsonSafely<{
        results: Array<{ claim: string; url: string; published_at?: string }>;
      }>(exaText, { results: [] });
      const matched = matchClaimsToSources(parsedExa.results ?? [], exaSources);
      if (matched.length > 0) {
        const publishedByUrl = new Map(exaSources.map((s) => [s.url, s.publishedDate]));
        return {
          results: matched.map((m) => ({
            claim: m.claim,
            url: m.url,
            published_at: m.published_at ?? publishedByUrl.get(m.url) ?? undefined,
          })),
          grounded: true,
          provider: "exa",
        };
      }
    } catch {
      // Fall through to the Gemini → Groq chain below.
    }
  }

  // Try Gemini Google Search Grounding first via the shared helper with
  // grounding opted in (spec §6.1 google_search tool attempt). Wrapped in
  // try/catch with fallback to the direct tool variants below.
  if (geminiKeys.length > 0) {
    // groundingStatus defaults to ungrounded; only true groundingMetadata flips it.
    // groundingStatus.error carries the helper's grounded-attempt failure, if any.
    // Declared here so both the helper attempt and the direct variants below can report.
    const groundingStatus: { grounded: boolean; error?: string } = { grounded: false };
    try {
      // Helper attempt: only true groundingMetadata flips groundingStatus.
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
        geminiModel: GROUNDING_MODEL,
        groundingStatus,
        usageAcc,
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
        return {
          results: stripped,
          grounded: false,
          provider: "gemini-ungrounded",
          grounded_error: groundingStatus.error,
        };
      }
    } catch {
      // Fall through to the direct grounding tool variants below.
    }
    // Direct grounding attempt (fallback when the helper's grounded call
    // yields no validated URLs). SDK-typed googleSearchRetrieval shape —
    // the compiler enforces the Tool union, no casts.
    const groundingToolVariants: Array<Tool[]> = [[{ googleSearchRetrieval: {} }]];
    let directError: string | undefined;
    for (const tools of groundingToolVariants) {
      try {
        const prompt = `Search for factual, current information about: "${query}"${domainHint ? ` in the context of ${domainHint}` : ""}.

Return a JSON object with key "results" containing an array of objects, each with:
- "claim": a specific factual claim from the search results (1-2 sentences max)
- "url": the source URL
- "published_at": publication date if available (ISO string or null)

Only include claims you can attribute to a specific source. Return 3-6 results. Respond ONLY with valid JSON.`;

        const result = await withGeminiKeyRotation(
          (client) => {
            const model = client.getGenerativeModel({
              model: GROUNDING_MODEL,
              tools,
            });
            return withTimeout(
              model.generateContent(prompt),
              GEMINI_CALL_TIMEOUT_MS,
              "gemini:grounded-direct:market-research"
            );
          },
          "market-research"
        );
        {
          const um = (result.response as unknown as { usageMetadata?: AiUsage })?.usageMetadata;
          if (um && typeof um.totalTokenCount === "number" && um.totalTokenCount > 0) usageAcc?.push(um);
        }
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
          return {
            results: stripped,
            grounded: false,
            provider: "gemini-ungrounded",
            grounded_error: directError ?? groundingStatus.error,
          };
        }
        continue;
      } catch (err) {
        console.warn("[Grounded Search Gemini Failover]:", err);
        if (directError === undefined) {
          const msg = err instanceof Error ? err.message : String(err);
          directError = msg.slice(0, 300);
        }
        continue;
      }
    }
  }

  // Groq fallback: no browsing capability — synthesis only, NEVER emit URLs.
  // Any "url" the model returns here was not returned by a tool, so strip it.
  // Routed via the shared backoff helper (x-ratelimit observed, Retry-After
  // propagated); usage metered when the provider returns it.
  if (groqKey) {
    try {
      const { data, usage } = await fetchGroqWithBackoff(
        {
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
        },
        trace ?? [],
        "market-research-groq"
      );
      if (usage?.totalTokenCount) usageAcc?.push(usage);
      {
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
// Task 7: two-pass — extract structured fields, then ask <=3
// clarifying_questions for missing/ambiguous fields (never guess).
// Returns { startup, questions }; questions are capped at 3.
export interface IntakeResult {
  startup: Startup;
  questions: string[];
}

const MAX_INTAKE_QUESTIONS = 3;

async function runIntakeSkill(
  idea: string,
  trace: TraceEvent[],
  opts?: { workspace_id?: string; owner_id?: string },
  usageAcc?: AiUsage[],
  companionCtx: string = ""
): Promise<IntakeResult> {
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
        enum: ["idea", "prototype", "live", "scaling"],
      },
      business_model: { type: SchemaType.STRING },
      clarifying_questions: {
        type: SchemaType.ARRAY,
        items: { type: SchemaType.STRING },
      },
    },
    required: ["name", "one_liner", "domain", "stage"],
  };

  const prompt = `Extract structured information from this startup idea description.

IDEA: ${toUntrusted(idea)}

Extract:
- name: Short product/company name (infer if not given)
- one_liner: Clear, concise value proposition (max 15 words)
- domain: Industry/vertical (e.g. "edtech", "B2B SaaS", "food-tech", "health & wellness")
- target_customer: Who specifically benefits
- stage: Current stage — EXACTLY one of idea/prototype/live/scaling (the intake project always starts on the general track; never invent another value). Default to "idea" unless the text clearly shows a built prototype or a launched product
- business_model: How it makes money (subscription, marketplace, transaction fee, etc.)

Then list AT MOST 3 clarifying_questions: short questions about fields that
are missing or ambiguous in the idea. NEVER guess facts not present — ask
instead of inventing. If nothing is ambiguous, return an empty list.`;

  const rawText = await callAIWithFallback({
    prompt: composePrompt(prompt, companionCtx),
    systemPrompt: "You are the startup-intake skill for a Validation Copilot. Respond ONLY with valid JSON.",
    responseSchema: schema,
    trace,
    skillName: "startup-intake",
    usageAcc,
  });

  const latency = Date.now() - t0;
  const parsed = parseJsonSafely<Record<string, string | string[]>>(rawText, {});
  const startup: Startup = {
    id: crypto.randomUUID(),
    workspace_id: opts?.workspace_id ?? "",
    owner_id: opts?.owner_id ?? "",
    name: (parsed.name as string) || "Untitled Startup",
    one_liner: (parsed.one_liner as string) || idea.slice(0, 80),
    domain: (parsed.domain as string) || "general",
    target_customer: parsed.target_customer as string | undefined,
    // Intake projects start track-less (general template): anything the model
    // emits outside the general order falls back to "idea" so the result is
    // always savable under the save route's strict stage check.
    stage: normalizeIntakeStage(parsed.stage) as Startup["stage"],
    business_model: parsed.business_model as string | undefined,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Cap at MAX_INTAKE_QUESTIONS, drop blanks (mirrors intakeSchema max 3).
  const rawQuestions = Array.isArray(parsed.clarifying_questions) ? parsed.clarifying_questions : [];
  const questions = rawQuestions
    .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
    .map((q) => q.trim().slice(0, 300))
    .slice(0, MAX_INTAKE_QUESTIONS);

  trace.push(makeTrace("skill:startup-intake", "skill_end", { startup, questions }, { latency_ms: latency }));
  return { startup, questions };
}

// ── Assumption Mapping (skill: assumption-mapping) ────────────────────────────
async function runAssumptionMappingSkill(
  startup: Startup,
  trace: TraceEvent[],
  usageAcc?: AiUsage[],
  companionCtx: string = ""
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

  const prompt = `Map the critical assumptions for this startup.

STARTUP:
- Name: ${toUntrusted(sanitizeStartupField(startup.name))}
- Idea: ${toUntrusted(sanitizeStartupField(startup.one_liner))}
- Domain: ${toUntrusted(sanitizeStartupField(startup.domain))}
- Target customer: ${toUntrusted(sanitizeStartupField(startup.target_customer || "not specified"))}
- Business model: ${toUntrusted(sanitizeStartupField(startup.business_model || "not specified"))}

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

HYPOTHESIS FORMAT (startup-methodology): phrase every statement as
"We believe [customer segment] has [problem]. We will test this by
[specific method]. We will know we are right if [measurable signal]
within [timeframe]." Never let a vague problem statement pass: if the
problem, ICP, or workaround is unspecified, emit a critical desirability
assumption demanding Problem Formulation first.

Return assumptions sorted by risk_level: critical first, then high, medium, low.`;

  const rawText = await callAIWithFallback({
    prompt: composePrompt(prompt, companionCtx),
    systemPrompt: "You are the assumption-mapping skill for a Validation Copilot. Respond ONLY with valid JSON.",
    responseSchema: schema,
    trace,
    skillName: "assumption-mapping",
    usageAcc,
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

// ── ICP & Market Sizing (skill:icp-sizing — synthesis, no web tools) ────
// Always runs, right after mapping: its output grounds research + leads.
// Fail-soft on provider/model/parse errors (fallback profile + warning
// trace); timeout/budget errors propagate.
async function runIcpSizingSkill(
  startup: Startup,
  assumptions: Assumption[],
  trace: TraceEvent[],
  usageAcc?: AiUsage[],
  companionCtx: string = ""
): Promise<IcpProfile> {
  const t0 = Date.now();
  trace.push(makeTrace("skill:icp-sizing", "skill_start", { startup_id: startup.id }));

  const schema = {
    type: SchemaType.OBJECT,
    properties: {
      role_title: { type: SchemaType.STRING },
      context: { type: SchemaType.STRING },
      pain: { type: SchemaType.STRING },
      workaround: { type: SchemaType.STRING },
      buying_authority: { type: SchemaType.STRING },
      tam: { type: SchemaType.OBJECT, properties: { value: { type: SchemaType.STRING } } },
      sam: { type: SchemaType.OBJECT, properties: { value: { type: SchemaType.STRING } } },
      som: { type: SchemaType.OBJECT, properties: { value: { type: SchemaType.STRING } } },
    },
    required: ["role_title", "context", "pain", "workaround", "buying_authority", "tam", "sam", "som"],
  };

  const prompt = `Define the Ideal Customer Profile and preliminary market size for this startup.

STARTUP:
- Name: ${toUntrusted(sanitizeStartupField(startup.name))}
- Idea: ${toUntrusted(sanitizeStartupField(startup.one_liner))}
- Domain: ${toUntrusted(sanitizeStartupField(startup.domain))}
- Stated customer: ${toUntrusted(sanitizeStartupField(startup.target_customer || "not specified"))}
- Riskiest assumption: ${toUntrusted(truncateField(assumptions[0]?.statement ?? "", 300))}

RULES (icp-market-sizing):
- ICP is valid ONLY with all five dimensions: precise role/title (never "business owners"), company context (size/geo/stack), hair-on-fire pain, current workaround, buying authority.
- Specificity test: the description must single out ~5-10 people in a crowd of 1000, not "most of the room".
- TAM/SAM/SOM are PRELIMINARY estimates (research confirms them later): TAM = category demand at 100% share; SAM = reachable given channels/geography/language; SOM = SAM x realistic Y1 conversion from stated GTM capacity. Never present TAM as the relevant market.
- B2C: ICP and persona collapse into one (the individual consumer).

Return ONLY the profile as JSON (preliminary is set by code, not the model).`;

  let profile: IcpProfile;
  try {
    const rawText = await callAIWithFallback({
      prompt: composePrompt(prompt, companionCtx),
      systemPrompt: "You are the icp-sizing skill for a Validation Copilot. Respond ONLY with valid JSON.",
      responseSchema: schema,
      trace,
      skillName: "icp-sizing",
      usageAcc,
    });
    const parsed = parseIcpProfile(rawText);
    if (!parsed) throw new Error("icp-sizing returned unparseable JSON");
    profile = parsed;
  } catch (err) {
    if (isBudgetError(err)) throw err; // timeout/budget carve-out: abort, never limp on
    trace.push(makeTrace("skill:icp-sizing", "verification", {
      warning: "icp_fallback", detail: err instanceof Error ? err.message : String(err),
    }));
    profile = fallbackIcpProfile(startup.target_customer || "");
  }

  const latency = Date.now() - t0;
  trace.push(makeTrace("skill:icp-sizing", "skill_end", { preliminary: profile.preliminary }, { latency_ms: latency }));
  return profile;
}

// ── Market Research (skill: market-research + grounded_search tool) ───────────
async function runMarketResearchSkill(
  startup: Startup,
  assumptions: Assumption[],
  trace: TraceEvent[],
  usageAcc?: AiUsage[],
  icpSummary: string = ""
): Promise<Evidence[]> {
  const t0 = Date.now();
  trace.push(makeTrace("skill:market-research", "skill_start", { startup_id: startup.id }));

  const criticalAssumption = assumptions.find((a) => a.risk_level === "critical") ?? assumptions[0];
  const icpHint = icpSummary ? ` ${truncateField(icpSummary, 120)}` : "";
  const queries = [
    `${truncateField(sanitizeStartupField(startup.domain), 100)} market size and growth rate 2024 2025${icpHint} TAM SAM SOM`,
    `${truncateField(sanitizeStartupField(startup.one_liner), 100)} competitors pricing${icpHint}`,
    `${truncateField(criticalAssumption?.statement ?? "", 100)} evidence data`,
  ].filter(Boolean);

  const allResults: Evidence[] = [];

  for (const query of queries) {
    trace.push(makeTrace("tool", "tool_call", { tool: "grounded_search", query }));
    const t1 = Date.now();
    try {
      const searchResult = await groundedSearch(query, startup.domain, trace, usageAcc);
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
            grounded_error: searchResult.grounded_error,
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
            notice: "Web grounding unavailable (Exa + Gemini); synthesis has no browsing — URLs stripped, strength capped at opinion.",
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
            grounding_status: "grounded",
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
            grounding_status: "unverified",
            claim: r.claim,
            strength: "opinion",
            collected_at: new Date().toISOString(),
          });
          trace.push(
            makeTrace("skill:market-research", "verification", {
              warning: "ungrounded",
              query,
              claim: r.claim.slice(0, 120),
              numeric: claimHasNumericContent(r.claim),
            })
          );
        }
      }
    } catch (err) {
      trace.push(makeTrace("tool", "error", { query, error: String(err) }));
    }
  }

  // Synthesis: grounded TAM/SAM/SOM + competitor landscape (icp-market-sizing).
  // Numbers must cite tool-returned URLs; ungrounded numbers are dropped.
  let marketSizing: MarketNumbers | null = null;
  try {
    const synthSchema = {
      type: SchemaType.OBJECT,
      properties: {
        tam: { type: SchemaType.OBJECT, properties: { value: { type: SchemaType.STRING }, source_url: { type: SchemaType.STRING } } },
        sam: { type: SchemaType.OBJECT, properties: { value: { type: SchemaType.STRING }, source_note: { type: SchemaType.STRING } } },
        som: { type: SchemaType.OBJECT, properties: { value: { type: SchemaType.STRING }, basis: { type: SchemaType.STRING } } },
        competitors: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
      },
      required: ["tam", "sam", "som", "competitors"],
    };
    const synthPrompt = `Summarize the closeable market from these tool results (URLs are tool-grounded; invent none).
ICP: ${toUntrusted(icpSummary || "not specified")}
RESULTS:
${toUntrusted(allResults.slice(0, 12).map((r) => `- [${r.source_type}] ${r.claim}${r.source_url ? ` (${r.source_url})` : ""}`).join("\n"))}
Rules: anchor on SOM, never present TAM as the relevant market; drop any number without a cited URL.`;
    const synthText = await callAIWithFallback({
      prompt: composePrompt(synthPrompt, ""),
      systemPrompt: "You are the market-sizing synthesizer for a Validation Copilot. Respond ONLY with valid JSON.",
      responseSchema: synthSchema,
      trace,
      skillName: "market-sizing",
      usageAcc,
    });
    const parsed = parseJsonSafely<(MarketNumbers & { competitors?: string[] }) | null>(synthText, null);
    if (parsed && (parsed.tam?.value || parsed.sam?.value || parsed.som?.value)) {
      // Normalize with defaults: a partial object (missing tam/sam/som) must
      // degrade, never throw downstream in buildMarketCtx (fail-soft §3.2).
      marketSizing = {
        tam: parsed.tam ?? { value: "" },
        sam: parsed.sam ?? { value: "" },
        som: parsed.som ?? { value: "" },
      };
      trace.push(makeTrace("tool", "tool_result", { market_sizing: marketSizing, competitors: (parsed.competitors ?? []).slice(0, 8) }));
    } else {
      trace.push(makeTrace("skill:market-research", "verification", { warning: "synthesis_unparseable" }));
    }
  } catch (err) {
    if (isBudgetError(err)) throw err;
    trace.push(makeTrace("skill:market-research", "verification", { warning: "synthesis_failed" }));
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

// ── Lead Finder (skill: lead-finder, Apollo.io REST with Snov.io fallback) ───
// NOTE: .agents/mcp_config.json (apollo-io MCP) is IDE-only for the coding
// agent — the Next.js runtime uses direct REST via APOLLO_API_KEY
// (apps/web/.env.local + Vercel env). Returns full result so the caller can
// always emit an SSE leads event (even empty) instead of silent skip.
async function runLeadFinderSkill(
  startup: Startup,
  trace: TraceEvent[],
  icpSummary: string = ""
): Promise<{ leads: ApolloLead[]; error?: string; provider: string; total: number }> {
  const t0 = Date.now();
  trace.push(
    makeTrace("skill:lead-finder", "tool_call", {
      tool: "apollo_search",
      target_customer: startup.target_customer,
      domain: startup.domain,
    })
  );

  // ICP-shaped audience: the 5-dimension summary sharpens Apollo titles/geo;
  // empty falls back to today's target_customer behavior.
  const audience = icpSummary ? truncateField(icpSummary, 200) : (startup.target_customer || startup.domain);
  const result = await searchLeads({
    targetCustomer: audience,
    domain: startup.domain,
    keywords: startup.name,
    limit: 10,
  });

  // Snov.io fallback: Apollo Free plans are denied at 403 API_INACCESSIBLE.
  // Snov Database Search is free; only capped email reveals cost credits.
  if (result.error) {
    trace.push(
      makeTrace("skill:lead-finder", "error", {
        error: result.error,
        provider: result.provider,
        fallback: "snov",
      })
    );
    const snov = await searchSnovLeads({
      targetCustomer: audience,
      domain: startup.domain,
      limit: 10,
    });
    if (!snov.error && snov.leads.length > 0) {
      const latency = Date.now() - t0;
      trace.push(
        makeTrace(
          "skill:lead-finder",
          "tool_result",
          {
            leads_found: snov.leads.length,
            total_available: snov.total,
            provider: snov.provider,
            fallback_from: result.provider,
          },
          { latency_ms: latency }
        )
      );
      return { leads: snov.leads, provider: snov.provider, total: snov.total };
    }
    trace.push(
      makeTrace("skill:lead-finder", "error", {
        error: snov.error ?? "Snov fallback returned no leads",
        provider: snov.provider,
      })
    );
    return { leads: [], error: snov.error ?? result.error, provider: snov.provider, total: snov.total };
  }

  const latency = Date.now() - t0;

  if (result.error) {
    trace.push(
      makeTrace("skill:lead-finder", "error", {
        error: result.error,
        provider: result.provider,
      })
    );
    return { leads: [], error: result.error, provider: result.provider, total: result.total };
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

  return { leads: result.leads, provider: result.provider, total: result.total };
}

// ── Experiment Designer (skill: experiment-designer + survey-designer) ─────────
async function runExperimentDesignerSkill(
  startup: Startup,
  assumptions: Assumption[],
  trace: TraceEvent[],
  usageAcc?: AiUsage[],
  companionCtx: string = "",
  icpSummary: string = ""
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

  const prompt = `Design the CHEAPEST, FASTEST validation experiment for this critical assumption:

ASSUMPTION: ${toUntrusted(truncateField(riskiestAssumption?.statement ?? ""))}
STARTUP: ${toUntrusted(sanitizeStartupField(startup.name))} — ${toUntrusted(sanitizeStartupField(startup.one_liner))}
DOMAIN: ${toUntrusted(sanitizeStartupField(startup.domain))}
TARGET CUSTOMER: ${toUntrusted(sanitizeStartupField(startup.target_customer || "not specified"))}
ICP: ${toUntrusted(icpSummary || "not specified")}

EXPERIMENT LADDER (experiment-design-coach — cheapest first):
Tier 1 conversation ($0, hours) → Tier 2 signal test ($0-100, days) →
Tier 3 concierge/Wizard-of-Oz ($50-500, weeks) → Tier 4 prototype
($500+, weeks). NEVER recommend Tier 4+ before exhausting Tiers 1-3.
Match type to assumption: desirability/existence → interviews (n≥15);
usage → concierge/WoZ (n≥10); willingness-to-pay → pre-order/pricing
(n≥5); price level → Van Westendorp (n≥20); feasibility → spike/PoC.

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
    prompt: composePrompt(prompt, companionCtx),
    systemPrompt: "You are the experiment-designer and survey-designer skill for a Validation Copilot. Respond ONLY with valid JSON.",
    responseSchema: schema,
    trace,
    skillName: "experiment-designer",
    usageAcc,
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

  // Run leading-question validator on each question — hard-reject (Task 4):
  // !approved questions are filtered out, traced as leading_rejected,
  // never shown to founder.
  const validatedQuestions = (parsed.questions || []).flatMap((q) => {
    const validation = validateQuestion(q.text);
    if (!validation.approved) {
      trace.push(
        makeTrace("skill:survey-designer", "verification", {
          action: "leading_rejected",
          question: q.text,
          warnings: validation.warnings,
        })
      );
      return [];
    }
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
    return [
      {
        id: q.id || crypto.randomUUID(),
        text: q.text,
        type: qType,
        is_leading: validation.isLeading,
        warning: validation.warnings[0],
      },
    ];
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
  trace: TraceEvent[],
  usageAcc?: AiUsage[],
  companionCtx: string = ""
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

  const prompt = `Analyze this real primary evidence.

STARTUP: ${toUntrusted(sanitizeStartupField(startup.name))} — ${toUntrusted(sanitizeStartupField(startup.one_liner))}
EXPERIMENT TYPE: ${experiment.type}

RAW DATA / INTERVIEW NOTES:
${toUntrusted(uploadedData)}

TASK: Extract evidence items from this data.

COMMITMENT LADDER (assign strength appropriately):
1. opinion: "sounds useful", vague positive feedback
2. intent: "I would probably use this / buy this"
3. time_given: participant filled survey, agreed to call, responded to outreach
4. contact_shared: gave email/phone voluntarily for follow-up
5. commitment: pre-order, deposit, signed LOI, actual usage with payment

CRITICAL RULE: Distinguish compliments from commitments. "This is amazing!" = opinion. "Here's my credit card" = commitment.

EVIDENCE GRADING (evidence-quality-coach): classify every item on the
commitment ladder — Rung 1 opinion, 2 stated intent, 3 time given,
4 contact shared, 5 money/commitment. Bayesian weights: Rung 5 confirm
5.0x; Rung 3-4 confirm 2.0x / contradict 0.3x; Rung 1-2 = noise either
way. One Rung 5 contradiction wipes out ten Rung 1 compliments. Mom-Test
rules: their life not your idea; past specifics not hypotheticals;
compliments are not data (Rung 1); dig into bad news — hesitation is the
most valuable signal.

For each evidence item, count how many respondents it represents (sample_size).
Write a summary of what the data actually shows.`;

  const rawText = await callAIWithFallback({
    prompt: composePrompt(prompt, companionCtx),
    systemPrompt: "You are the response-analyzer skill for a Validation Copilot. Respond ONLY with valid JSON.",
    responseSchema: schema,
    trace,
    skillName: "response-analyzer",
    usageAcc,
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
  trace: TraceEvent[],
  verifier?: { approved: boolean; unsupportedClaims: string[] },
  usageAcc?: AiUsage[],
  companionCtx: string = "",
  marketCtx: string = ""
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

  const { grounded: groundedEvidence, ungrounded: withheldEvidence } = splitEvidenceByGrounding(allEvidence);

  const evidenceSummary = groundedEvidence
    .slice(0, 10)
    .map((e) => `[${e.evidence_type}/${e.strength}] ${toUntrusted(e.claim)}${e.source_url ? ` (${toUntrusted(e.source_url)})` : ""}`)
    .join("\n");

  const withheldLine =
    withheldEvidence.length > 0
      ? `WITHHELD: ${withheldEvidence.length} unverified item(s) excluded — never cite, restate, or rely on them; if the grounded evidence is thin, output "test_more".`
      : "";

  const prompt = `Produce an honest decision memo.

STARTUP: ${toUntrusted(sanitizeStartupField(startup.name))} — ${toUntrusted(sanitizeStartupField(startup.one_liner))}

GROUNDED EVIDENCE (${groundedEvidence.length} items: secondary URL-backed, primary by provenance):
${evidenceSummary}
${withheldLine ? `${withheldLine}\n` : ""}${marketBlock(marketCtx)}
THRESHOLD CHECK: ${allowGo ? "✓ Meets Go threshold" : `✗ Does NOT meet Go threshold: ${thresholdReason}`}
THIN-EVIDENCE RULE: a single source repeated, or several items sharing one URL once de-duplicated, is thin evidence and MUST NOT produce "go" — "go" needs 3+ DISTINCT sources. When in doubt, output "test_more".
CONFIDENCE LEVEL: ${confidence.toUpperCase()}
PRIMARY EVIDENCE COUNT: ${primaryEvidence.length}
${verifier && (!verifier.approved || verifier.unsupportedClaims.length > 0) ? `VERIFIER: ✗ ${verifier.unsupportedClaims.length} unsupported claim(s) — you MUST NOT output "go"; preserve "stop"/"iterate" if the evidence supports it, otherwise output "test_more", and address: ${verifier.unsupportedClaims.slice(0, 3).join(" | ")}` : `VERIFIER: ✓ no unsupported claims`}

${!allowGo ? `IMPORTANT: You MUST NOT output "go" as the verdict. The evidence is insufficient. Output "test_more" or "iterate" instead.` : ""}

Produce:
- verdict: Your evidence-based verdict (${allowGo ? "go/iterate/stop/test_more" : "iterate/stop/test_more only"})
- rationale: 2-3 sentence honest explanation referencing the actual evidence
- next_experiment: The single cheapest next experiment to run if verdict is not "go"
- investor_lens: 1-line note on the strongest of the 8 readiness signals
  (team 30 / market 25 / product 20 / business_model 10 / brand 5 /
  traction 5 / plan 3 / persuasion 2) this evidence supports

Be honest. If evidence is thin, say "test_more". Never inflate.`;

  const rawText = await callAIWithFallback({
    prompt: composePrompt(prompt, companionCtx),
    systemPrompt: "You are the decision-memo skill for a Validation Copilot. Respond ONLY with valid JSON.",
    responseSchema: schema,
    trace,
    skillName: "decision-memo",
    usageAcc,
  });

  const latency = Date.now() - t0;
  const parsed = parseJsonSafely<{ verdict?: Decision["verdict"]; rationale?: string; next_experiment?: string }>(
    rawText,
    { verdict: "test_more", rationale: "Further primary evidence collection needed", next_experiment: "Conduct 15 customer discovery interviews" }
  );

  // Final guard: if model tries to sneak in "go" without threshold met, override.
  // Canonicalize through normalizeVerdict: the fallback path ignores
  // responseSchema, so "GO"/"Go " must become "go" — never stored verbatim
  // (decisions.verdict CHECK + downstream verdict guards expect canonical).
  let verdict = normalizeVerdict(parsed.verdict) ?? "test_more";
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

  // Verifier gate (spec §4.4, Task 10): go + unsupported>0 → test_more +
  // warnings[] — the verifier blocks go, never merely advises, and never
  // downgrades stop/iterate/test_more (max-severity preserved).
  // Post-memo rescan: the verifier checked the planner summary before this
  // memo existed — re-scan the memo text itself with the same deterministic
  // net so model-introduced figures cannot slip past the gate.
  const memoText = `${parsed.rationale ?? ""}\n${parsed.next_experiment ?? ""}`;
  const baseVerifier = verifier ?? { approved: true, unsupportedClaims: [] };
  const combinedVerifier = combineVerifierWithMemoScan(baseVerifier, memoText, groundedEvidence);
  if (combinedVerifier.unsupportedClaims.length > baseVerifier.unsupportedClaims.length) {
    trace.push(
      makeTrace("verifier", "verification", {
        action: "memo_rescan",
        reason: "memo text introduced unsupported factual line(s)",
        added: combinedVerifier.unsupportedClaims.slice(baseVerifier.unsupportedClaims.length),
      })
    );
  }
  const gate = applyVerifierGate(verdict, combinedVerifier);
  if (gate.overridden) {
    trace.push(
      makeTrace("verifier", "verification", {
        action: "verdict_override",
        reason: `verifier: ${gate.warnings.length} unsupported claim(s)`,
        original: verdict,
        corrected: gate.verdict,
        unsupported_claims: gate.warnings,
      })
    );
  } else if (gate.warnings.length > 0) {
    // Verdict preserved (stop/iterate/test_more are never softened by the
    // gate) — still leave an audit trail of the flagged claims.
    trace.push(
      makeTrace("verifier", "verification", {
        action: "verdict_preserved",
        reason: `verifier: ${gate.warnings.length} unsupported claim(s), verdict ${verdict} preserved (max-severity)`,
        unsupported_claims: gate.warnings,
      })
    );
  }
  verdict = gate.verdict;
  const warningsSuffix =
    gate.warnings.length > 0
      ? ` [Verifier warnings (${gate.warnings.length} unsupported): ${gate.warnings.slice(0, 5).join(" | ")}]`
      : "";
  const rationale = (parsed.rationale || "Evidence evaluated against commitment ladder") + warningsSuffix;

  const decision: Decision = {
    id: crypto.randomUUID(),
    startup_id: startup.id,
    verdict,
    confidence,
    rationale,
    evidence_ids: allEvidence.map((e) => e.id),
    sample_size: primaryEvidence.reduce((acc, e) => acc + (e.sample_size ?? 1), 0),
    // Task 7: real response_rate — engaged (above-opinion) sample over total
    // primary sample via the deterministic responseRate() tool. No primary
    // evidence → undefined (never a fabricated number).
    response_rate: primaryEvidence.length > 0
      ? responseRate(
          primaryEvidence.reduce((acc, e) => acc + (e.sample_size ?? 1), 0),
          primaryEvidence
            .filter((e) => e.strength !== "opinion")
            .reduce((acc, e) => acc + (e.sample_size ?? 1), 0)
        ).rate
      : undefined,
    next_experiment: verdict !== "go" ? parsed.next_experiment : undefined,
    warnings: gate.warnings,
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

// ── Investor Readiness (skill:investor-readiness — gated: go/iterate only) ─
// Scores the memo against the 8 readiness signals. Returns null (with an
// explicit skip trace) unless the normalized verdict is go/iterate —
// scoring a stop/test_more memo for investors is incoherent. Throws on
// unparseable model JSON (the executor treats that as fail-soft);
// timeout/budget errors propagate.
async function runInvestorReadinessSkill(
  startup: Startup,
  decision: Decision,
  marketCtx: string,
  trace: TraceEvent[],
  usageAcc?: AiUsage[],
  companionCtx: string = ""
): Promise<InvestorScorecard | null> {
  if (!shouldRunInvestorReadiness(decision.verdict)) return null;
  const t0 = Date.now();
  trace.push(makeTrace("skill:investor-readiness", "skill_start", { startup_id: startup.id }));

  const schema = {
    type: SchemaType.OBJECT,
    properties: {
      signals: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            key: {
              type: SchemaType.STRING,
              format: "enum",
              enum: ["team", "market", "product", "business_model", "brand", "traction", "plan", "persuasion"],
            },
            score_1_10: { type: SchemaType.NUMBER },
            note: { type: SchemaType.STRING },
          },
          required: ["key", "score_1_10", "note"],
        },
      },
      overall_1_10: { type: SchemaType.NUMBER },
      verdict_fit: { type: SchemaType.STRING, format: "enum", enum: ["fundable", "not_yet", "unfit"] },
      top_gaps: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    },
    required: ["signals", "overall_1_10", "verdict_fit", "top_gaps"],
  };

  const prompt = `Score this startup's investor readiness against the 8 signals.

STARTUP: ${toUntrusted(sanitizeStartupField(startup.name))} — ${toUntrusted(sanitizeStartupField(startup.one_liner))}
MEMO VERDICT: ${toUntrusted(String(decision.verdict))} — ${toUntrusted(decision.rationale)}
${marketBlock(marketCtx)}

SIGNALS (weight in the overall judgment):
- team (30): founder-market fit, complementary skills, velocity
- market (25): size, growth, timing — frame on SOM, never TAM alone
- product (20): differentiation, defensibility, demo-ability
- business_model (10): clear path to revenue and margins
- brand (5): narrative, positioning, trust signals
- traction (5): LOIs, pilots, waitlist, revenue — commitment-ladder evidence only
- plan (3): credible next milestones and experiment discipline
- persuasion (2): memo clarity, honest numbers, no hype

RULES (investor-pitch-coach): score ONLY what the evidence supports —
absence of evidence is a low score, never an average one. top_gaps names
the 3 weakest signals with the single cheapest fix each.

Return ONLY the scorecard as JSON.`;

  const rawText = await callAIWithFallback({
    prompt: composePrompt(prompt, companionCtx),
    systemPrompt: "You are the investor-readiness skill for a Validation Copilot. Respond ONLY with valid JSON.",
    responseSchema: schema,
    trace,
    skillName: "investor-readiness",
    usageAcc,
  });
  const parsed = parseInvestorScorecard(rawText);
  if (!parsed) throw new Error("investor-readiness returned unparseable JSON");

  const latency = Date.now() - t0;
  trace.push(makeTrace("skill:investor-readiness", "skill_end", { overall_1_10: parsed.overall_1_10, verdict_fit: parsed.verdict_fit }, { latency_ms: latency }));
  return parsed;
}

// ── Verifier Pass ────────────────────────────────────────────────────────────
async function runVerifier(
  plannerOutput: string,
  evidence: Evidence[],
  trace: TraceEvent[],
  usageAcc?: AiUsage[]
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
    .map((e) => `- [${e.source_type ?? "internal"}] ${toUntrusted(e.claim)} (${toUntrusted(e.source_url ?? "no URL")})`)
    .join("\n");

  const prompt = `Check if the output claims are supported by the actual evidence retrieved.

ACTUAL EVIDENCE:
${evidenceList || "(none yet — only internal analysis)"}

OUTPUT TO CHECK:
${toUntrusted(plannerOutput)}

For each factual claim in the output:
1. Check if it is supported by the evidence list above
2. If a claim has no matching evidence, mark it as unsupported

IMPORTANT: Internal reasoning about assumptions and risk levels does NOT require external evidence.
Only flag market/competitor/data claims that need sources but have none.

Return: approved=true if 0 unsupported claims, false otherwise. List any unsupported claims.`;

  const rawText = await callAIWithFallback({
    // H2: companion block is NEVER evidence — the verifier judges output
    // against retrieved evidence only, so it always composes with "" ctx.
    prompt: composePrompt(prompt, ""),
    systemPrompt: "You are the Verifier for a Validation Copilot. Respond ONLY with valid JSON.",
    responseSchema: schema,
    geminiModel: VERIFIER_MODEL,
    trace,
    skillName: "verifier",
    usageAcc,
  });

  const latency = Date.now() - t0;
  const parsed = parseJsonSafely<{ approved?: boolean; unsupported_claims?: string[] }>(rawText, {
    approved: true,
    unsupported_claims: [],
  });
  // Deterministic safety net (no LLM bypass): per-claim URL support —
  // a factual line is grounded only by URL-bearing evidence about the SAME
  // claim (see claimHasUrlSupport). One stray source_url never blankets
  // unrelated claims.
  const deterministicUnsupported = findUnsupportedFactualClaims(plannerOutput, evidence);
  const unsupportedClaims: string[] = [...(parsed.unsupported_claims || [])];
  for (const line of deterministicUnsupported) {
    if (!unsupportedClaims.includes(line)) unsupportedClaims.push(line);
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
// Hardening: distributed sliding-window rate limit (Upstash Redis when
// configured, memory fallback dev/test only — see lib/rate-limit), input
// caps, prompt-injection strip, real cost accounting (lib/cost), 90s hard
// timeout (BUDGET).
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

// Per-call costs live in lib/cost via extractUsageCost (usageMetadata when
// available, COST_TABLE fallback marked inside lib/cost). SINGLE SOURCE: this
// route must never reference COST_TABLE directly — always extractUsageCost.

export async function POST(req: NextRequest) {
  // ── Single body read ───────────────────────────────────────────────
  // The Next prod runtime does not re-tee req.clone() reliably: the second
  // clone().json() throws "Body is unusable: Body has already been read".
  // Parse ONCE here; every consumer below (peek, companion, executor)
  // shares `rawBody` and never touches the request stream again.
  const rawBody = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  // ── Pre-flight: workspace peek (from the single parsed body) ────────
  // Peeked first so the rate-limit key can prefer user_id, else workspace_id,
  // else ip+route (never trust body.user_id for identity — only for bucketing).
  let peekWorkspaceId = "";
  let peekFp = { ua: "", screen: "", tz: "", lang: "" };
  try {
    const peeked = rawBody as { workspace_id?: unknown; fp?: unknown };
    if (typeof peeked.workspace_id === "string") peekWorkspaceId = peeked.workspace_id;
    // Optional device fingerprint for trial-abuse detection. Shape-validated
    // per field; missing/malformed → defaults (hashed, NEVER blocks).
    if (peeked.fp && typeof peeked.fp === "object" && !Array.isArray(peeked.fp)) {
      const rawFp = peeked.fp as Record<string, unknown>;
      peekFp = {
        ua: typeof rawFp.ua === "string" ? rawFp.ua : "",
        screen: typeof rawFp.screen === "string" ? rawFp.screen : "",
        tz: typeof rawFp.tz === "string" ? rawFp.tz : "",
        lang: typeof rawFp.lang === "string" ? rawFp.lang : "",
      };
    }
  } catch {
    peekWorkspaceId = "";
  }
  // ── Pre-flight: distributed rate limit (fail-closed) ───────────────────
  // Key = authenticated user when known, else workspace, else ip+route.
  let rateUserId = "";
  let rateUserEmail = "";
  let rateUserEmailConfirmedAt: string | null = null;
  try {
    const { createServerSupabaseClient } = await import("@/lib/supabase/server");
    const supabase = await createServerSupabaseClient();
    const { data } = await supabase.auth.getUser();
    rateUserId = data.user?.id ?? "";
    rateUserEmail = data.user?.email ?? "";
    rateUserEmailConfirmedAt = data.user?.email_confirmed_at ?? null;
  } catch {
    rateUserId = "";
    rateUserEmail = "";
    rateUserEmailConfirmedAt = null;
  }
  // getClientIp documents the trusted-proxy caveat (Task 9 infra follow-up);
  // the authenticated user key takes precedence wherever available.
  const rateIp = getClientIp(req.headers);
  const rateKey = resolveRateLimitKey({ userId: rateUserId, workspaceId: peekWorkspaceId, ip: rateIp, route: "/api/agent" });
  let rate: { limited: boolean; retryAfter: number };
  try {
    rate = await checkRateLimit({ key: rateKey, limit: RATE_MAX, windowMs: RATE_WINDOW_MS });
  } catch {
    rate = { limited: true, retryAfter: Math.ceil(RATE_WINDOW_MS / 1000) }; // fail-closed
  }
  if (rate.limited) {
    // Best-effort denial trace via service_role (bypasses RLS; never blocks
    // the 429). event_type "error" + payload.rate_limited: trace_events has a
    // CHECK allow-list with no dedicated rate_limited value, and Task 5 adds
    // no migration (Task 4 owns 0002).
    try {
      if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
        const { createServiceRoleClient } = await import("@/lib/supabase/server");
        const admin = createServiceRoleClient();
        await admin.from("trace_events").insert({
          startup_id: null,
          workspace_id: null,
          actor: "router",
          event_type: "error",
          payload: { rate_limited: true, key: rateKey, retry_after: rate.retryAfter, route: "/api/agent" },
          cost_usd: null,
          latency_ms: null,
        });
      }
    } catch {
      // best-effort only
    }
    return new Response(
      JSON.stringify({ error: "Rate limit exceeded. Try again shortly.", retryAfter: rate.retryAfter }),
      {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": String(rate.retryAfter) },
      }
    );
  }

  // ── Pre-flight: workspace spend budget (402) ──────────────────────────
  // peekWorkspaceId was read above (shared with the rate-limit key).
  // Budget pre-flight is MANDATORY for every caller, including anonymous:
  // unauthenticated requests are ledgered under the rate-limit key so anon
  // abuse still hits the spend cap. Fail-closed on store error (explicit 429)
  // — never silently bypass the budget.
  // Review #12: the body id is NOT trusted blindly — an invented id would
  // shard spend across bottomless buckets and evade the cap. Honor the
  // peeked id ONLY with a verified membership; otherwise ledger under the
  // authenticated user (anon keeps the workspace/ip bucket — trial/IP caps
  // own that path). Lookup failure also falls back to the user id: spend
  // stays capped, pooling merely degrades.
  let budgetKey = peekWorkspaceId || rateUserId || rateKey;
  if (rateUserId && peekWorkspaceId) {
    try {
      const { createServerSupabaseClient: createBudgetClient } = await import(
        "@/lib/supabase/server"
      );
      const { verifyWorkspaceMembership } = await import("@/lib/agent-workspace");
      const budgetClient = await createBudgetClient();
      const member = await verifyWorkspaceMembership(budgetClient, rateUserId, peekWorkspaceId);
      if (member) {
        budgetKey = peekWorkspaceId;
      } else {
        budgetKey = rateUserId;
        console.warn("[agent] unverified workspace_id in spend bucket, using user id");
      }
    } catch (e) {
      budgetKey = rateUserId;
      console.warn("[agent] workspace membership check failed, using user id", e);
    }
  }
  try {
    const b = await checkBudget(budgetKey);
    if (!b.allowed) {
      const retryAfter = b.retryAfter ?? 60;
      return new Response(
        JSON.stringify({ error: "Budget exceeded for this workspace.", retryAfter }),
        {
          status: 402,
          headers: { "Content-Type": "application/json", "Retry-After": String(retryAfter) },
        }
      );
    }
  } catch {
    // Fail-closed: ledger unreadable → reject, never bypass.
    return new Response(
      JSON.stringify({ error: "Budget check unavailable. Try again shortly.", retryAfter: 60 }),
      {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "60" },
      }
    );
  }

  // ── Pre-flight: trial/paywall entitlement gate (402) ───────────────────
  // Runs BEFORE the SSE stream: every denial returns JSON, never SSE.
  if (!rateUserId) {
    return new Response(
      JSON.stringify({ error: "Unauthorized", code: "UNAUTHENTICATED" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }
  // trial_claims + user_entitlements are service-role only (no RLS read
  // policies), so all gate reads go through the service-role client.
  const { createServiceRoleClient: createGateAdmin } = await import("@/lib/supabase/server");
  let gateAdmin: ReturnType<typeof createGateAdmin>;
  let entitlementStatus = "legacy";
  try {
    gateAdmin = createGateAdmin();
    const { data: entitlement, error: entitlementError } = await gateAdmin
      .from("user_entitlements")
      .select("status, plan")
      .eq("user_id", rateUserId)
      .maybeSingle();
    if (entitlementError) throw entitlementError;
    if (!entitlement) {
      // Pre-migration user — cannot happen post-0010, defensive only.
      console.warn("[agent] missing user_entitlements row, treating as legacy", { user_id: rateUserId });
      entitlementStatus = "legacy";
    } else {
      entitlementStatus = typeof entitlement.status === "string" ? entitlement.status : "legacy";
    }
  } catch {
    // Fail-closed: unreadable entitlement → reject, never bypass the paywall.
    return new Response(
      JSON.stringify({ error: "Entitlement check unavailable. Try again shortly.", retryAfter: 60 }),
      {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "60" },
      }
    );
  }
  const agentGate = resolveAgentGate(entitlementStatus as EntitlementStatus);
  if (!agentGate.allowed) {
    const gateMessages: Record<string, string> = {
      TRIAL_CONSUMED: "انتهت تجربتك المجانية — اشترك لمواصلة العمل",
      SUBSCRIPTION_REQUIRED: "هذا الإجراء يتطلب اشتراكًا",
      ACCOUNT_PAUSED: "حسابك موقوف مؤقتًا — راجع الإدارة",
    };
    return new Response(
      JSON.stringify({
        error: gateMessages[agentGate.code] ?? gateMessages.SUBSCRIPTION_REQUIRED,
        code: agentGate.code,
        plans_url: "/plans",
      }),
      { status: 402, headers: { "Content-Type": "application/json" } }
    );
  }
  if (entitlementStatus === "trial_active") {
    const claimsDb: ClaimsDb = {
      countRecentClaims: async (ipTrunc: string, sinceIso: string) => {
        const { count, error } = await gateAdmin
          .from("trial_claims")
          .select("user_id", { count: "exact", head: true })
          .eq("ip_trunc", ipTrunc)
          .gte("created_at", sinceIso);
        if (error) throw error;
        return count ?? 0;
      },
      findConsumedByFp: async (fpHash: string, excludeUserId: string) => {
        // fp already claimed a CONSUMED trial: same fingerprint on another
        // user's row whose entitlement is trial_consumed.
        const { data: rows, error } = await gateAdmin
          .from("trial_claims")
          .select("user_id")
          .eq("fp_hash", fpHash)
          .neq("user_id", excludeUserId)
          .limit(25);
        if (error) throw error;
        if (!rows || rows.length === 0) return false;
        const ids = rows.map((r) => r.user_id);
        const { data: consumed, error: consumedError } = await gateAdmin
          .from("user_entitlements")
          .select("user_id")
          .in("user_id", ids)
          .eq("status", "trial_consumed")
          .limit(1);
        if (consumedError) throw consumedError;
        return (consumed?.length ?? 0) > 0;
      },
      insertClaim: async (row) => {
        const { error } = await gateAdmin.from("trial_claims").insert({
          user_id: row.user_id,
          ip_trunc: row.ip_trunc,
          fp_hash: row.fp_hash,
          email_domain: row.email_domain,
          is_temp_mail: row.is_temp_mail,
          suspected_duplicate: row.suspected_duplicate,
        });
        if (error) throw error;
      },
    };
    let trialEval;
    try {
      trialEval = await evaluateTrialStart({
        userId: rateUserId,
        email: rateUserEmail,
        emailConfirmedAt: rateUserEmailConfirmedAt,
        ip: rateIp,
        fpSignals: peekFp,
        db: claimsDb,
      });
    } catch {
      // Fail-closed: unreadable abuse ledger → reject, never bypass.
      return new Response(
        JSON.stringify({ error: "Trial eligibility check unavailable. Try again shortly.", retryAfter: 60 }),
        {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "60" },
        }
      );
    }
    if (!trialEval.allowed) {
      return new Response(
        JSON.stringify({
          error: trialEval.reason ?? "Trial not allowed",
          code: trialEval.code,
          plans_url: "/plans",
        }),
        { status: 402, headers: { "Content-Type": "application/json" } }
      );
    }
    try {
      await claimsDb.insertClaim({
        user_id: rateUserId,
        ip_trunc: trialEval.claim.ip_trunc,
        fp_hash: trialEval.claim.fp_hash,
        email_domain: trialEval.claim.email_domain,
        is_temp_mail: trialEval.claim.is_temp_mail,
        suspected_duplicate: trialEval.claim.suspected_duplicate,
      });
    } catch (claimErr) {
      // Ledger failure must not block a legit trial — warn and continue.
      console.warn("[agent] trial_claims insert failed, continuing", claimErr);
    }
  }

  // ── Companion memory: fetch compiled ctx ONCE after auth+gate ──────────
  // Fail-soft: any failure injects nothing. The post-session capture is
  // snapshotted BY VALUE here; schedulePostSessionHook calls after()
  // synchronously in this POST scope — never from the background IIFE (C4).
  let companionCtx = "";
  // Done-gate token holder (spec §5.1): assigned at the schedule site below,
  // flipped ONLY where the SSE `done` event is emitted — error runs never
  // set it, so post-session inference skips them. Hoisted to POST scope
  // because the flip site lives inside the streaming IIFE.
  let sessionOutcome: { done: boolean } | null = null;
  try {
    const fullBody = rawBody as { idea?: unknown; startup_name?: unknown };
    const ideaText = typeof fullBody.idea === "string" ? fullBody.idea : "";
    if (rateUserId && ideaText.trim()) {
      // Lazy server modules: keeps the route's static graph free of
      // server-only so unit tests can import POST directly (rate-limit
      // precedent); matches the lazy supabase-server imports above.
      const { getCompiledContext } = await import("@/lib/companion/dal");
      const { schedulePostSessionHook } = await import("@/lib/companion/hook");
      try {
        companionCtx = await getCompiledContext(rateUserId, ideaText);
      } catch (ctxErr) {
        console.warn("[companion] context fetch failed, injecting nothing", ctxErr);
        companionCtx = "";
      }
      const capture: PostSessionCapture = {
        userId: rateUserId,
        userEmail: rateUserEmail,
        memoText: ideaText.slice(0, 8000),
        startupName:
          typeof fullBody.startup_name === "string" ? fullBody.startup_name.slice(0, 200) : "",
        budgetKey,
      };
      // Done-gate token (spec §5.1): shared by reference into the after()
      // callback. Flipped ONLY where the SSE `done` event is emitted below —
      // error runs never set it, so post-session inference skips them.
      sessionOutcome = schedulePostSessionHook(capture).outcome;
    }
  } catch {
    companionCtx = "";
  }

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
      const body: AgentInput = rawBody as unknown as AgentInput;
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

      // Companion injection meter (spec §11): one row per run that injects.
      if (companionCtx) {
        trace.push(makeTrace("companion", "companion_inject", { chars: companionCtx.length }));
      }

      // ── Phase 1: Routing (dedicated Groq classifier BEFORE the Planner) ──
      trace.push(makeTrace("router", "tool_call", { intent: "startup_validation", idea: idea.slice(0, 100) }));
      const routerUsage: AiUsage[] = [];
      const routerResult = await runRouterClassifier(idea, trace, routerUsage);
      trace.push(makeTrace("router", "tool_call", { intent: routerResult.intent }));
      toolCalls++;
      totalCost += costFromUsage(routerUsage, "groq_call");
      checkTimeout();
      assertPhaseBudget(totalCost, toolCalls);
      await send({ type: "phase", phase: "intake", trace: [...trace] });

      // ── Phase 2: Intake ─────────────────────────────────────────────────────
      // Real identity: authenticated user only; never trust body.user_id (never demo-user).
      const { createServerSupabaseClient } = await import("@/lib/supabase/server");
      const supabase = await createServerSupabaseClient();
      const { data: { user } } = await supabase.auth.getUser();
      const ownerId = user?.id || "";
      // Effective workspace: prod enforces workspace_id NOT NULL (migration
      // 0008), so a missing/unmembered workspace must resolve to the caller's
      // personal workspace (created on demand) — never NULL, which the DB
      // rejects and which silently drops the whole persistence below.
      const requestedWorkspaceId =
        typeof body.workspace_id === "string" ? body.workspace_id : "";
      const workspaceId = ownerId
        ? await resolveEffectiveWorkspaceId(supabase, ownerId, requestedWorkspaceId)
        : "";
      if (!ownerId) {
        trace.push(makeTrace("router", "verification", { warning: "unauthenticated session: persistence will be skipped" }));
      } else if (!workspaceId) {
        trace.push(
          makeTrace("router", "verification", {
            warning: requestedWorkspaceId
              ? "workspace not member: persistence will be skipped"
              : "workspace resolution failed: persistence will be skipped",
          })
        );
      }
      const intakeUsage: AiUsage[] = [];
      const { startup, questions } = await runIntakeSkill(idea, trace, { workspace_id: workspaceId ?? undefined, owner_id: ownerId }, intakeUsage, companionCtx);
      await send({ type: "startup", startup, questions, trace: [...trace] });

      // Per-phase budget + real metering (usageMetadata when available,
      // COST_TABLE fallback — marked in lib/cost).
      toolCalls++;
      totalCost += costFromUsage(intakeUsage, "gemini_call");
      checkTimeout();
      assertPhaseBudget(totalCost, toolCalls);

      // ── Phase 3: Assumption Mapping ─────────────────────────────────────────
      await send({ type: "phase", phase: "mapping", trace: [...trace] });
      const mappingUsage: AiUsage[] = [];
      const assumptions = await runAssumptionMappingSkill(startup, trace, mappingUsage, companionCtx);
      await send({ type: "assumptions", assumptions, trace: [...trace] });

      toolCalls++;
      totalCost += costFromUsage(mappingUsage, "gemini_call");
      checkTimeout();
      assertPhaseBudget(totalCost, toolCalls);

      // ── Phase 3b: ICP & Market Sizing (always runs) ────────────────────
      await send({ type: "phase", phase: "icp_sizing", trace: [...trace] });
      const icpUsage: AiUsage[] = [];
      const icpProfile = await runIcpSizingSkill(startup, assumptions, trace, icpUsage, companionCtx);
      toolCalls++;
      totalCost += costFromUsage(icpUsage, "gemini_call");
      checkTimeout();
      assertPhaseBudget(totalCost, toolCalls);
      const icpSummary = buildIcpSummary(icpProfile);
      startup.target_customer = truncateField(icpSummary, 500); // flattened, persisted later
      await send({ type: "icp_profile", icp_profile: icpProfile, trace: [...trace] });

      // ── Phase 4: Market Research ────────────────────────────────────────────
      await send({ type: "phase", phase: "research", trace: [...trace] });
      const researchUsage: AiUsage[] = [];
      const secondaryEvidence = await runMarketResearchSkill(startup, assumptions, trace, researchUsage, icpSummary);
      toolCalls += 4; // 3 search queries + 1 market-sizing synthesis
      totalCost += costFromUsage(researchUsage, "gemini_call") + 3 * extractUsageCost(undefined, "search");
      checkTimeout();
      assertPhaseBudget(totalCost, toolCalls);
      // Single-producer rule: marketCtx comes ONLY from the research
      // synthesis trace payload (grounded numbers); the icp_sizing TAM/SAM/SOM
      // stay preliminary and never feed prompts.
      const marketSizingPayload = [...trace].reverse().find(
        (t) => typeof t.payload?.market_sizing === "object" && t.payload?.market_sizing !== null
      )?.payload?.market_sizing as MarketNumbers | undefined;
      // buildMarketCtx is defensive (partial synthesis → ""), but a
      // corrupt trace payload must still never abort the run (fail-soft).
      let marketCtx = "";
      try {
        marketCtx = marketSizingPayload
          ? buildMarketCtx(marketSizingPayload, truncateField(icpSummary, 120))
          : "";
      } catch {
        trace.push(makeTrace("skill:market-research", "verification", { warning: "market_ctx_build_failed" }));
      }
      await send({ type: "evidence", evidence: secondaryEvidence, trace: [...trace] });

      // ── Phase 5: Experiment Design ──────────────────────────────────────────
      await send({ type: "phase", phase: "experiment", trace: [...trace] });
      const experimentUsage: AiUsage[] = [];
      const experiment = await runExperimentDesignerSkill(startup, assumptions, trace, experimentUsage, companionCtx, icpSummary);
      toolCalls++;
      totalCost += costFromUsage(experimentUsage, "gemini_call");
      checkTimeout();
      assertPhaseBudget(totalCost, toolCalls);
      await send({ type: "experiment", experiment, trace: [...trace] });

      // ── Phase 5.5: Lead Finder (Apollo.io REST) ────────────────────────────
      // Find real people matching target_customer to interview for validation.
      // Always emit a leads event (even empty) so the UI never silently skips
      // this phase — empty means "no matches / key misconfigured", visible in
      // trace + UI instead of a perceived freeze after experiment.
      await send({ type: "phase", phase: "leads", trace: [...trace] });
      const leadResult = await runLeadFinderSkill(startup, trace, icpSummary);
      const leads = leadResult.leads;
      toolCalls++;
      totalCost += extractUsageCost(undefined, "search");
      checkTimeout();
      assertPhaseBudget(totalCost, toolCalls);
      await send({
        type: "leads",
        leads,
        message: leads.length > 0
          ? `Found ${leads.length} potential interviewees matching "${startup.target_customer || startup.domain}" — reach out to validate your assumptions with real people.`
          : (leadResult.error ?? "No matching interviewees found for this target customer."),
        trace: [...trace],
      });

      // ── Phase 6: Primary Evidence (if uploaded) ─────────────────────────────
      let primaryEvidence: Evidence[] = [];
      if (uploaded_data?.trim()) {
        await send({ type: "phase", phase: "evidence", trace: [...trace] });
        const evidenceUsage: AiUsage[] = [];
        primaryEvidence = await runResponseAnalyzerSkill(startup, uploaded_data, experiment, trace, evidenceUsage, companionCtx);
        toolCalls++;
        totalCost += costFromUsage(evidenceUsage, "gemini_call");
        checkTimeout();
        assertPhaseBudget(totalCost, toolCalls);
        await send({ type: "primary_evidence", evidence: primaryEvidence, trace: [...trace] });
      }

      const allEvidence = [...secondaryEvidence, ...primaryEvidence];

      // ── Verifier Pass ───────────────────────────────────────────────────────
      const plannerSummary = `
Startup: ${sanitizeStartupField(startup.name)} — ${sanitizeStartupField(startup.one_liner)}
Domain: ${sanitizeStartupField(startup.domain)}
Assumptions count: ${assumptions.length}
Secondary evidence claims: ${secondaryEvidence.map((e) => truncateField(e.claim)).slice(0, 3).join("; ")}
      `.trim();

      // Planner stage trace (spec §9 actor vocabulary): the plan synthesis
      // hands plannerSummary to the verifier — recorded as the planner's
      // decision row so the trace carries all four pipeline actors.
      trace.push(
        makeTrace("planner", "decision", {
          phase: "plan_synthesis",
          assumptions: assumptions.length,
          evidence_items: allEvidence.length,
          summary_chars: plannerSummary.length,
        })
      );

      await send({ type: "phase", phase: "verifying", trace: [...trace] });
      const verifierUsage: AiUsage[] = [];
      const { grounded: groundedEvidence } = splitEvidenceByGrounding(allEvidence);
      const verifierResult = await runVerifier(plannerSummary, groundedEvidence, trace, verifierUsage);
      toolCalls++;
      totalCost += costFromUsage(verifierUsage, "gemini_call");
      checkTimeout();
      assertPhaseBudget(totalCost, toolCalls);

      // ── Phase 7: Decision Memo ──────────────────────────────────────────────
      await send({ type: "phase", phase: "memo", trace: [...trace] });
      const memoUsage: AiUsage[] = [];
      const decision = await runDecisionMemoSkill(startup, assumptions, allEvidence, trace, verifierResult, memoUsage, companionCtx, marketCtx);
      toolCalls++;
      totalCost += costFromUsage(memoUsage, "gemini_call");
      checkTimeout();
      assertPhaseBudget(totalCost, toolCalls);

      // ── Phase 7b: Investor Readiness (gated: go/iterate only) ───────────
      let investorScorecard: InvestorScorecard | null = null;
      if (shouldRunInvestorReadiness(decision.verdict)) {
        await send({ type: "phase", phase: "investor_readiness", trace: [...trace] });
        try {
          const invUsage: AiUsage[] = [];
          investorScorecard = await runInvestorReadinessSkill(startup, decision, marketCtx, trace, invUsage, companionCtx);
          toolCalls++;
          totalCost += costFromUsage(invUsage, "gemini_call");
          checkTimeout();
          assertPhaseBudget(totalCost, toolCalls);
        } catch (err) {
          if (isBudgetError(err)) throw err; // budget gate stays alive
          trace.push(makeTrace("executor", "tool_result", { investor_readiness: "failed_soft", detail: err instanceof Error ? err.message : String(err) }));
          investorScorecard = null;
        }
      } else {
        trace.push(makeTrace("executor", "tool_result", { investor_readiness: "skipped", reason: `verdict=${String(decision.verdict)}` }));
      }
      if (investorScorecard) {
        await send({ type: "investor_scorecard", investor_scorecard: investorScorecard, trace: [...trace] });
      }

      // ── Persist (best-effort; never breaks streaming) ─────────────────────
      // workspaceId is guaranteed non-empty here (resolved above); the empty
      // case skips explicitly so no NULL write ever reaches the DB.
      if (ownerId && workspaceId) {
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
            const gate = splitEvidenceByGrounding(allEvidence);
            trace.push(
              makeTrace("skill:market-research", "verification", {
                action: "persistence_gate",
                grounded: gate.grounded.length,
                unverified: gate.ungrounded.length,
              })
            );
            await supabase.from("evidence").insert(
              allEvidence.map((e) => ({
                id: e.id, startup_id: startup.id, workspace_id: workspaceId || null,
                assumption_id: e.assumption_id ?? null, evidence_type: e.evidence_type,
                source_type: e.source_type ?? null, source_url: e.source_url ?? null,
                grounding_status: isGroundedEvidence(e) ? "grounded" : "unverified",
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
          // ── Trial consumption (best-effort; run already delivered value) ──
          // Service-role client: RLS denies user-client writes here. Awaited.
          // 'already_consumed' → trace notice (generous edge, memo stands).
          // Error → persist_warning trace — NEVER fail the stream for this.
          if (ownerId) {
            try {
              const { createServiceRoleClient } = await import("@/lib/supabase/server");
              const consumeAdmin = createServiceRoleClient();
              const { data: consumeResult, error: consumeError } = await consumeAdmin.rpc(
                "consume_trial",
                { p_user_id: ownerId, p_startup_id: startup.id }
              );
              if (consumeError) throw consumeError;
              if (consumeResult === "already_consumed") {
                trace.push(makeTrace("executor", "tool_result", { trial: "already_consumed" }));
              }
            } catch (consumeErr) {
              const msg = consumeErr instanceof Error ? consumeErr.message : String(consumeErr);
              trace.push(makeTrace("executor", "error", { persist_warning: `consume_trial failed: ${msg}` }));
            }
          }
          try {
            const { createExperiment } = await import("@/lib/experiments");
            await createExperiment(supabase, ownerId, {
              id: experiment.id, startup_id: startup.id, workspace_id: workspaceId,
              assumption_id: experiment.assumption_id ?? null, type: experiment.type,
              design: experiment.design, status: experiment.status,
            });
          } catch (expErr) {
            const msg = expErr instanceof Error ? expErr.message : String(expErr);
            trace.push(makeTrace("executor", "error", { persist_warning: `experiments insert failed: ${msg}` }));
          }
          await supabase.from("trace_events").insert(
            sliceTraceForPersist(trace).map((t) => ({
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

      // Ledger this run's spend (best-effort atomic RPC; feeds pre-flight
      // checkBudget). budgetKey is always set (anon → rateKey fallback).
      try {
        await recordSpendAsync(budgetKey, totalCost);
      } catch {
        // best-effort only — ledger failure must not break the stream
      }

      // The run completed with a verdict: mark done BEFORE emitting, so the
      // after() hook (which runs strictly post-response) always sees it set.
      if (sessionOutcome) sessionOutcome.done = true;
      await send({
        type: "done",
        startup,
        assumptions,
        evidence: allEvidence,
        experiment,
        leads,
        decision,
        icp_profile: icpProfile ?? null,
        investor_scorecard: investorScorecard,
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
      const errRetryAfter =
        err instanceof Error ? (err as { retryAfter?: unknown }).retryAfter : undefined;
      // Server-side root-cause log: the SSE frame carries only the message,
      // which hides the originating fetch/skill (e.g. transient body-reuse
      // failures in provider fallback paths).
      console.error("[agent] executor failure", err instanceof Error ? (err.stack ?? err.message) : err);
      // Ledger partial spend even on failure — the run consumed providers.
      try {
        await recordSpendAsync(budgetKey, totalCost);
      } catch {
        // best-effort only
      }
      trace.push(makeTrace("executor", "error", { error: message }));
      await send({
        type: "error",
        message,
        ...(typeof errRetryAfter === "number" ? { retryAfter: errRetryAfter } : {}),
        trace,
      });
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
