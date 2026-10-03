/**
 * Recorded deterministic fixtures (no network). Each eval/fixtures/gt-*.json
 * is a recorded agent output ("done") with verdict, evidence[].source_url and
 * trace[].event_type fields consumed by the runner.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_IDS = [
  "gt-001",
  "gt-002",
  "gt-003",
  "gt-004",
  "gt-005",
  "gt-006",
  "gt-007",
  "gt-008",
];

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");

export function loadFixture(id) {
  return JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), "utf8"));
}

export function loadAllFixtures() {
  return Object.fromEntries(FIXTURE_IDS.map((id) => [id, loadFixture(id)]));
}
