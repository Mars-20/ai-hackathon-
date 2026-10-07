import { describe, test, expect, vi, afterEach } from "vitest";
import { prospectSearch } from "../../../../../../packages/tools/prospect_search";

// Apollo endpoint whitelist: the search-only tool may call exactly one
// network endpoint (mixed_people/search). Any future sequence/enrich URL
// added to this module breaks the build by design (spec §7 hard boundary).

const ALLOWLISTED = "https://api.apollo.io/v1/mixed_people/search";

function apolloEmpty() {
  return {
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({ pagination: { total_entries: 0 }, people: [] }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("apollo endpoint whitelist", () => {
  test("all network calls across varied inputs hit only the search endpoint", async () => {
    vi.stubEnv("APOLLO_API_KEY", "test-key");
    const urls: string[] = [];
    const fetchMock = (async (url: unknown) => {
      urls.push(String(url));
      return apolloEmpty();
    }) as unknown as typeof fetch;

    const inputs = [
      { startup_id: "s-1", target_customer: "CTO", domain: "saas", keywords: "ai" },
      { startup_id: "s-1", target_customer: "Founder", domain: "fintech", limit: 3 },
      { startup_id: "s-2", target_customer: "VP Sales", domain: "health" },
    ];
    for (const input of inputs) {
      await prospectSearch(input, undefined, fetchMock);
    }
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u).toBe(ALLOWLISTED);
    }
  });

  test("module has no sequence-management capability (endpoints or SDK calls)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "..", "..", "packages", "tools", "prospect_search.ts"),
      "utf8",
    );
    // Capability identifiers — prose decision comments may still name the
    // downgraded scope (e.g. "never to sequences"), so match code shapes.
    expect(src).not.toMatch(/createSequence|startSequence|enrollLead|autoEnroll/i);
    expect(src).not.toMatch(/into sequences/i);
    expect(src).not.toMatch(/\/sequences|\/cadence|nurture\//i);
    // Every Apollo URL in the module must be the allowlisted search endpoint.
    const urls = src.match(/https:\/\/api\.apollo\.io[^\s"']*/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u).toBe(ALLOWLISTED);
    }
  });
});
