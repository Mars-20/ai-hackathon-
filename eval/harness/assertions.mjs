/**
 * Eval harness assertions (Task 3 — deterministic, no network).
 *
 * Consumes meetsGoThreshold / validateQuestion / deriveConfidence via a REAL
 * import of apps/web/src/lib/utils.ts (see ts-bridge.mjs, executed in a
 * `node --experimental-strip-types` child — plain node cannot import `.ts`).
 * No threshold literals and no validator regexes are copied here; every
 * Gate-1/validator/confidence decision is computed by the imported functions.
 *
 * coverageFor(expected, task) maps every expected field to an assertion name:
 *   verdict_in -> assertVerdictIn, confidence_in -> assertConfidenceIn,
 *   primary_evidence_count_gte -> assertPrimaryEvidenceCount,
 *   planted_claim (task field) -> assertVerifierFlagged,
 *   injected_questions (task field) -> assertLeadingQuestions,
 *   must_not_be -> assertMustNotBe (+ assertThinEvidenceGate),
 *   evidence_must_have_citations -> assertEvidenceCitations,
 *   feasibility_assumptions_gte -> assertFeasibilityAssumptions.
 * Any expected field without a mapping throws (harness fails).
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), "ts-bridge.mjs");

function callBridge(op, payload) {
  const stdout = execFileSync(
    process.execPath,
    ["--experimental-strip-types", BRIDGE, op, JSON.stringify(payload)],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  return JSON.parse(stdout);
}

/** Imported validateQuestion, batched. */
export function bridgeValidate(questions) {
  return callBridge("validate", { questions });
}

/** Imported meetsGoThreshold, batched over evidence sets. */
export function bridgeGo(evidenceSets) {
  return callBridge("go", { evidenceSets });
}

/** Imported deriveConfidence, batched over evidence sets. */
export function bridgeConfidence(evidenceSets) {
  return callBridge("confidence", { evidenceSets });
}

/** Liveness probe for the real utils.ts import. */
export function bridgePing() {
  return callBridge("ping", {});
}

// ── helpers (no thresholds here) ────────────────────────────────────────────

const toGoInput = (evidence) =>
  (evidence ?? []).map((e) => ({
    strength: e.strength,
    sample_size: e.sample_size,
    source_type: e.source_type,
  }));

const traceTypes = (done) => (done?.trace ?? []).map((t) => t.event_type);

function ok(pass, detail) {
  return { pass: Boolean(pass), detail };
}

// ── assertions: each (task, done) -> {pass, detail} ─────────────────────────

function assertVerdictEquals(task, done) {
  const want = task.expected.verdict;
  return ok(done?.verdict === want, `verdict got=${done?.verdict} want=${want}`);
}

function assertVerdictIn(task, done) {
  const list = task.expected.verdict_in;
  return ok(
    list.includes(done?.verdict),
    `verdict got=${done?.verdict} want one of [${list.join(", ")}]`
  );
}

function assertMustNotBe(task, done) {
  const banned = task.expected.must_not_be;
  return ok(done?.verdict !== banned, `verdict got=${done?.verdict} must_not_be=${banned}`);
}

function assertThinEvidenceGate(task, done) {
  // Consistency with the imported Gate-1: thin evidence must never carry a Go.
  const [gate] = bridgeGo([toGoInput(done?.evidence)]);
  const pass =
    (!gate.eligible && done?.verdict !== "go") ||
    (gate.eligible && done?.verdict !== task.expected.must_not_be);
  return ok(pass, `gate eligible=${gate.eligible} verdict=${done?.verdict} (${gate.reason})`);
}

function assertConfidenceEquals(task, done) {
  const want = task.expected.confidence;
  const [derived] = bridgeConfidence([toGoInput(done?.evidence)]);
  return ok(
    done?.confidence === want && derived === want,
    `confidence got=${done?.confidence} derived=${derived} want=${want}`
  );
}

function assertConfidenceIn(task, done) {
  const list = task.expected.confidence_in;
  const [derived] = bridgeConfidence([toGoInput(done?.evidence)]);
  return ok(
    list.includes(done?.confidence) && list.includes(derived),
    `confidence got=${done?.confidence} derived=${derived} want one of [${list.join(", ")}]`
  );
}

function assertMinAssumptions(task, done) {
  const min = task.expected.min_assumptions;
  const n = (done?.assumptions ?? []).length;
  return ok(n >= min, `assumptions n=${n} min=${min}`);
}

function assertMustIncludeCategories(task, done) {
  const want = task.expected.must_include_categories;
  const have = new Set((done?.assumptions ?? []).map((a) => a.category));
  const missing = want.filter((c) => !have.has(c));
  return ok(missing.length === 0, `categories have=[${[...have].join(", ")}] missing=[${missing.join(", ")}]`);
}

function assertEvidenceCitations(task, done) {
  void task;
  const items = done?.evidence ?? [];
  const cited = items.filter(
    (e) => typeof e.source_url === "string" && e.source_url.length > 0
  ).length;
  return ok(items.length > 0 && cited === items.length, `cited ${cited}/${items.length} evidence items`);
}

function assertVerifierFlagged(task, done) {
  const gte = task.expected.unsupported_claims_gte ?? 1;
  const flags = done?.verifier_flags ?? [];
  const traced = traceTypes(done).includes("verifier_flagged");
  const pass = flags.length >= gte && traced;
  return ok(pass, `verifier flags=${flags.length} (need>=${gte}) trace_verifier_flagged=${traced}`);
}

