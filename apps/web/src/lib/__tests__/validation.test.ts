import { describe, test, expect } from "vitest";
import { inviteSchema, startupSaveSchema } from "@/lib/validation";

describe("inviteSchema", () => {
  test("rejects invalid role with 400-shaped issues", () => {
    const r = inviteSchema.safeParse({
      workspace_id: "550e8400-e29b-41d4-a716-446655440000",
      email: "a@b.co",
      role: "superadmin",
    });
    expect(r.success).toBe(false);
  });
  test("rejects bad email", () => {
    const r = inviteSchema.safeParse({
      workspace_id: "550e8400-e29b-41d4-a716-446655440000",
      email: "not-email",
      role: "member",
    });
    expect(r.success).toBe(false);
  });
  test("accepts valid invite", () => {
    const r = inviteSchema.safeParse({
      workspace_id: "550e8400-e29b-41d4-a716-446655440000",
      email: "user@example.com",
      role: "member",
    });
    expect(r.success).toBe(true);
  });
  test("startup rejects bad stage", () => {
    const r = startupSaveSchema.safeParse({ name: "X", stage: "foobar" });
    expect(r.success).toBe(false);
  });
});
