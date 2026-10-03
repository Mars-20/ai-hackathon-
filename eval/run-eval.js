/**
 * Evaluation entry point (Task 3).
 *
 * Delegates to eval/harness/runner.mjs. Writes eval/report.json as
 * [{id, verdict_got, verdict_want, citations_got, pass}] and exits 0 only
 * when all 8 golden tasks are covered and every task passes; exits 1 on any
 * failure or uncovered expected field.
 *
 * Run (plain node, no deps, no network):
 *   node eval/run-eval.js
 */
(async () => {
  try {
    const { runEval } = await import("./harness/runner.mjs");
    const { ok, allCovered, allPass } = runEval({ writeReport: true });
    if (!ok) {
      console.error(`EVAL FAIL: covered=${allCovered} allPass=${allPass}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`EVAL FAIL: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
})();