function assertLeadingQuestions(task, done) {
  void done;
  const questions = task.injected_questions ?? [];
  const results = bridgeValidate(questions);
  const rejected = results.filter((r) => !r.approved).length;
  const approved = results.filter((r) => r.approved).length;
  const pass =
    rejected === task.expected.leading_question_rejection_count &&
    approved === task.expected.approved_question_count;
  return ok(pass, `leading rejected=${rejected} approved=${approved}`);
}

function assertPrimaryEvidenceCount(task, done) {
  const min = task.expected.primary_evidence_count_gte;
  const n = (done?.evidence ?? []).filter((e) => e.evidence_type === "primary").length;
  return ok(n >= min, `primary evidence n=${n} min=${min}`);
}

function assertEvidenceStrengthIncludes(task, done) {
  const want = task.expected.evidence_strength_includes;
  const have = new Set((done?.evidence ?? []).map((e) => e.strength));
  const missing = want.filter((s) => !have.has(s));
  return ok(missing.length === 0, `strengths have=[${[...have].join(", ")}] missing=[${missing.join(", ")}]`);
}

function assertFeasibilityAssumptions(task, done) {
  const min = task.expected.feasibility_assumptions_gte;
  const n = (done?.assumptions ?? []).filter((a) => a.category === "feasibility").length;
  return ok(n >= min, `feasibility assumptions n=${n} min=${min}`);
}

function assertRegulatoryOrOpsMention(task, done) {
  void task;
  const re = /regulat|licen|permit|compliance|operations|\bops\b|route|fleet|logistics/i;
  const texts = [
    ...((done?.assumptions ?? []).map((a) => a.text ?? "")),
    ...((done?.evidence ?? []).map((e) => e.note ?? "")),
  ];
  return ok(texts.some((t) => re.test(t)), "regulatory/ops mention present");
}

function assertGracefulHandling(task, done) {
  void task;
  const verdictOk = typeof done?.verdict === "string" && done.verdict.length > 0;
  const fallback = traceTypes(done).some((t) => /fallback|graceful|router|off_domain/i.test(t));
  return ok(verdictOk && fallback, `verdict=${done?.verdict} fallback_traced=${fallback}`);
}

function assertNoCrash(task, done) {
  void task;
  const crashed = traceTypes(done).some((t) => t === "crash" || t === "error_fatal");
  return ok(!crashed, `crashed=${crashed}`);
}

function assertReasonPresent(task, done) {
  void task;
  return ok(
    typeof done?.reason === "string" && done.reason.length > 0,
    `reason present=${typeof done?.reason === "string" && done?.reason.length > 0}`
  );
}

export const ASSERTIONS = {
  assertVerdictEquals,
  assertVerdictIn,
  assertMustNotBe,
  assertThinEvidenceGate,
  assertConfidenceEquals,
  assertConfidenceIn,
  assertMinAssumptions,
  assertMustIncludeCategories,
  assertEvidenceCitations,
  assertVerifierFlagged,
  assertLeadingQuestions,
  assertPrimaryEvidenceCount,
  assertEvidenceStrengthIncludes,
  assertFeasibilityAssumptions,
  assertRegulatoryOrOpsMention,
  assertGracefulHandling,
  assertNoCrash,
  assertReasonPresent,
};

const KEY_TO_ASSERTIONS = {
  verdict: ["assertVerdictEquals"],
  verdict_in: ["assertVerdictIn"],
  must_not_be: ["assertMustNotBe", "assertThinEvidenceGate"],
  confidence: ["assertConfidenceEquals"],
  confidence_in: ["assertConfidenceIn"],
  min_assumptions: ["assertMinAssumptions"],
  must_include_categories: ["assertMustIncludeCategories"],
  evidence_must_have_citations: ["assertEvidenceCitations"],
  verifier_must_flag: ["assertVerifierFlagged"],
  unsupported_claims_gte: ["assertVerifierFlagged"],
  leading_question_rejection_count: ["assertLeadingQuestions"],
  approved_question_count: ["assertLeadingQuestions"],
  reason: ["assertReasonPresent"],
  should_handle_gracefully: ["assertGracefulHandling"],
  should_not_crash: ["assertNoCrash"],
  primary_evidence_count_gte: ["assertPrimaryEvidenceCount"],
  evidence_strength_includes: ["assertEvidenceStrengthIncludes"],
  feasibility_assumptions_gte: ["assertFeasibilityAssumptions"],
  must_mention_regulatory_or_ops: ["assertRegulatoryOrOpsMention"],
};

/**
 * Map an expected object to assertion names. Throws on any expected field
 * without an assertion (meta-check: harness fails). Task-level planted_claim
 * maps to assertVerifierFlagged; injected_questions maps to assertLeadingQuestions.
 */
export function coverageFor(expected, task = {}) {
  const names = [];
  for (const key of Object.keys(expected ?? {})) {
    const mapped = KEY_TO_ASSERTIONS[key];
    if (!mapped) throw new Error(`uncovered expected field: ${key}`);
    for (const n of mapped) if (!names.includes(n)) names.push(n);
  }
  if (task?.planted_claim && !names.includes("assertVerifierFlagged")) {
    names.push("assertVerifierFlagged");
  }
  if (task?.injected_questions && !names.includes("assertLeadingQuestions")) {
    names.push("assertLeadingQuestions");
  }
  return names;
}

export function getAssertion(name) {
  const fn = ASSERTIONS[name];
  if (!fn) throw new Error(`unknown assertion: ${name}`);
  return fn;
}
