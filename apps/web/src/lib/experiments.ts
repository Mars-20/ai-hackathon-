// Shared ownership-checked experiments helper (agent route + assistant chat).
// The agent route previously inlined this insert (route.ts:2356-2365) with no
// ownership re-check; chat tool calls arrive without a loaded startup, so the
// check lives here and both callers share it.

import type { SupabaseClient } from "@supabase/supabase-js";

export type ExperimentCode = "NOT_OWNED" | "NOT_FOUND";

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
  design?: string;
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

