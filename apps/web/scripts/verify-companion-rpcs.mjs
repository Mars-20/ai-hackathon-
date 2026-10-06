// Task 10 — live RPC verification matrix for companion-memory (spec §3, plan Step 2).
//
// Usage:
//   node scripts/verify-companion-rpcs.mjs --env-file <path-to-.env.local>
//
// Live-fire only: creates two temp users (A+B) on the linked Supabase project,
// drives decide_memory / propose_memories through the USER-JWT path (the exact
// path the app uses — service-role is used ONLY for test setup/teardown and
// read-only assertions), then deletes both users. No secrets are printed.
// Exit code is non-zero on any failure.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--env-file") out.envFile = argv[++i];
  }
  return out;
}

// Minimal dotenv parser (KEY=VALUE, optional quotes, # comments). Values are
// never logged.
function loadEnvFile(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[t.slice(0, eq).trim()] = v;
  }
  return env;
}

const { envFile = "./.env.local" } = parseArgs(process.argv);
const fileEnv = loadEnvFile(envFile);
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? fileEnv.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? fileEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? fileEnv.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !ANON || !SERVICE) {
  console.error("missing Supabase env (url/anon/service)");
  process.exit(2);
}

const svc = createClient(URL, SERVICE, { auth: { persistSession: false } });
const anon = createClient(URL, ANON, { auth: { persistSession: false } });
const userClient = (token) =>
  createClient(URL, ANON, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function makeUser(tag) {
  const email = `verify-companion-${tag}-${Date.now().toString(36)}@example.com`;
  const password = `Vf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}-x9`;
  const { data, error } = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`admin createUser failed: ${error?.message}`);
  const { data: session, error: signErr } = await anon.auth.signInWithPassword({
    email,
    password,
  });
  if (signErr || !session.session) throw new Error(`sign-in failed: ${signErr?.message}`);
  return { id: data.user.id, token: session.session.access_token };
}

async function propose(client, userId, rows) {
  const { data, error } = await client.rpc("propose_memories", {
    p_user_id: userId,
    p_rows: rows,
  });
  if (error) throw new Error(`propose_memories rpc error: ${error.message}`);
  return data;
}

async function decide(client, userId, id, action, value) {
  const args = { p_user_id: userId, p_id: id, p_action: action };
  if (value !== undefined) args.p_value = value;
  const { data, error } = await client.rpc("decide_memory", args);
  if (error) throw new Error(`decide_memory rpc error: ${error.message}`);
  return data;
}

async function approvedCount(userId) {
  const { count, error } = await svc
    .from("companion_memory")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "approved");
  if (error) throw new Error(`count query failed: ${error.message}`);
  return count ?? 0;
}

async function pendingRows(userId) {
  const { data, error } = await svc
    .from("companion_memory")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "pending");
  if (error) throw new Error(`pending query failed: ${error.message}`);
  return data ?? [];
}

const row = (value, kind = "preference", confidence = 0.8) => ({
  kind,
  value,
  confidence,
  source_ref: "verify-matrix",
});

