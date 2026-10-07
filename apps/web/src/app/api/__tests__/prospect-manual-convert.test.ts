import { describe, test, expect } from "vitest";
import { executeCampaignAction } from "../../../../../../packages/tools/campaign";

// Manual-convert flow (spec §11.4): founder-contacted prospect → leads row
// with source='prospect_manual_convert' + source_prospect_id. Consent gate
// applies unchanged — the link records provenance, never a bypass.

function makeDb(capture: { row?: unknown }) {
  return {
    from: (table: string) => ({
      insert: (row: unknown) => ({
        select: () => ({
          single: async () => {
            capture.row = { table, row };
            return { data: { id: "lead-1", ...(row as object) }, error: null };
          },
        }),
      }),
    }),
  };
}

describe("manual prospect convert (campaign create_lead)", () => {
  test("passes source_prospect_id through with full consent", async () => {
    const capture: { row?: unknown } = {};
    const res = await executeCampaignAction(
      "create_lead",
      {
        startup_id: "s-1",
        email: "jane@acme.co",
        source: "prospect_manual_convert",
        source_prospect_id: "prospect-1",
        consent_given: true,
        consent_timestamp: new Date().toISOString(),
        consent_text: "I agree to receive follow-ups",
      },
      makeDb(capture),
    );
    expect(res.success).toBe(true);
    const saved = capture.row as { table: string; row: Record<string, unknown> };
    expect(saved.table).toBe("leads");
    expect(saved.row.source).toBe("prospect_manual_convert");
    expect(saved.row.source_prospect_id).toBe("prospect-1");
    expect(saved.row.consent_given).toBe(true);
  });

  test("manual-convert without consent still blocked", async () => {
    const capture: { row?: unknown } = {};
    const res = await executeCampaignAction(
      "create_lead",
      {
        startup_id: "s-1",
        email: "jane@acme.co",
        source: "prospect_manual_convert",
        source_prospect_id: "prospect-1",
        consent_given: false,
      },
      makeDb(capture),
    );
    expect(res.success).toBe(false);
    expect(res.error ?? "").toMatch(/Consent required/);
    expect(capture.row).toBeUndefined();
  });
});
