// Shared ownership-checked experiments helper (agent route + assistant chat).
// The agent route previously inlined this insert (route.ts:2356-2365) with no
// ownership re-check; chat tool calls arrive without a loaded startup, so the
// check lives here and both callers share it.

import type { SupabaseClient } from "@supabase/supabase-js";

export type ExperimentCode = "NOT_OWNED" | "NOT_FOUND" | "NOT_DRAFT";

export class ExperimentError extends Error {
  code: ExperimentCode;
  constructor(code: ExperimentCode) {
    super(code);
    this.code = code;
  }
}

export interface ExperimentInput {
  id?: string;
  startup_id: string;
  /** Resolved caller workspace; omitted → inherited from the parent startup. */
  workspace_id?: string | null;
  assumption_id?: string | null;
  type: string;
  design: unknown;
  status: string;
}

export interface ExperimentPatch {
  status?: string;
  design?: unknown;
  assumption_id?: string | null;
}

interface StartupOwnership {
  id: string;
  owner_id: string;
  workspace_id: string | null;
}

async function assertOwnsStartup(
  client: SupabaseClient,
  userId: string,
  startupId: string
): Promise<StartupOwnership> {
  const { data, error } = await client
    .from("startups")
    .select("id,owner_id,workspace_id")
    .eq("id", startupId)
    .maybeSingle();
  const row = data as unknown as StartupOwnership | null;
  if (error || !row || row.owner_id !== userId) {
    throw new ExperimentError("NOT_OWNED");
  }
  return row;
}

export async function createExperiment(
  client: SupabaseClient,
  userId: string,
  input: ExperimentInput
): Promise<{ id: string }> {
  const startup = await assertOwnsStartup(client, userId, input.startup_id);
  const id =
    input.id ??
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const { error } = await client.from("experiments").insert({
    id,
    startup_id: input.startup_id,
    workspace_id: input.workspace_id ?? startup.workspace_id,
    assumption_id: input.assumption_id ?? null,
    type: input.type,
    design: input.design,
    status: input.status,
  });
  if (error) throw error;
  return { id };
}

export async function updateExperiment(
  client: SupabaseClient,
  userId: string,
  args: { experiment_id: string; patch: ExperimentPatch }
): Promise<{ id: string }> {
  const { data, error } = await client
    .from("experiments")
    .select("id,startup_id")
    .eq("id", args.experiment_id)
    .maybeSingle();
  if (error) throw error;
  const row = data as unknown as { id: string; startup_id: string } | null;
  if (!row) throw new ExperimentError("NOT_FOUND");
  await assertOwnsStartup(client, userId, row.startup_id);
  const { error: updateError } = await client
    .from("experiments")
    .update({ ...args.patch })
    .eq("id", args.experiment_id);
  if (updateError) throw updateError;
  return { id: args.experiment_id };
}

/** Undo for chat-created experiments: delete an OWNED experiment that is
 * still a draft. Non-draft rows (approved/running/completed) refuse with
 * NOT_DRAFT — reverting live work is a Project-A-grade decision, not an
 * undo. Used by the assistant-tools undo endpoint only. */
export async function deleteExperiment(
  client: SupabaseClient,
  userId: string,
  experimentId: string
): Promise<{ id: string }> {
  const { data, error } = await client
    .from("experiments")
    .select("id,startup_id,status")
    .eq("id", experimentId)
    .maybeSingle();
  if (error) throw error;
  const row = data as unknown as { id: string; startup_id: string; status: string } | null;
  if (!row) throw new ExperimentError("NOT_FOUND");
  await assertOwnsStartup(client, userId, row.startup_id);
  if (row.status !== "draft") throw new ExperimentError("NOT_DRAFT");
  const { error: deleteError } = await client
    .from("experiments")
    .delete()
    .eq("id", experimentId);
  if (deleteError) throw deleteError;
  return { id: experimentId };
}

