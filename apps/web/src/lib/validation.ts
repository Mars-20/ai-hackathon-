import { z } from "zod";

// NOTE: Enums below are hardcoded to mirror src/lib/types.ts (MemberRole :15,
// Stage :63, Verdict/Confidence). types.ts exports types only (no runtime
// values), so zod needs its own literal tuples here. Keep in sync manually.

export const workspaceIdSchema = z.string().uuid();

export const inviteSchema = z.object({
  workspace_id: workspaceIdSchema,
  email: z.string().email().max(254),
  role: z.enum(["owner", "admin", "member", "viewer"]),
});

// Task 8: full invite lifecycle (accept/decline/resend/revoke) + list query.
// Kept beside inviteSchema (T1) so POST body shape stays dashboard-compatible.
export const inviteActionSchema = z.object({
  invite_id: z.string().uuid(),
  action: z.enum(["accept", "decline", "resend", "revoke"]),
});

export const inviteListQuerySchema = z.object({
  workspace_id: workspaceIdSchema,
});

export const startupSaveSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  stage: z.enum(["idea", "prototype", "live", "scaling"]).default("idea"),
  domain: z.string().max(100).optional(),
  // workspace_id stays OPTIONAL: personal startups without a workspace are
  // allowed and fall back to owner_id isolation (save route enforces
  // owner_id === auth user + membership gate when workspace_id is present).
  workspace_id: workspaceIdSchema.optional(),
});

export const searchQuerySchema = z.object({
  q: z.string().trim().min(2).max(200),
  type: z.enum(["all", "startups", "assumptions", "evidence"]).default("all"),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

export const historyVerdictSchema = z.enum(["go", "iterate", "stop", "test_more"]);
export const historyConfidenceSchema = z.enum(["low", "medium", "high"]);
export const historyStageSchema = z.enum(["idea", "prototype", "live", "scaling"]);
export const historySortSchema = z.enum(["created_at", "name", "updated_at"]);
export const historyOrderSchema = z.enum(["asc", "desc"]);

export const historyQuerySchema = z.object({
  q: z.string().trim().max(200).optional().default(""),
  verdicts: z.array(historyVerdictSchema).optional().default([]),
  stages: z.array(historyStageSchema).optional().default([]),
  confidences: z.array(historyConfidenceSchema).optional().default([]),
  sort: historySortSchema.optional().default("created_at"),
  order: historyOrderSchema.optional().default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
