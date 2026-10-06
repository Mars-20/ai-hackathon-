import { describe, expect, test } from "vitest";
import {
  resolveEffectiveWorkspaceId,
  verifyWorkspaceMembership,
  type WorkspaceClient,
} from "@/lib/agent-workspace";

// ─────────────────────────────────────────────────────────────────────────────
// resolveEffectiveWorkspaceId (TDD for the decision/history persistence fix)
// prod enforces workspace_id NOT NULL (migration 0008); the agent must never
// write NULL. Minimal postgrest-style chain fake — no module mocks needed.
// ─────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

function makeFake(opts: {
  memberships?: Row[];
  createdWorkspace?: Row | null;
  failWorkspaceInsert?: boolean;
}) {
  const calls: Array<{ table: string; op: string; payload?: unknown }> = [];
  const memberships = opts.memberships ?? [];
  const table = (name: string) => {
    const builder = {
      select() {
        calls.push({ table: name, op: "select" });
        return builder;
      },
      insert(payload: unknown) {
        calls.push({ table: name, op: "insert", payload });
        return builder;
      },
      eq() {
        return builder;
      },
      limit() {
        return builder;
      },
      maybeSingle: () => {
        if (name === "workspace_members")
          return Promise.resolve({ data: memberships[0] ?? null, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      single: () => {
        if (name === "workspaces") {
          if (opts.failWorkspaceInsert || !opts.createdWorkspace)
            return Promise.resolve({ data: null, error: { message: "insert failed" } });
          return Promise.resolve({ data: opts.createdWorkspace, error: null });
        }
        return Promise.resolve({ data: null, error: { message: "none" } });
      },
      // Awaited directly, the real client executes the SELECT: resolve the
      // table fixture (arrays for list selects, like validate/page.tsx).
      then: (res: (v: unknown) => unknown) => {
        const data = name === "workspace_members" ? memberships : null;
        return Promise.resolve({ data, error: null }).then(res);
      },
    };
    return builder;
  };
  const client = { from: (t: string) => table(t) } as unknown as WorkspaceClient;
  return { calls, client };
}

describe("resolveEffectiveWorkspaceId", () => {
  test("requested workspace with membership wins (no writes)", async () => {
    const { calls, client } = makeFake({ memberships: [{ workspace_id: "ws-1" }] });
    const id = await resolveEffectiveWorkspaceId(client, "u1", "ws-1");
    expect(id).toBe("ws-1");
    expect(calls.filter((c) => c.op === "insert")).toHaveLength(0);
  });

  test("requested workspace without membership fails closed (no writes)", async () => {
    const { calls, client } = makeFake({ memberships: [] });
    const id = await resolveEffectiveWorkspaceId(client, "u1", "ws-evil");
    expect(id).toBeNull();
    expect(calls.filter((c) => c.op === "insert")).toHaveLength(0);
  });

  test("no request + existing membership uses first membership (no writes)", async () => {
    const { calls, client } = makeFake({ memberships: [{ workspace_id: "ws-9" }] });
    const id = await resolveEffectiveWorkspaceId(client, "u1", "");
    expect(id).toBe("ws-9");
    expect(calls.filter((c) => c.op === "insert")).toHaveLength(0);
  });

  test("no request + no membership creates personal workspace + owner membership", async () => {
    const { calls, client } = makeFake({
      memberships: [],
      createdWorkspace: { id: "ws-new" },
    });
    const id = await resolveEffectiveWorkspaceId(client, "u1", "");
    expect(id).toBe("ws-new");
    const wsInsert = calls.find((c) => c.table === "workspaces" && c.op === "insert");
    expect(wsInsert?.payload).toMatchObject({ owner_id: "u1", plan: "free" });
    const mInsert = calls.find((c) => c.table === "workspace_members" && c.op === "insert");
    expect(mInsert?.payload).toMatchObject({ workspace_id: "ws-new", user_id: "u1", role: "owner" });
  });

  test("workspace creation failure fails closed (null, streaming preserved)", async () => {
    const { client } = makeFake({ memberships: [], failWorkspaceInsert: true });
    const id = await resolveEffectiveWorkspaceId(client, "u1", "");
    expect(id).toBeNull();
  });

  test("never returns empty string (NOT NULL guard)", async () => {
    const { client } = makeFake({ memberships: [] });
    const id = await resolveEffectiveWorkspaceId(client, "u1", "");
    // Either a real id or null — never "" (which the DB rejects).
    expect(id === null || (typeof id === "string" && id.length > 0)).toBe(true);
  });
});

describe("verifyWorkspaceMembership (spend-bucket guard, review #12)", () => {
  test("true only for the requested workspace the user belongs to", async () => {
    const { client } = makeFake({ memberships: [{ workspace_id: "ws-1" }] });
    await expect(verifyWorkspaceMembership(client, "u1", "ws-1")).resolves.toBe(true);
    await expect(verifyWorkspaceMembership(client, "u1", "ws-evil")).resolves.toBe(false);
  });

  test("false with no memberships and on lookup error (falls back to user id)", async () => {
    const { client } = makeFake({ memberships: [] });
    await expect(verifyWorkspaceMembership(client, "u1", "ws-1")).resolves.toBe(false);
    const failing = {
      from: () => {
        throw new Error("db down");
      },
    } as unknown as WorkspaceClient;
    await expect(verifyWorkspaceMembership(failing, "u1", "ws-1")).resolves.toBe(false);
  });

  test("false without querying on empty ids", async () => {
    const { calls, client } = makeFake({ memberships: [{ workspace_id: "ws-1" }] });
    await expect(verifyWorkspaceMembership(client, "", "ws-1")).resolves.toBe(false);
    await expect(verifyWorkspaceMembership(client, "u1", "")).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });
});
