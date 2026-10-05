import { afterEach, describe, expect, test, vi } from "vitest";

import { searchLeads } from "../apollo";

afterEach(() => {
  vi.unstubAllGlobals();
});

function apolloOk(names: string[]) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        people: names.map((name, i) => ({
          id: `p-${i}`,
          name,
          title: "CEO",
          organization: { name: "Acme" },
        })),
        pagination: { total_entries: names.length },
      }),
  };
}

function stubFetchSequence(
  seq: Array<{ ok: boolean; status: number; body?: unknown; text?: string }>
) {
  const fetchMock = vi.fn().mockImplementation(() => {
    const next = seq.shift() ?? seq[seq.length - 1];
    return Promise.resolve({
      ok: next.ok,
      status: next.status,
      json: () => Promise.resolve(next.body ?? {}),
      text: () => Promise.resolve(next.text ?? ""),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const PARAMS = { targetCustomer: "startup founders", domain: "saas" };

describe("searchLeads key pool", () => {
  test("returns mock error when no key is configured", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const out = await searchLeads(PARAMS);
    expect(out.provider).toBe("mock");
    expect(out.error).toMatch(/not configured/);
  });

  test("rotates to the next key on 429", async () => {
    process.env.APOLLO_API_KEYS = "k-1,k-2";
    delete process.env.APOLLO_API_KEY;
    try {
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(() =>
          Promise.resolve({
            ok: false,
            status: 429,
            json: () => Promise.resolve({}),
            text: () => Promise.resolve("rate limited"),
          })
        )
        .mockImplementationOnce(() => Promise.resolve(apolloOk(["Jane"])));
      vi.stubGlobal("fetch", fetchMock);
      const out = await searchLeads(PARAMS);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(out.error).toBeUndefined();
      expect(out.leads.map((l) => l.name)).toEqual(["Jane"]);
      expect(out.provider).toBe("apollo");
    } finally {
      delete process.env.APOLLO_API_KEYS;
    }
  });

  test("fails fast on 403 without burning the next key", async () => {
    process.env.APOLLO_API_KEYS = "k-1,k-2";
    delete process.env.APOLLO_API_KEY;
    try {
      const fetchMock = stubFetchSequence([
        { ok: false, status: 403, text: "plan denied" },
      ]);
      const out = await searchLeads(PARAMS);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(out.error).toMatch(/403/);
    } finally {
      delete process.env.APOLLO_API_KEYS;
    }
  });

  test("falls back to the legacy single APOLLO_API_KEY", async () => {
    process.env.APOLLO_API_KEY = "solo";
    delete process.env.APOLLO_API_KEYS;
    try {
      const fetchMock = vi.fn().mockResolvedValue(apolloOk(["Solo Lead"]));
      vi.stubGlobal("fetch", fetchMock);
      const out = await searchLeads(PARAMS);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1].headers["X-Api-Key"]).toBe("solo");
      expect(out.leads).toHaveLength(1);
    } finally {
      delete process.env.APOLLO_API_KEY;
    }
  });
});
