/**
 * save_artifact tool (Section 7)
 * Persists validation artifacts (assumption_map, experiment_design, decision_memo)
 * to Supabase or local store and returns an ID and URL.
 *
 * Pure behaviour is preserved when no Supabase client is passed.
 * Pass a Supabase client as the LAST optional param to persist to
 * trace_events (RLS enforced server-side) and return a real
 * UUID-based path of the form artifact://{id}.
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
  supabase?: SupabaseLike
): Promise<SaveArtifactResult> {
  const id = crypto.randomUUID();
  const saved_at = new Date().toISOString();
  const url = `artifact://${id}`;

  if (!supabase) {
    return {
      id,
      type: payload.type,
      url,
      saved_at,
    };
  }

  // DB wiring: persist artifact snapshot into trace_events so the dashboard
  // trace panel can render it; startup_id is nullable for system-level events.
  const { error } = await supabase.from("trace_events").insert({
    startup_id: payload.startup_id ?? null,
    workspace_id: (payload as { workspace_id?: string }).workspace_id ?? null,
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
