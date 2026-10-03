// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/ops/limits → { window, severity, errorsByActor,
// rateLimited429, configured, truncated } (Task 5 ops module).
// Severity is derived from trace_events over the window (?window=7d|30d|
// 90d, default 7d; custom capped at 90d via parseAdminWindow):
// error = event_type 'error'; warning = verification events carrying a
// warning/unsupported payload; info = everything else. rateLimited429
// counts events whose payload mentions a 429/rate-limit signal (documented
// heuristic — the agent route enforces its in-memory 10 req/min cap without
// persisting a row, so only surfaced signals are counted). `configured`
// echoes the compiled caps as a read-only reference (BUDGET from
// apps/web/src/lib/utils.ts — imported read-only, never modified — plus
// the agent route's per-IP request cap). Server cap (traces 10000) sets
// `truncated: true` when it binds. NULL-workspace rows EXCLUDED on the
// platform path; workspace path via user client (RLS) + scopedQuery.
// Matrix: platform full; workspace-tier member+ read scoped to own
// workspaces; viewers NONE at the gate. Errors use the admin-only
// envelope { error, code } via toEnvelope().
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  parseAdminWindow,
  requireAdminFromSupabase,
  scopedAdminQuery,
  toEnvelope,
} from "@/lib/admin";
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";
import { BUDGET } from "@/lib/utils";

// Agent route cap (apps/web/src/lib/rate-limit.ts RATE_MAX, distributed
// sliding-window 10 req/min) — echoed here as a read-only reference.
const AGENT_REQUESTS_PER_MINUTE = 10;
const TRACE_CAP = 10000;

interface TraceRow {
  actor: string;
  event_type: string;
  payload: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asTraceRows(value: unknown): TraceRow[] {
  if (!Array.isArray(value)) return [];
  const out: TraceRow[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    out.push({
      actor: typeof item["actor"] === "string" ? item["actor"] : "unknown",
      event_type:
        typeof item["event_type"] === "string"
          ? (item["event_type"] as string)
          : "",
      payload: item["payload"] ?? null,
    });
  }
  return out;
}

function isWarningEvent(row: TraceRow): boolean {
  if (row.event_type !== "verification") return false;
  if (!isRecord(row.payload)) return false;
  const warning = row.payload["warning"];
  const unsupported = row.payload["unsupported_count"];
  const claims = row.payload["unsupported_claims"];
  return (
    (typeof warning === "string" && warning.length > 0) ||
    (typeof unsupported === "number" && unsupported > 0) ||
    (Array.isArray(claims) && claims.length > 0)
  );
}

function mentionsRateLimit(payload: unknown): boolean {
  if (payload === null || payload === undefined) return false;
  const text =
    typeof payload === "string" ? payload : JSON.stringify(payload);
  return /429|rate.?limit/i.test(text);
}

export async function GET(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdminFromSupabase();
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }

  let window;
  try {
    window = parseAdminWindow(new URL(request.url).searchParams);
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }

  try {
    let traces: TraceRow[];
    let truncated = false;

    if (admin.tier === "platform") {
      const service = createServiceRoleClient();
      // NULL workspace_id rows EXCLUDED — never attributed.
      const tracesRes = await service
        .from("trace_events")
        .select("actor,event_type,payload")
        .gte("created_at", window.from)
        .lte("created_at", window.to)
        .not("workspace_id", "is", null)
        .limit(TRACE_CAP);
      if (tracesRes.error) throw tracesRes.error;
      traces = asTraceRows(tracesRes.data);
      if (traces.length >= TRACE_CAP) truncated = true;
    } else {
      // Workspace tier: user client (RLS) + scopedQuery — the scoping
      // predicate `.in('workspace_id', workspaceIds)` is appended inside
      // scopedQuery (NULL rows never match the IN list).
      const userClient = await createServerSupabaseClient();
      const traceRowsUnknown: unknown = await scopedAdminQuery(
        userClient,
        "trace_events",
        admin.workspaceIds,
        (q) =>
          q
            .select("actor,event_type,payload")
            .gte("created_at", window.from)
            .lte("created_at", window.to)
            .limit(TRACE_CAP),
      );
      traces = asTraceRows(traceRowsUnknown);
      if (traces.length >= TRACE_CAP) truncated = true;
    }

    const severity = { error: 0, warning: 0, info: 0 };
    const errorsByActor: Record<string, number> = {};
    let rateLimited429 = 0;
    for (const row of traces) {
      if (row.event_type === "error") {
        severity.error += 1;
        errorsByActor[row.actor] = (errorsByActor[row.actor] ?? 0) + 1;
      } else if (isWarningEvent(row)) {
        severity.warning += 1;
      } else {
        severity.info += 1;
      }
      if (mentionsRateLimit(row.payload)) rateLimited429 += 1;
    }

    return NextResponse.json({
      window: {
        preset: window.preset,
        from: window.from,
        to: window.to,
        days: window.days,
      },
      severity,
      errorsByActor,
      rateLimited429,
      configured: {
        maxCostUsd: BUDGET.MAX_COST_USD,
        maxToolCalls: BUDGET.MAX_TOOL_CALLS,
        hardTimeoutMs: BUDGET.HARD_TIMEOUT_MS,
        agentRequestsPerMinute: AGENT_REQUESTS_PER_MINUTE,
      },
      truncated,
    });
  } catch (err: unknown) {
    const envelope = toEnvelope(err);
    return NextResponse.json(envelope.body, { status: envelope.status });
  }
}
