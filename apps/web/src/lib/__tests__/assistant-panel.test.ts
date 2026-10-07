import { describe, it, expect } from "vitest";
import {
  formatThreadCapError,
  formatSseError,
  parseCitationTokens,
  THREAD_CAP,
} from "@/lib/assistant/format";

describe("formatThreadCapError", () => {
  it("names the per-thread cap and points at a new chat", () => {
    const msg = formatThreadCapError();
    expect(msg).toContain(String(THREAD_CAP));
    expect(msg).toMatch(/جديدة/i);
  });
});

describe("formatSseError", () => {
  it("maps 402 quota exhaustion to the plans upsell", () => {
    const msg = formatSseError(402, { error: "quota exhausted", plans_url: "/plans" });
    expect(msg).toMatch(/quota|الحصة/i);
    expect(msg).toContain("/plans");
  });
  it("maps 409 thread-cap to the new-chat message", () => {
    expect(formatSseError(409, { error: "cap" })).toContain(String(THREAD_CAP));
  });
  it("maps 422 secret leak to a retry hint", () => {
    expect(formatSseError(422, { error: "leak" })).toMatch(/rephrase|الصياغة/i);
  });
  it("maps 429 to a retry-after hint", () => {
    expect(formatSseError(429, { error: "slow", retryAfter: 20 })).toContain("20");
  });
  it("falls back to the server message for unknown statuses", () => {
    expect(formatSseError(500, { error: "boom" })).toContain("boom");
  });
});

describe("parseCitationTokens", () => {
  it("splits [S1]/[E2]/[W3]/[M4] markers into cite segments", () => {
    const segs = parseCitationTokens("Revenue is strong [S1] and churn fell [E2].");
    expect(segs).toEqual([
      { kind: "text", text: "Revenue is strong " },
      { kind: "cite", label: "S1" },
      { kind: "text", text: " and churn fell " },
      { kind: "cite", label: "E2" },
      { kind: "text", text: "." },
    ]);
  });
  it("ignores bracket text that is not a citation", () => {
    const segs = parseCitationTokens("Use the [draft] version (see [12]).");
    expect(segs).toEqual([{ kind: "text", text: "Use the [draft] version (see [12])." }]);
  });
  it("returns a single text segment for plain text", () => {
    expect(parseCitationTokens("hello")).toEqual([{ kind: "text", text: "hello" }]);
  });
});
