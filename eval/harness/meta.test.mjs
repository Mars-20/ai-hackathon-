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
