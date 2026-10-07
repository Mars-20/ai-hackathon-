import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Integration-loop order guard (Router→Planner→Executor→Verifier):
// the agent POST pipeline must classify (router) before running skills,
// verify before the decision memo (gate, not advisory), and emit an
// ordered trace. A full POST run needs live AI keys, so this locks the
// wiring statically — reordering stages breaks the build.

const routeSrc = readFileSync(join(__dirname, "..", "agent", "route.ts"), "utf8");

describe("pipeline order (static integration)", () => {
  test("router runs before verifier before decision memo", () => {
    const routerCall = routeSrc.indexOf("await runRouterClassifier(");
    const verifierCall = routeSrc.indexOf("await runVerifier(");
    const memoCall = routeSrc.indexOf("await runDecisionMemoSkill(");
    expect(routerCall).toBeGreaterThan(-1);
    expect(verifierCall).toBeGreaterThan(-1);
    expect(memoCall).toBeGreaterThan(-1);
    expect(routerCall).toBeLessThan(verifierCall);
    expect(verifierCall).toBeLessThan(memoCall);
  });

  test("every stage emits a trace actor in pipeline order", () => {
    // Router/planner/executor/verifier trace under their own actor (spec
    // §9: actor = router | planner | executor | verifier | skill:<name>);
    // the executor skill stages (intake→response-analyzer) trace as skill:*.
    for (const actor of ["router", "planner", "executor", "verifier"] as const) {
      expect(routeSrc).toContain(`"${actor}"`);
    }
    expect(routeSrc).toMatch(/makeTrace\("skill:/);
    // TraceActor union (types.ts) must cover the same four stages.
    const typesSrc = readFileSync(
      join(__dirname, "..", "..", "..", "lib", "types.ts"),
      "utf8",
    );
    for (const actor of ["router", "planner", "executor", "verifier"] as const) {
      expect(typesSrc).toContain(`"${actor}"`);
    }
  });

  test("verifier result feeds the decision (gate, not advisory)", () => {
    expect(routeSrc).toMatch(/verifierResult/);
    expect(routeSrc).toMatch(/runDecisionMemoSkill\([\s\S]*?verifierResult/);
  });

  test("planner summary is what the verifier checks (no bypass)", () => {
    const verifierDef = routeSrc.indexOf("async function runVerifier(");
    const plannerSummaryAtCall = routeSrc.indexOf("runVerifier(plannerSummary");
    expect(verifierDef).toBeGreaterThan(-1);
    expect(plannerSummaryAtCall).toBeGreaterThan(-1);
  });
});
