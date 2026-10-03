import { describe, test, expect } from "vitest";
import { inviteSchema, startupSaveSchema, searchQuerySchema, historyQuerySchema } from "@/lib/validation";

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
  test("startup rejects invalid workspace_id uuid", () => {
    const r = startupSaveSchema.safeParse({ name: "X", workspace_id: "not-a-uuid" });
    expect(r.success).toBe(false);
  });
  test("startup allows missing workspace_id (personal fallback to owner check)", () => {
    const r = startupSaveSchema.safeParse({ name: "Personal" });
    expect(r.success).toBe(true);
  });
  test("startup trims name and rejects overlong name", () => {
    const ok = startupSaveSchema.safeParse({ name: "  X  " });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.name).toBe("X");
    const tooLong = startupSaveSchema.safeParse({ name: "a".repeat(201) });
    expect(tooLong.success).toBe(false);
  });
  test("searchQuerySchema whitelists plural type enum and defaults limit 5", () => {
    const bad = searchQuerySchema.safeParse({ q: "test", type: "startup" });
    expect(bad.success).toBe(false);
    const ok = searchQuerySchema.safeParse({ q: "test", type: "startups" });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.type).toBe("startups");
      expect(ok.data.limit).toBe(5);
    }
    const short = searchQuerySchema.safeParse({ q: "x" });
    expect(short.success).toBe(false);
  });
});

describe("historyQuerySchema from/to", () => {
  test("rejects non-date from/to with 400-shaped failure", () => {
    expect(historyQuerySchema.safeParse({ from: "not-a-date" }).success).toBe(false);
    expect(historyQuerySchema.safeParse({ to: "32/13/2024" }).success).toBe(false);
  });
  test("accepts empty and ISO dates", () => {
    const ok = historyQuerySchema.safeParse({ from: "2024-01-01", to: "2024-12-31T23:59:59Z" });
    expect(ok.success).toBe(true);
    const empty = historyQuerySchema.safeParse({});
    expect(empty.success).toBe(true);
  });
});
