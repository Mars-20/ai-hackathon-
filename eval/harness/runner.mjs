/**
 * Deterministic eval runner (Task 3 — no network).
 *
 * Reads tasks from eval/golden-tasks/tasks.json and recorded outputs from
 * eval/fixtures/gt-*.json, maps every expected field to assertions via
 * coverageFor() (throws on any uncovered field), executes the assertions
 * against done.verdict / done.evidence[].source_url / done.trace[].event_type
 * and writes eval/report.json as [{id, verdict_got, verdict_want,
 * citations_got, pass}]. ok is true only when all fixtures are covered and
 * every task passes.
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

export function evaluateTask(task, done) {
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

  const report = results.map(({ id, verdict_got, verdict_want, citations_got, pass }) => ({
    id,
    verdict_got,
    verdict_want,
    citations_got,
    pass,
  }));

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
