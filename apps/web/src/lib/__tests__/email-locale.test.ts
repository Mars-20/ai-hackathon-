// apps/web/src/lib/__tests__/email-locale.test.ts
import { describe, it, expect } from "vitest";
import { getEmailSubject } from "@/lib/email";

describe("email locale", () => {
  it("returns Arabic subject for ar", () => {
    expect(getEmailSubject("welcome", "ar")).toBe("أهلاً بيك في مساعد التحقق");
  });
  it("returns English subject for en", () => {
    expect(getEmailSubject("welcome", "en")).toBe("Welcome to Validation Copilot");
  });
});
