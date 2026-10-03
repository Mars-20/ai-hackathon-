import { z } from "zod";

export const workspaceIdSchema = z.string().uuid();

export const inviteSchema = z.object({
  workspace_id: workspaceIdSchema,
  email: z.string().email().max(254),
  role: z.enum(["owner", "admin", "member", "viewer"]),
});

export const startupSaveSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  stage: z.enum(["idea", "prototype", "live", "scaling"]).default("idea"),
  domain: z.string().max(100).optional(),
  workspace_id: workspaceIdSchema.optional(),
});

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  type: z.enum(["all", "startup", "assumption", "evidence"]).default("all"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