let A = null;
let B = null;
try {
  A = await makeUser("a");
  B = await makeUser("b");
  const a = userClient(A.token);
  const b = userClient(B.token);
  console.log("setup: temp users A+B created and signed in");

  // 1. approve + idempotent re-approve.
  const p1 = await propose(a, A.id, [row("prefers email summaries on fridays")]);
  check("propose single ok", p1.ok === true && p1.results?.[0]?.ok === true);
  const m1 = p1.results[0].id;
  const d1 = await decide(a, A.id, m1, "approve");
  check("approve -> approved", d1.ok === true && d1.row?.status === "approved");
  const d1b = await decide(a, A.id, m1, "approve");
  check(
    "re-approve idempotent OK",
    d1b.ok === true && d1b.row?.status === "approved" && d1b.row?.id === m1,
  );

  // 2. Full transition cycle on m2 + pending->reject on m3 (covers all six OK pairs).
  const p2 = await propose(a, A.id, [row("allergic to peanuts", "fact", 0.9)]);
  const m2 = p2.results[0].id;
  const seq = [];
  seq.push((await decide(a, A.id, m2, "approve")).row?.status); // pending->approved
  seq.push((await decide(a, A.id, m2, "reject")).row?.status); // approved->rejected
  seq.push((await decide(a, A.id, m2, "reject")).row?.status); // rejected->reject (idempotent)
  seq.push((await decide(a, A.id, m2, "approve")).row?.status); // rejected->approved
  seq.push((await decide(a, A.id, m2, "reject")).row?.status); // approved->rejected
  check(
    "transition cycle ends rejected, never pending",
    JSON.stringify(seq) === JSON.stringify(["approved", "rejected", "rejected", "approved", "rejected"]),
    `got ${JSON.stringify(seq)}`,
  );
  const p3 = await propose(a, A.id, [row("prefers morning standups", "style", 0.7)]);
  const m3 = p3.results[0].id;
  const d3 = await decide(a, A.id, m3, "reject");
  check("pending->reject OK", d3.ok === true && d3.row?.status === "rejected");

  // 3. Normalized-dupe -> MEMORY_DUPLICATE (SQL lower(trim()) fold of m1's value).
  const dupe = await propose(a, A.id, [row("  PREFERS EMAIL SUMMARIES ON FRIDAYS  ")]);
  check("normalized dupe -> MEMORY_DUPLICATE", dupe.results?.[0]?.code === "MEMORY_DUPLICATE");

  // 4. INVALID action.
  const inv = await decide(a, A.id, m1, "archive");
  check("bad action -> INVALID", inv.ok === false && inv.code === "INVALID");

  // 5. FORBIDDEN cross-user.
  const fb1 = await decide(b, A.id, m1, "approve");
  check("B decides A's row -> FORBIDDEN", fb1.ok === false && fb1.code === "FORBIDDEN");
  const fb2 = await propose(b, A.id, [row("cross user probe")]);
  check("B proposes as A -> FORBIDDEN", fb2.ok === false && fb2.code === "FORBIDDEN");

  // 6. STARTUP_NOT_OWNED: B owns a startup; A cites it.
  const { data: bWs, error: wsErr } = await svc
    .from("workspaces")
    .select("id")
    .eq("owner_id", B.id)
    .limit(1);
  if (wsErr || !bWs?.length) throw new Error("B has no workspace (handle_new_user trigger?)");
  const { data: bStartup, error: stErr } = await svc
    .from("startups")
    .insert({
      owner_id: B.id,
      workspace_id: bWs[0].id,
      name: "Verify Matrix Startup",
      one_liner: "Temporary startup for the companion RPC ownership probe.",
      domain: "devtools",
    })
    .select("id")
    .single();
  if (stErr || !bStartup) throw new Error(`startup setup failed: ${stErr?.message}`);
  const sno = await propose(a, A.id, [
    { kind: "fact", value: "cites another user's startup", confidence: 0.8, startup_id: bStartup.id },
  ]);
  check("foreign startup_id -> STARTUP_NOT_OWNED", sno.results?.[0]?.code === "STARTUP_NOT_OWNED");

  // 7. Pending overflow: reset pending, propose 21 -> 20 kept + 1 dropped id.
  for (const r of await pendingRows(A.id)) {
    await svc.from("companion_memory").delete().eq("id", r.id);
  }
  const bulk = Array.from({ length: 21 }, (_, i) =>
    row(`overflow probe ${i + 1} prefers async updates`, "preference", (i + 1) / 100),
  );
  const ov = await propose(a, A.id, bulk);
  const allOk = ov.ok === true && ov.results?.every((r) => r.ok === true);
  const droppedOne = Array.isArray(ov.dropped) && ov.dropped.length === 1;
  const droppedLowest = droppedOne && ov.dropped[0] === ov.results[0].id; // conf 0.01
  const pendingKept = (await pendingRows(A.id)).length;
  check("overflow: 21 results ok", allOk === true);
  check("overflow: exactly 1 dropped id (lowest confidence)", droppedLowest === true);
  check("overflow: 20 pending kept", pendingKept === 20, `got ${pendingKept}`);

  // 8. MEMORY_FULL: fill to exactly 200 approved, then the next approve fails.
  for (const r of await pendingRows(A.id)) {
    const d = await decide(a, A.id, r.id, "approve");
    if (!d.ok) throw new Error(`drain approve failed: ${d.code}`);
  }
  let approved = await approvedCount(A.id);
  let guard = 0;
  while (approved < 200 && guard++ < 15) {
    const n = Math.min(20, 200 - approved);
    const batch = Array.from({ length: n }, (_, i) =>
      row(`fill probe g${guard} n${i} prefers concise memos`, "fact", 0.6),
    );
    const pr = await propose(a, A.id, batch);
    if (!pr.results?.every((r) => r.ok === true)) throw new Error("fill propose failed");
    for (const r of pr.results) {
      const d = await decide(a, A.id, r.id, "approve");
      if (!d.ok) throw new Error(`fill approve failed at ${approved}: ${d.code}`);
    }
    approved = await approvedCount(A.id);
  }
  check("filled to exactly 200 approved", approved === 200, `got ${approved}`);
  const pFull = await propose(a, A.id, [row("one memory too many")]);
  const fullId = pFull.results?.[0]?.id;
  const dFull = await decide(a, A.id, fullId, "approve");
  check("201st approve -> MEMORY_FULL", dFull.ok === false && dFull.code === "MEMORY_FULL");
} catch (err) {
  failures++;
  console.log(`FAIL matrix aborted: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  // Teardown: delete both temp users; companion rows + startup must cascade.
  for (const u of [A, B]) {
    if (!u) continue;
    try {
      await svc.auth.admin.deleteUser(u.id);
    } catch (err) {
      console.log(`WARN cleanup delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    const ids = [A?.id, B?.id].filter(Boolean);
    const { data: orphans } = await svc.from("companion_memory").select("id").in("user_id", ids);
    check("no orphan companion rows after user delete", (orphans ?? []).length === 0, `got ${(orphans ?? []).length}`);
    if ((orphans ?? []).length > 0) {
      await svc.from("companion_memory").delete().in("user_id", ids);
    }
    const { data: orphanStartups } = await svc.from("startups").select("id").in("owner_id", ids);
    check("no orphan startups after user delete", (orphanStartups ?? []).length === 0);
  } catch (err) {
    failures++;
    console.log(`FAIL orphan scan: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(failures === 0 ? "MATRIX ALL PASS" : `MATRIX ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
