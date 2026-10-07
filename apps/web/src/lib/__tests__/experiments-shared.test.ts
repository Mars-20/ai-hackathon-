import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createExperiment,
  ExperimentError,
  updateExperiment,
} from "@/lib/experiments";

const UID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const S1 = "33333333-3333-4333-8333-333333333333";
const E1 = "44444444-4444-4444-8444-444444444444";

interface StartupRow {
  id: string;
  owner_id: string;
  workspace_id: string | null;
}

interface ExperimentRow {
  id: string;
  startup_id: string;
  workspace_id: string | null;
  assumption_id: string | null;
  type: string;
  design: string;
  status: string;
}

// Minimal thenable query fake: supports select/eq/maybeSingle + insert/update.
function makeClient(state: {
  startups: StartupRow[];
  experiments: ExperimentRow[];
}) {
  const inserted: Record<string, unknown>[] = [];
  const updated: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const table = (name: "startups" | "experiments") => ({
    select: () => table(name),
    eq: (_col: string, _val: unknown) => table(name),
    maybeSingle: async () => {
      if (name === "startups") {
        const row =
          state.startups.find((s) => s.id === S1) ?? null;
        return { data: row, error: null };
      }
      const row = state.experiments.find((e) => e.id === E1) ?? null;
      return { data: row, error: null };
    },
    insert: async (payload: Record<string, unknown>) => {
      inserted.push(payload);
      return { data: null, error: null };
    },
    update: (patch: Record<string, unknown>) => ({
      eq: async (_col: string, id: string) => {
        updated.push({ id, patch });
        return { data: null, error: null };
      },
    }),
  });
  return {
    client: { from: (name: "startups" | "experiments") => table(name) } as unknown as SupabaseClient,
    inserted,
    updated,
  };
}

describe("experiments-shared", () => {
  it("refuses insert on foreign startup", async () => {
    const { client } = makeClient({
      startups: [{ id: S1, owner_id: OTHER, workspace_id: null }],
      experiments: [],
    });
    await expect(
      createExperiment(client, UID, {
        startup_id: S1,
        type: "interview",
        design: "talk to 5 users",
        status: "draft",
      })
    ).rejects.toMatchObject({ code: "NOT_OWNED" });
  });

  it("inserts owned experiment with the agent-route column set", async () => {
    const { client, inserted } = makeClient({
      startups: [{ id: S1, owner_id: UID, workspace_id: "ws-1" }],
      experiments: [],
    });
    const out = await createExperiment(client, UID, {
      startup_id: S1,
      workspace_id: "ws-1",
      type: "interview",
      design: "talk to 5 users",
      status: "draft",
    });
    expect(out.id).toBeTypeOf("string");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      startup_id: S1,
      workspace_id: "ws-1",
      type: "interview",
      design: "talk to 5 users",
      status: "draft",
    });
  });

  it("inherits workspace_id from the parent startup when omitted", async () => {
    const { client, inserted } = makeClient({
      startups: [{ id: S1, owner_id: UID, workspace_id: "ws-9" }],
      experiments: [],
    });
    await createExperiment(client, UID, {
      startup_id: S1,
      type: "interview",
      design: "talk to 5 users",
      status: "draft",
    });
    expect(inserted[0]).toMatchObject({ workspace_id: "ws-9" });
  });

  it("refuses update on missing row", async () => {
    const { client } = makeClient({ startups: [], experiments: [] });
    await expect(
      updateExperiment(client, UID, {
        experiment_id: E1,
        patch: { status: "done" },
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses update on foreign experiment", async () => {
    const { client } = makeClient({
      startups: [{ id: S1, owner_id: OTHER, workspace_id: null }],
      experiments: [
        {
          id: E1,
          startup_id: S1,
          workspace_id: null,
          assumption_id: null,
          type: "interview",
          design: "d",
          status: "draft",
        },
      ],
    });
    await expect(
      updateExperiment(client, UID, {
        experiment_id: E1,
        patch: { status: "done" },
      })
    ).rejects.toMatchObject({ code: "NOT_OWNED" });
  });

  it("updates owned experiment with the patch only", async () => {
    const { client, updated } = makeClient({
      startups: [{ id: S1, owner_id: UID, workspace_id: null }],
      experiments: [
        {
          id: E1,
          startup_id: S1,
          workspace_id: null,
          assumption_id: null,
          type: "interview",
          design: "d",
          status: "draft",
        },
      ],
    });
    const out = await updateExperiment(client, UID, {
      experiment_id: E1,
      patch: { status: "done" },
    });
    expect(out).toEqual({ id: E1 });
    expect(updated).toEqual([{ id: E1, patch: { status: "done" } }]);
  });

  it("ExperimentError carries its code", () => {
    expect(new ExperimentError("NOT_OWNED")).toMatchObject({
      code: "NOT_OWNED",
    });
  });
});

