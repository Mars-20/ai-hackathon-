import { describe, expect, it } from "vitest";
import { assistantClosedResponse, isAssistantOpen } from "@/lib/assistant/gate";

describe("isAssistantOpen", () => {
  it("closed unless explicitly 'true'", () => {
    expect(isAssistantOpen({})).toBe(false);
    expect(isAssistantOpen({ ASSISTANT_OPEN_CHAT: "" })).toBe(false);
    expect(isAssistantOpen({ ASSISTANT_OPEN_CHAT: "false" })).toBe(false);
    expect(isAssistantOpen({ ASSISTANT_OPEN_CHAT: "1" })).toBe(false);
    expect(isAssistantOpen({ ASSISTANT_OPEN_CHAT: "true" })).toBe(true);
  });
});

describe("assistantClosedResponse", () => {
  it("is a 404 NOT_FOUND (existence-hiding)", async () => {
    const res = assistantClosedResponse();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found", code: "NOT_FOUND" });
  });
});
