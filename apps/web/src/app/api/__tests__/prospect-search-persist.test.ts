import { describe, test, expect, vi, afterEach } from "vitest";
import { prospectSearch } from "../../../../../../packages/tools/prospect_search";

// prospect_search persistence contract (spec §9 / §11.4 + migration 0014):
// writes ONLY to prospects with spec-aligned columns, never to leads/messages.

function apolloPeopleOk() {
  return {
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({
      pagination: { total_entries: 2 },
      people: [
        {
          id: "ap-1",
          name: "Jane Doe",
          title: "CTO",
          organization: { name: "Acme" },
          email: "jane@acme.co",
        },
      ],
    }),
  };
}

function makeCaptureDb() {
  const calls: Array<{ table: string; rows: unknown }> = [];
  const db = {
    from: (table: string) => ({
      insert: async (rows: unknown) => {
        calls.push({ table, rows });
        return { error: null };
      },
    }),
  };
  return { db, calls };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("prospect_search persistence (spec-aligned)", () => {
  test("inserts only into prospects with 0014 columns", async () => {
    vi.stubEnv("APOLLO_API_KEY", "test-key");
    const { db, calls } = makeCaptureDb();
    const res = await prospectSearch(
      { startup_id: "s-1", target_customer: "CTO", domain: "saas" },
      db,
      (async () => apolloPeopleOk()) as unknown as typeof fetch,
    );
    expect(res.provider).toBe("apollo");
    expect(res.inserted).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("prospects");
    const row = (calls[0].rows as Array<Record<string, unknown>>)[0];
    // Spec §9 canonical columns …
    expect(row.startup_id).toBe("s-1");
    expect(row.apollo_id).toBe("ap-1");
    expect(row.match_reason).toMatch(/target_customer/);
    expect(row.company_name).toBe("Acme");
    expect(row.contact_name).toBe("Jane Doe");
    // … and never a leads/messages write.
    const tables = calls.map((c) => c.table);
    expect(tables).not.toContain("leads");
    expect(tables).not.toContain("messages");
  });

  test("search results returned even when prospects table missing", async () => {
    vi.stubEnv("APOLLO_API_KEY", "test-key");
    const db = {
      from: () => ({
        insert: async () => ({ error: { message: "relation prospects does not exist" } }),
      }),
    };
    const res = await prospectSearch(
      { startup_id: "s-1", target_customer: "CTO", domain: "saas" },
      db,
      (async () => apolloPeopleOk()) as unknown as typeof fetch,
    );
    expect(res.total_matched).toBe(2);
    expect(res.sample).toHaveLength(1);
    expect(res.inserted).toBe(0);
    expect(res.error).toMatch(/prospects does not exist/);
  });
});
