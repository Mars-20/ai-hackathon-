import { describe, expect, test } from "vitest";

import { getGeminiKeys, getGroqKeys, isQuotaError } from "../provider-keys";

describe("getGeminiKeys", () => {
  test("parses comma-separated GEMINI_API_KEYS, trimming whitespace and empties", () => {
    expect(getGeminiKeys({ GEMINI_API_KEYS: "  key-a ,,key-b,  key-c " })).toEqual([
      "key-a",
      "key-b",
      "key-c",
    ]);
  });

  test("falls back to the legacy single GEMINI_API_KEY", () => {
    expect(getGeminiKeys({ GEMINI_API_KEY: " solo " })).toEqual(["solo"]);
  });

  test("multi-key list wins over the single key", () => {
    expect(
      getGeminiKeys({ GEMINI_API_KEYS: "a,b", GEMINI_API_KEY: "solo" })
    ).toEqual(["a", "b"]);
  });

  test("returns empty when nothing is configured", () => {
    expect(getGeminiKeys({})).toEqual([]);
  });
});

describe("getGroqKeys", () => {
  test("parses comma-separated GROQ_API_KEYS, trimming whitespace and empties", () => {
    expect(getGroqKeys({ GROQ_API_KEYS: " g1 ,,g2 , g3 " })).toEqual(["g1", "g2", "g3"]);
  });

  test("falls back to the legacy single GROQ_API_KEY", () => {
    expect(getGroqKeys({ GROQ_API_KEY: " solo " })).toEqual(["solo"]);
  });

  test("multi-key list wins over the single key", () => {
    expect(getGroqKeys({ GROQ_API_KEYS: "a,b", GROQ_API_KEY: "solo" })).toEqual([
      "a",
      "b",
    ]);
  });

  test("returns empty when nothing is configured", () => {
    expect(getGroqKeys({})).toEqual([]);
  });
});

describe("isQuotaError", () => {
  test("429 Too Many Requests rotates", () => {
    expect(
      isQuotaError(new Error("[429 Too Many Requests] You exceeded your current quota"))
    ).toBe(true);
  });

  test("quota-exceeded wording rotates", () => {
    expect(isQuotaError(new Error("Quota exceeded for quota metric"))).toBe(true);
  });

  test("404 retired model does NOT rotate (fail fast)", () => {
    expect(
      isQuotaError(new Error("[404 Not Found] This model is no longer available to new users"))
    ).toBe(false);
  });

  test("503 capacity does NOT rotate (fail fast to Groq)", () => {
    expect(isQuotaError(new Error("[503] high demand"))).toBe(false);
  });
});
