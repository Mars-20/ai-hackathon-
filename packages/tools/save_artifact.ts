/**
 * save_artifact tool (Section 7)
 * Persists validation artifacts (assumption_map, experiment_design, decision_memo)
 * to Supabase or local store and returns an ID and dashboard URL.
 *
 * Pure behaviour is preserved when no Supabase client is passed.
 * Pass a Supabase client as the LAST optional param to persist to
 * trace_events (RLS enforced server-side). startup_id is required (no null
 * inserts on the user path); system-level artifacts without a startup go
 * through the service_role client (service_role bypasses RLS, so the caller
 * must hold the service key — never expose it client-side).
 */

export interface ArtifactPayload {
  type: "assumption_map" | "experiment_design" | "decision_memo";
  startup_id?: string;
  workspace_id?: string;
  content: Record<string, unknown>;
}

export interface SaveArtifactResult {
  id: string;
  type: string;
  url: string;
  saved_at: string;
}

export interface SupabaseLike {
  from(table: string): any;
}

export async function saveArtifact(
  payload: ArtifactPayload,
  supabase?: SupabaseLike,
  serviceRole?: SupabaseLike
): Promise<SaveArtifactResult> {
  const id = crypto.randomUUID();
  const saved_at = new Date().toISOString();
  // Dashboard deep link (not a bare artifact:// URI).
  const url = `/validate?artifact=${id}`;

  if (!supabase && !serviceRole) {
    return {
      id,
      type: payload.type,
      url,
      saved_at,
    };
  }

  // startup_id is required on the user path — no null inserts.
  const workspace_id = (payload as { workspace_id?: string }).workspace_id ?? null;
  if (!payload.startup_id) {
    // System-level artifact: service_role path only, workspace-scoped.
    if (!serviceRole || !workspace_id) {
      throw new Error(
        "startup_id is required (no null inserts); system artifacts must use the service_role client with workspace_id."
      );
    }
    const { error } = await serviceRole.from("trace_events").insert({
      startup_id: null,
      workspace_id,
      actor: "tool",
      event_type: "tool_result",
      payload: {
        tool: "save_artifact",
        artifact_id: id,
        artifact_type: payload.type,
        content: payload.content,
      },
    });
    if (error) {
      throw new Error(error.message ?? "Failed to persist artifact");
    }
    return { id, type: payload.type, url, saved_at };
  }

  // DB wiring: persist artifact snapshot into trace_events so the dashboard
  // trace panel can render it.
  const writer = supabase ?? serviceRole!;
  const { error } = await writer.from("trace_events").insert({
    startup_id: payload.startup_id,
    workspace_id,
    actor: "tool",
    event_type: "tool_result",
    payload: {
      tool: "save_artifact",
      artifact_id: id,
      artifact_type: payload.type,
      content: payload.content,
    },
  });
  if (error) {
    throw new Error(error.message ?? "Failed to persist artifact");
  }

  return {
    id,
    type: payload.type,
    url,
    saved_at,
  };
}
