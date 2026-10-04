/**
 * Deterministic eval runner (Task 3 — no network).
 *
 * Reads tasks from eval/golden-tasks/tasks.json and recorded outputs from
 * eval/fixtures/gt-*.json, maps every expected field to assertions via
 * coverageFor() (throws on any uncovered field), executes the assertions
 * against done.verdict / done.evidence[].source_url / done.trace[].event_type
 * and writes eval/report.json rows as [{id, verdict_got, verdict_want,
 * citations_got, pass, citation_coverage_pct, unsupported_rate,
 * planted_catch_rate, leading_catch_rate, latency_ms, cost_usd}].
 * Every metric is computed from the task + recorded fixture (no invented
 * numbers): N/A rows carry null, the deterministic harness spends 0 USD.
 * ok is true only when all fixtures are covered and every task passes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coverageFor, getAssertion, bridgeGo, bridgeDistinct } from "./assertions.mjs";
import { loadFixture, FIXTURE_IDS } from "./fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASKS_PATH = path.resolve(HERE, "../golden-tasks/tasks.json");
const REPORT_PATH = path.resolve(HERE, "../report.json");

export function verdictWant(expected) {
  if (typeof expected?.verdict === "string") return expected.verdict;
  if (Array.isArray(expected?.verdict_in)) return expected.verdict_in.join("/");
  if (typeof expected?.must_not_be === "string") return `not:${expected.must_not_be}`;
  return "any";
}

export function citationsCount(done) {
  // Canonical de-duplicated count (same URL/case/fragment/trailing-slash
  // variants collapse to one source) via the imported utils.ts — never a
  // local recount, so the harness cannot drift from the Gate-1 definition.
  const [n] = bridgeDistinct([done?.evidence ?? []]);
  return n;
}

const pct1 = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

export function citationCoveragePct(done) {
  const items = done?.evidence ?? [];
  const cited = items.filter(
    (e) => typeof e.source_url === "string" && e.source_url.length > 0
  ).length;
  return pct1(cited, items.length);
}

export function unsupportedRate(done) {
  const items = done?.evidence ?? [];
  const flags = done?.verifier_flags ?? [];
  return pct1(flags.length, items.length);
}

export function plantedCatchRate(task, done) {
  if (!task?.planted_claim) return null;
  return (done?.verifier_flags ?? []).length > 0 ? 100 : 0;
}

export function leadingCatchRate(task, done) {
  if (!task?.injected_questions) return null;
  const want = task.expected?.leading_question_rejection_count ?? 0;
  if (want <= 0) return null;
  const types = (done?.trace ?? []).map((t) => t.event_type);
  let rejected = types.filter((t) =>
    /leading_rejected|question_rejected|leading_flagged/i.test(t)
  ).length;
  if (Array.isArray(done?.question_validations)) {
    rejected = done.question_validations.filter((q) => q.approved === false).length;
  } else if (done?.leading_validation && typeof done.leading_validation === "object") {
    rejected =
      done.leading_validation.rejected ??
      done.leading_validation.leading_question_rejection_count ??
      rejected;
  }
  return Math.min(100, pct1(rejected, want));
}

export function evaluateTask(task, done) {
  const t0 = Date.now();
  const names = coverageFor(task.expected, task);
  const checks = names.map((name) => {
    const fn = getAssertion(name);
    const r = fn(task, done);
    return { name, pass: r.pass, detail: r.detail };
  });
  const pass = checks.every((c) => c.pass);
  return {
    id: task.id,
    verdict_got: done?.verdict ?? "missing",
    verdict_want: verdictWant(task.expected),
    citations_got: citationsCount(done),
    pass,
    checks,
    // Task 7 §13 metrics — real numbers only (computed, never invented).
    citation_coverage_pct: citationCoveragePct(done),
    unsupported_rate: unsupportedRate(done),
    planted_catch_rate: plantedCatchRate(task, done),
    leading_catch_rate: leadingCatchRate(task, done),
    latency_ms: Date.now() - t0,
    cost_usd: 0,
  };
}

export function runEval({ writeReport = true } = {}) {
  // Live-import smoke check (behavioral, no literals): thin opinion evidence
  // must be ineligible under the imported Gate-1, otherwise utils.ts drifted.
  const [smoke] = bridgeGo([[{ strength: "opinion", sample_size: 1 }]]);
  if (smoke?.eligible !== false) {
    throw new Error("threshold import drift: thin opinion evidence reported eligible");
  }

  const tasks = JSON.parse(fs.readFileSync(TASKS_PATH, "utf8"));
  const results = tasks.map((task) => evaluateTask(task, loadFixture(task.id)));

  const seen = new Set(results.map((r) => r.id));
  const allCovered =
    results.length === FIXTURE_IDS.length && FIXTURE_IDS.every((id) => seen.has(id));
  const allPass = results.every((r) => r.pass);

  const report = results.map(
    ({
      id,
      verdict_got,
      verdict_want,
      citations_got,
      pass,
      citation_coverage_pct,
      unsupported_rate,
      planted_catch_rate,
      leading_catch_rate,
      latency_ms,
      cost_usd,
    }) => ({
      id,
      verdict_got,
      verdict_want,
      citations_got,
      pass,
      citation_coverage_pct,
      unsupported_rate,
      planted_catch_rate,
      leading_catch_rate,
      latency_ms,
      cost_usd,
    })
  );

  if (writeReport) {
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  const passed = results.filter((r) => r.pass).length;
  console.log("=".repeat(70));
  console.log("Eval harness — deterministic golden-task suite (no network)");
  console.log("=".repeat(70));
  for (const r of results) {
    const mark = r.pass ? "PASS" : "FAIL";
    console.log(`  ${mark}  ${r.id} verdict_got=${r.verdict_got} want=${r.verdict_want} citations=${r.citations_got}`);
    for (const c of r.checks) {
      if (!c.pass) console.log(`        FAIL check ${c.name}: ${c.detail}`);
    }
  }
  console.log("=".repeat(70));
  console.log(`SUMMARY: ${passed} PASSED / ${results.length - passed} FAILED, covered=${allCovered}`);
  console.log(`report: ${REPORT_PATH}`);
  console.log("=".repeat(70));

  return { results, report, allCovered, allPass, ok: allCovered && allPass };
}
