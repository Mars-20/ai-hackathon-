// ─────────────────────────────────────────────────────────────────────────────
// packages/admin/audit.ts — non-privileged audit path (spec §6).
// Inserts an `audit_log` row and WARN-AND-CONTINUES on failure.
// Privileged mutations (role grant/revoke, suspend/unsuspend, settings,
// platform grant/revoke) MUST go through the `admin_action` RPC instead, so
// audit failure rolls back the mutation — the two-client approach is
// forbidden for privileged paths.
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditEntry {
  actor: string;
  action: string;
  target?: Record<string, unknown>;
  reason?: string | null;
  diff?: Record<string, unknown> | null;
  workspace_id?: string | null;
  result?: string;
}

export interface AuditClient {
  from(table: string): {
    insert(values: Record<string, unknown>): PromiseLike<{ error: unknown }>;
  };
}

export async function audit(supabase: AuditClient, entry: AuditEntry): Promise<void> {
  const row: Record<string, unknown> = {
    actor: entry.actor,
    action: entry.action,
    target: entry.target ?? {},
    reason: entry.reason ?? null,
    diff: entry.diff ?? null,
    workspace_id: entry.workspace_id ?? null,
    result: entry.result ?? "ok",
  };
  const { error } = await supabase.from("audit_log").insert(row);
  if (error) {
    console.warn("[admin:audit] failed to write audit_log row (warn-and-continue)", error);
  }
}
