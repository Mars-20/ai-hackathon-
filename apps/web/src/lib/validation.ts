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
// Task 8 R1: inviteIdSchema shared with the route DELETE query-param check.
export const inviteIdSchema = z.string().uuid();

export const inviteActionSchema = z.object({
  invite_id: inviteIdSchema,
  action: z.enum(["accept", "decline", "resend", "revoke"]),
});

export const inviteListQuerySchema = z.object({
  workspace_id: workspaceIdSchema,
});

export const startupSaveSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  // Track-aware: any non-empty stage string passes the shape check; the
  // route validates membership against the project's track order (400
  // INVALID when out-of-track). Legacy rows keep working unchanged.
  stage: z.string().trim().min(1).max(100).default("idea"),
  track: z.string().trim().min(1).max(60).optional(),
  domain: z.string().max(100).optional(),
  // workspace_id stays OPTIONAL: personal startups without a workspace are
  // allowed and fall back to owner_id isolation (save route enforces
  // owner_id === auth user + membership gate when workspace_id is present).
  workspace_id: workspaceIdSchema.optional(),
});

// Task 7: intake two-pass — extract + ask <=3 clarifying_questions (never
// guess). Capped at 3 so the golden path stays bounded.
export const intakeSchema = z.object({
  clarifying_questions: z.array(z.string().trim().min(1).max(300)).max(3).default([]),
});

export const searchQuerySchema = z.object({
  q: z.string().trim().min(2).max(200),
  type: z.enum(["all", "startups", "assumptions", "evidence"]).default("all"),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

export const historyVerdictSchema = z.enum(["go", "iterate", "stop", "test_more"]);
export const historyConfidenceSchema = z.enum(["low", "medium", "high"]);
export const historyStageSchema = z.string().trim().min(1).max(100);
export const historySortSchema = z.enum(["created_at", "name", "updated_at"]);
export const historyOrderSchema = z.enum(["asc", "desc"]);

// ISO date string ("" = absent): invalid dates are rejected with 400 rather
// than passed raw to PostgREST range filters.
export const isoDateStringSchema = z
  .string()
  .trim()
  .refine((s) => s === "" || !Number.isNaN(Date.parse(s)), {
    message: "Invalid ISO date string",
  })
  .optional()
  .default("");

// Task 6: subscription request + device-fingerprint signals (additive).
// subscriptionRequestSchema is consumed by POST /api/subscription-requests;
// fpSignalsSchema carries Task 4 trial-abuse signals (never blocks, additive).
export const subscriptionRequestSchema = z.object({
  plan: z.enum(["pro", "team"]),
  full_name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(6).max(32),
  company: z.string().trim().max(160).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const fpSignalsSchema = z.object({
  ua: z.string().max(500).default(""),
  screen: z.string().max(100).default(""),
  tz: z.string().max(100).default(""),
  lang: z.string().max(50).default(""),
});

export const historyQuerySchema = z.object({
  q: z.string().trim().max(200).optional().default(""),
  verdicts: z.array(historyVerdictSchema).optional().default([]),
  stages: z.array(historyStageSchema).optional().default([]),
  confidences: z.array(historyConfidenceSchema).optional().default([]),
  sort: historySortSchema.optional().default("created_at"),
  order: historyOrderSchema.optional().default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  from: isoDateStringSchema,
  to: isoDateStringSchema,
});
