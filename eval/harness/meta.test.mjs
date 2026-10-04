/**
 * Meta-check for the deterministic eval harness (Task 3).
 *
 * Every `expected.*` field in eval/golden-tasks/tasks.json must map to at
 * least one real assertion via coverageFor(). Any expected field without an
 * assertion fails the harness. gt-006/007/008 must have real assertions
 * (not log-only).
 *
 * Run (plain node, no deps, no network):
 *   node --test eval/harness/meta.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coverageFor, getAssertion } from "./assertions.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tasks = JSON.parse(
  fs.readFileSync(path.join(ROOT, "eval/golden-tasks/tasks.json"), "utf8")
);
const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));

describe("meta: every expected field maps to an assertion", () => {
  it("all 8 golden tasks present", () => {
    assert.equal(tasks.length, 8);
    for (const id of ["gt-001", "gt-002", "gt-003", "gt-004", "gt-005", "gt-006", "gt-007", "gt-008"]) {
      assert.ok(byId[id], `missing golden task ${id}`);
    }
  });

  for (const task of tasks) {
    it(`${task.id}: every expected key covered`, () => {
      const names = coverageFor(task.expected, task);
      assert.ok(Array.isArray(names) && names.length > 0, `${task.id} produced no assertions`);
    });
  }

  it("assertLeadingQuestions fails when done lacks rejection evidence (gt-003 guard)", () => {
    const task = byId["gt-003"];
    const good = JSON.parse(
      fs.readFileSync(path.join(ROOT, "eval/fixtures/gt-003.json"), "utf8")
    );
    const fn = getAssertion("assertLeadingQuestions");
    assert.equal(fn(task, good).pass, true, "recorded gt-003 fixture must pass");
    const broken = { ...good, trace: [{ event_type: "question_validated" }] };
    assert.equal(
      fn(task, broken).pass,
      false,
      "done without leading_rejected evidence must FAIL (input-only check would pass)"
    );
    const acceptAll = { ...good, trace: [{ event_type: "question_validated" }, { event_type: "question_validated" }, { event_type: "question_validated" }] };
    assert.equal(fn(task, acceptAll).pass, false, "accept-all agent output must FAIL");
  });

  it("unknown expected field fails the harness (meta-check)", () => {
    assert.throws(() => coverageFor({ bogus_field_xyz: 1 }, {}), /uncovered/);
  });

  it("gt-006 has real assertions (verdict + citations + assumptions)", () => {
    const names = coverageFor(byId["gt-006"].expected, byId["gt-006"]);
    for (const n of ["assertVerdictIn", "assertEvidenceCitations", "assertMinAssumptions"]) {
      assert.ok(names.includes(n), `gt-006 missing ${n}`);
    }
  });

  it("gt-007 has real assertions (verdict + confidence + primary count + strengths)", () => {
    const names = coverageFor(byId["gt-007"].expected, byId["gt-007"]);
    for (const n of [
      "assertVerdictIn",
      "assertConfidenceIn",
      "assertPrimaryEvidenceCount",
      "assertEvidenceStrengthIncludes",
    ]) {
      assert.ok(names.includes(n), `gt-007 missing ${n}`);
    }
  });

  it("gt-008 has real assertions (feasibility + regulatory/ops)", () => {
    const names = coverageFor(byId["gt-008"].expected, byId["gt-008"]);
    for (const n of ["assertFeasibilityAssumptions", "assertRegulatoryOrOpsMention"]) {
      assert.ok(names.includes(n), `gt-008 missing ${n}`);
    }
  });

  it("planted_claim and injected_questions force verifier/validator assertions", () => {
    assert.ok(
      coverageFor(byId["gt-002"].expected, byId["gt-002"]).includes("assertVerifierFlagged"),
      "planted_claim must map to assertVerifierFlagged"
    );
    assert.ok(
      coverageFor(byId["gt-003"].expected, byId["gt-003"]).includes("assertLeadingQuestions"),
      "injected_questions must map to assertLeadingQuestions"
    );
  });
});

describe("meta: report rows carry real §13 metrics (Task 7)", () => {
  it("every row has citation/unsupported/planted/leading/latency/cost numbers", async () => {
    const { runEval } = await import("./runner.mjs");
    const { report, ok } = runEval({ writeReport: false });
    assert.equal(report.length, 8, "report covers all 8 golden tasks");
    for (const row of report) {
      assert.equal(typeof row.citation_coverage_pct, "number", `${row.id} citation_coverage_pct`);
      assert.ok(row.citation_coverage_pct >= 0 && row.citation_coverage_pct <= 100, `${row.id} coverage in range`);
      assert.equal(typeof row.unsupported_rate, "number", `${row.id} unsupported_rate`);
      assert.equal(typeof row.latency_ms, "number", `${row.id} latency_ms`);
      assert.equal(row.cost_usd, 0, `${row.id} deterministic harness spends 0`);
      assert.ok(
        row.planted_catch_rate === null || [0, 100].includes(row.planted_catch_rate),
        `${row.id} planted_catch_rate null or 0/100`
      );
      assert.ok(
        row.leading_catch_rate === null ||
          (row.leading_catch_rate >= 0 && row.leading_catch_rate <= 100),
        `${row.id} leading_catch_rate null or 0-100`
      );
    }
    assert.equal(ok, true, "eval suite passes end to end");
  });

  it("planted claim caught (gt-002) and leading questions caught (gt-003)", async () => {
    const { runEval } = await import("./runner.mjs");
    const { report } = runEval({ writeReport: false });
    const byId = Object.fromEntries(report.map((r) => [r.id, r]));
    assert.equal(byId["gt-002"].planted_catch_rate, 100, "gt-002 planted claim caught");
    assert.equal(byId["gt-003"].leading_catch_rate, 100, "gt-003 leading rejections evidenced");
    assert.equal(byId["gt-001"].planted_catch_rate, null, "gt-001 has no planted claim");
    assert.equal(byId["gt-001"].leading_catch_rate, null, "gt-001 has no injected questions");
  });
});

describe("meta: harness carries no threshold/validator literals", () => {
  it("no GO_THRESHOLD / MIN_* / LEADING_PATTERNS assignments in eval JS", () => {
    const dir = path.join(ROOT, "eval");
    const files = ["run-eval.js", "admin-access-check.mjs"];
    const harness = fs
      .readdirSync(path.join(dir, "harness"))
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => path.join("harness", f));
    const banned = /(?:const|let|var)\s+(?:GO_THRESHOLD|MIN_\w+|LEADING_PATTERNS)\s*=/;
    for (const rel of [...files, ...harness]) {
      const src = fs.readFileSync(path.join(dir, rel), "utf8");
      assert.ok(
        !banned.test(src),
        `${rel} must import thresholds from utils.ts, not define them`
      );
    }
  });
});
