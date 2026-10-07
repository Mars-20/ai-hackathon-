/**
 * Assistant golden-thread harness (Task 8 — deterministic, no network).
 *
 * Reads eval/assistant/threads/at-*.json. Each turn carries `expect`
 * (contract assertions) + `recorded` (the recorded assistant output to
 * check). Mirrors the eval/harness idiom: every expect field maps to a
 * named check, unknown fields throw (no silent coverage gaps).
 *
 * Re-record: seed a local dev DB per thread `user_seed`, drive the chat,
 * paste the real reply/citations/events into `recorded`, re-run.
 *
 * Usage: node eval/assistant/run.mjs   →  SUMMARY: 5/5 PASSED, exit 0.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const THREADS_DIR = path.resolve(HERE, "threads");

const KNOWN_EXPECT_KEYS = new Set([
  "must_cite_labels",
  "must_contain",
  "must_refuse_contains",
  "must_have_citations",
  "tool",
  "error",
]);

function isSubsetSubset(want, got, trail) {
  // Every key in `want` must exist in `got` with an equal primitive or a
  // recursively matching object. Arrays compare by JSON equality.
  for (const [k, v] of Object.entries(want)) {
    const g = got?.[k];
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      if (g === null || typeof g !== "object" || Array.isArray(g)) {
        return `${trail}.${k}: want object, got ${JSON.stringify(g)}`;
      }
      const sub = isSubsetSubset(v, g, `${trail}.${k}`);
      if (sub) return sub;
    } else if (JSON.stringify(g) !== JSON.stringify(v)) {
      return `${trail}.${k}: want ${JSON.stringify(v)}, got ${JSON.stringify(g)}`;
    }
  }
  return null;
}

function checkTurn(turn, tix) {
  const checks = [];
  const fail = (name, detail) => checks.push({ name, pass: false, detail });
  const pass = (name) => checks.push({ name, pass: true, detail: "" });
  const { expect: ex = {}, recorded: rec = {} } = turn;

  for (const key of Object.keys(ex)) {
    if (!KNOWN_EXPECT_KEYS.has(key)) {
      throw new Error(`${tix}: unknown expect field "${key}" (no check covers it)`);
    }
  }

  if (ex.error !== undefined) {
    const e = ex.error;
    if (rec.status !== e.status) fail("error.status", `want ${e.status}, got ${rec.status}`);
    else pass("error.status");
    if (rec.code !== e.code) fail("error.code", `want ${e.code}, got ${rec.code}`);
    else pass("error.code");
    if (e.plans_url !== undefined) {
      if (rec.plans_url !== e.plans_url) fail("error.plans_url", `want ${e.plans_url}, got ${rec.plans_url}`);
      else pass("error.plans_url");
    }
    if (e.retry_after_present === true) {
      if (typeof rec.retryAfter !== "number" || rec.retryAfter <= 0) {
        fail("error.retryAfter", `want positive number, got ${JSON.stringify(rec.retryAfter)}`);
      } else pass("error.retryAfter");
    }
    return checks;
  }

  const reply = typeof rec.reply === "string" ? rec.reply : "";
  const citations = Array.isArray(rec.citations) ? rec.citations : [];
  const events = Array.isArray(rec.events) ? rec.events : [];

  if (Array.isArray(ex.must_cite_labels)) {
    for (const label of ex.must_cite_labels) {
      const marker = `[${label}]`;
      if (!reply.includes(marker)) {
        fail("cite.marker", `reply missing inline marker ${marker}`);
        continue;
      }
      const entry = citations.find((c) => c?.label === label);
      if (!entry) fail("cite.entry", `citations[] has no entry with label "${label}"`);
      else if (typeof entry.id !== "string" || entry.id.length === 0) {
        fail("cite.entry", `entry "${label}" has no row id`);
      } else pass(`cite.${label}`);
    }
  }

  if (typeof ex.must_contain === "string") {
    if (reply.includes(ex.must_contain)) pass("reply.contains");
    else fail("reply.contains", `reply missing ${JSON.stringify(ex.must_contain)}`);
  }

  if (typeof ex.must_refuse_contains === "string") {
    if (reply.includes(ex.must_refuse_contains)) pass("refusal.text");
    else fail("refusal.text", `refusal missing ${JSON.stringify(ex.must_refuse_contains)}`);
    if (citations.length === 0) pass("refusal.no-citations");
    else fail("refusal.no-citations", `refusal carries ${citations.length} citations`);
  }

  if (ex.must_have_citations === false && ex.must_refuse_contains === undefined) {
    if (citations.length === 0) pass("reply.no-citations");
    else fail("reply.no-citations", `expected none, got ${citations.length}`);
  }

  if (ex.tool !== undefined) {
    const ev = events.find((x) => x?.type === "tool" && x?.tool === ex.tool.name);
    if (!ev) {
      fail("tool.event", `no tool event named "${ex.tool.name}"`);
    } else {
      pass("tool.event");
      if (ex.tool.args !== undefined) {
        const mismatch = isSubsetSubset(ex.tool.args, ev.args ?? {}, "tool.args");
        if (mismatch) fail("tool.args", mismatch);
        else pass("tool.args");
      }
      if (typeof ex.tool.url_prefix === "string") {
        if (typeof ev.url === "string" && ev.url.startsWith(ex.tool.url_prefix)) pass("tool.url");
        else fail("tool.url", `want prefix ${ex.tool.url_prefix}, got ${JSON.stringify(ev.url)}`);
      }
      if (typeof ev.result_summary !== "string" || ev.result_summary.length === 0) {
        fail("tool.summary", "tool event has empty result_summary");
      } else pass("tool.summary");
    }
  }

  const done = rec.done;
  if (done !== undefined) {
    if (typeof done.conversation_id === "string" && done.conversation_id.length > 0) pass("done.conversation");
    else fail("done.conversation", "done event missing conversation_id");
    if (typeof done.deduped === "boolean") pass("done.deduped");
    else fail("done.deduped", "done event missing deduped boolean");
  }

  return checks;
}

function main() {
  const files = fs.readdirSync(THREADS_DIR).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) throw new Error(`no threads in ${THREADS_DIR}`);
  let passCount = 0;
  console.log("=".repeat(70));
  console.log("Assistant golden threads — deterministic contract harness (no network)");
  console.log("=".repeat(70));
  for (const file of files) {
    const thread = JSON.parse(fs.readFileSync(path.join(THREADS_DIR, file), "utf8"));
    if (!thread.id || !Array.isArray(thread.turns) || thread.turns.length === 0) {
      throw new Error(`${file}: thread needs {id, turns[>=1]}`);
    }
    const checks = thread.turns.flatMap((t, i) => checkTurn(t, `${thread.id}#${i}`));
    const ok = checks.length > 0 && checks.every((c) => c.pass);
    if (ok) passCount += 1;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${thread.id} ${thread.label ?? ""} (${checks.length} checks)`);
    for (const c of checks) {
      if (!c.pass) console.log(`        FAIL ${c.name}: ${c.detail}`);
    }
  }
  console.log("=".repeat(70));
  console.log(`SUMMARY: ${passCount}/${files.length} PASSED`);
  console.log("=".repeat(70));
  if (passCount !== files.length) process.exit(1);
}

main();
