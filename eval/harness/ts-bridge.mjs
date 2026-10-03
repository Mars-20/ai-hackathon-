/**
 * TypeScript bridge — the harness's ONLY import of apps/web/src/lib/utils.ts.
 *
 * Plain `node` cannot import `.ts` (Unknown file extension), so this module
 * is executed exclusively in a child process as:
 *   node --experimental-strip-types eval/harness/ts-bridge.mjs <op> <json>
 * (same sanctioned pattern as eval/admin-access-check.mjs). No network,
 * no threshold copies: every Gate-1/validator decision is computed by the
 * real utils.ts functions.
 *
 * Ops:
 *   validate   {questions: string[]}      -> [{isLeading, approved, ...}]
 *   go         {evidenceSets: Array[]}    -> [{eligible, reason}]
 *   confidence {evidenceSets: Array[]}    -> ["low"|"medium"|"high"]
 *   ping       {}                         -> {ok, goThreshold}
 */
import {
  meetsGoThreshold,
  validateQuestion,
  deriveConfidence,
  GO_THRESHOLD,
} from "../../apps/web/src/lib/utils.ts";

const op = process.argv[2];
const payload = JSON.parse(process.argv[3] ?? "{}");

let out;
if (op === "validate") {
  out = payload.questions.map((q) => {
    const r = validateQuestion(q);
    return {
      isLeading: r.isLeading,
      approved: r.approved,
      hasPastBehavior: r.hasPastBehavior,
      warnings: r.warnings,
    };
  });
} else if (op === "go") {
  out = payload.evidenceSets.map((set) => meetsGoThreshold(set));
} else if (op === "confidence") {
  out = payload.evidenceSets.map((set) => deriveConfidence(set));
} else if (op === "ping") {
  out = {
    ok:
      typeof meetsGoThreshold === "function" &&
      typeof validateQuestion === "function" &&
      typeof deriveConfidence === "function",
    goThreshold: { ...GO_THRESHOLD },
  };
} else {
  console.error(`unknown op: ${op}`);
  process.exit(2);
}

console.log(JSON.stringify(out));
