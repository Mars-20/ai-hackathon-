import { afterEach, describe, expect, test, vi } from "vitest";

import { __resetSnovTokenCache, searchSnovLeads } from "../snov";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SNOV_API_USER_ID;
  delete process.env.SNOV_API_SECRET;
  delete process.env.SNOV_MAX_REVEALS;
  __resetSnovTokenCache();
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function stubFetch(impl: (url: string, init?: RequestInit) => unknown) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => Promise.resolve(impl(url, init)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function seedCreds() {
  process.env.SNOV_API_USER_ID = "uid-1";
  process.env.SNOV_API_SECRET = "sec-1";
}

const PROSPECT = (i: number) => ({
  first_name: `First${i}`,
  last_name: "La***",
  job_title: "ceo",
  location: "Berlin, Germany",
  linkedin_url: "https://linkedin.com/in/fi******",
  industry: "Computer Software",
  company: { name: "Acme GmbH", domain: "acme.example", location: "Berlin", industry: "Computer Software", size: "11-50" },
  email_and_hidden_info_reveal: `https://api.snov.io/v2/database-search/prospects/search-emails/start/hash-${i}`,
});

function happyFetch() {
  return stubFetch((url: string) => {
    if (url.includes("/v1/oauth/access_token")) return jsonResponse(200, { access_token: "tok-1", expires_in: 3600 });
    if (url.includes("/prospects/start") && !url.includes("search-emails"))
      return jsonResponse(202, { meta: { task_hash: "th-1" }, links: { result: "https://api.snov.io/v2/database-search/prospects/result/th-1" } });
    if (url.includes("/prospects/result/"))
      return jsonResponse(200, { status: "completed", data: { total: 2, prospects: [PROSPECT(0), PROSPECT(1)] } });
    if (url.includes("/search-emails/start/"))
      return jsonResponse(200, { meta: { task_hash: "rev-1" }, links: { result: "https://api.snov.io/v2/database-search/prospects/search-emails/result/rev-1" } });
    if (url.includes("/search-emails/result/"))
      return jsonResponse(200, {
        status: "completed",
        data: { first_name: "First0", last_name: "Lastname0", linkedin_url: "https://linkedin.com/in/first0", email: "first0@acme.example", email_status: "valid" },
      });
    throw new Error("unexpected snov url " + url);
  });
}

const PARAMS = { targetCustomer: "startup founders", domain: "saas" };

describe("searchSnovLeads", () => {
  test("returns mock error when credentials are missing", async () => {
    const out = await searchSnovLeads(PARAMS);
    expect(out.provider).toBe("mock");
    expect(out.error).toMatch(/not configured/);
    expect(out.leads).toEqual([]);
  });

  test("searches with Bearer token and maps revealed prospects to leads", async () => {
    seedCreds();
    const fetchMock = happyFetch();
    const out = await searchSnovLeads(PARAMS);
    expect(out.error).toBeUndefined();
    expect(out.provider).toBe("snov");
    expect(out.leads).toHaveLength(2);
    expect(out.leads[0]).toMatchObject({ name: "First0 Lastname0", title: "ceo", company: "Acme GmbH", email: "first0@acme.example", linkedin_url: "https://linkedin.com/in/first0" });
    const startCall = fetchMock.mock.calls.find(([u]) => (u as string).includes("/prospects/start"));
    expect(startCall).toBeDefined();
    expect((startCall?.[1]?.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok-1");
  });

  test("caches the access token across calls", async () => {
    seedCreds();
    const fetchMock = happyFetch();
    await searchSnovLeads(PARAMS);
    await searchSnovLeads(PARAMS);
    const tokenCalls = fetchMock.mock.calls.filter(([u]) => (u as string).includes("/v1/oauth/access_token"));
    expect(tokenCalls).toHaveLength(1);
  });

  test("caps email reveals at SNOV_MAX_REVEALS", async () => {
    seedCreds();
    process.env.SNOV_MAX_REVEALS = "1";
    const fetchMock = happyFetch();
    const out = await searchSnovLeads(PARAMS);
    const revealCalls = fetchMock.mock.calls.filter(([u]) => (u as string).includes("/search-emails/start/"));
    expect(revealCalls).toHaveLength(1);
    expect(out.leads).toHaveLength(1);
  });

  test("fails fast with error on 401 invalid credentials", async () => {
    seedCreds();
    stubFetch((url: string) => {
      if (url.includes("/v1/oauth/access_token")) return jsonResponse(401, { error: "invalid_client" });
      throw new Error("unexpected snov url " + url);
    });
    const out = await searchSnovLeads(PARAMS);
    expect(out.provider).toBe("snov");
    expect(out.error).toMatch(/401/);
    expect(out.leads).toEqual([]);
  });
});
