import { afterEach, describe, expect, test, vi } from "vitest";

import { getExaKey, matchClaimsToSources, searchExa } from "../exa-search";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetchOnce(payload: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(payload),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("getExaKey", () => {
  test("trims the configured key", () => {
    expect(getExaKey({ EXA_API_KEY: "  k-1 " })).toBe("k-1");
  });

  test("returns empty when nothing is configured", () => {
    expect(getExaKey({})).toBe("");
  });
});

describe("searchExa", () => {
  test("sends the skill-recommended request and nothing else", async () => {
    const fetchMock = stubFetchOnce({ results: [] });
    await searchExa("B2B SaaS market size 2025", { EXA_API_KEY: "k-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.exa.ai/search");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k-1");
    expect(JSON.parse(init.body as string)).toEqual({
      query: "B2B SaaS market size 2025",
      type: "auto",
      contents: { highlights: true },
    });
  });

  test("normalizes results and drops entries without an http URL", async () => {
    stubFetchOnce({
      results: [
        {
          title: "SaaS Report 2025",
          url: "https://example.com/saas-2025",
          highlights: ["Market hit $300B."],
          publishedDate: "2025-01-15",
        },
        { title: "No URL here", url: "", highlights: ["x"] },
        { title: "Bad URL", url: "notaurl", highlights: [] },
        { title: "No highlights", url: "https://example.com/plain" },
      ],
    });
    const out = await searchExa("q", { EXA_API_KEY: "k" });
    expect(out).toEqual([
      {
        title: "SaaS Report 2025",
        url: "https://example.com/saas-2025",
        highlights: ["Market hit $300B."],
        publishedDate: "2025-01-15",
      },
      { title: "No highlights", url: "https://example.com/plain", highlights: [] },
    ]);
  });

  test("returns [] without calling fetch when the key is missing", async () => {
    const fetchMock = stubFetchOnce({ results: [] });
    await expect(searchExa("q", {})).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns [] on non-OK status", async () => {
    stubFetchOnce({ error: "unauthorized" }, false, 401);
    await expect(searchExa("q", { EXA_API_KEY: "bad" })).resolves.toEqual([]);
  });

  test("returns [] on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("boom"))
    );
    await expect(searchExa("q", { EXA_API_KEY: "k" })).resolves.toEqual([]);
  });

  test("returns [] on malformed body", async () => {
    stubFetchOnce({ results: "nope" });
    await expect(searchExa("q", { EXA_API_KEY: "k" })).resolves.toEqual([]);
  });
});

describe("matchClaimsToSources", () => {
  const sources = [
    { title: "A", url: "https://a.example/r", highlights: [] },
    { title: "B", url: "https://b.example/r", highlights: [] },
  ];

  test("keeps only claims whose URL is an Exa-returned source URL", () => {
    const out = matchClaimsToSources(
      [
        { claim: "Real fact.", url: "https://a.example/r" },
        { claim: "Invented link.", url: "https://evil.example/fake" },
        { claim: "No link.", url: "" },
        { claim: "   ", url: "https://b.example/r" },
      ],
      sources
    );
    expect(out).toEqual([{ claim: "Real fact.", url: "https://a.example/r" }]);
  });

  test("caps at 6 claims", () => {
    const claims = Array.from({ length: 9 }, (_, i) => ({
      claim: `Fact ${i}.`,
      url: "https://a.example/r",
    }));
    expect(matchClaimsToSources(claims, sources)).toHaveLength(6);
  });
});
