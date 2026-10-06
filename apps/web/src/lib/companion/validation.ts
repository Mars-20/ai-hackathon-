import { z } from "zod";

// Zod mirrors of the DB CHECKs in 0011a (kind/value) + RPC action domain.
// Routes reference these; they do NOT duplicate them.

export const memoryKindSchema = z.enum(["fact", "preference", "style", "episode"]);

export const memoryValueSchema = z.string().min(1).max(500);

export const memoryIdSchema = z.string().uuid();

export const decideActionSchema = z.enum(["approve", "reject"]);

export const statusFilterSchema = z.enum(["pending", "approved", "rejected", "all"]);

export const memoryStartupIdSchema = z.string().uuid().nullish();

// Pagination cursor (review debt — PostgREST `.or()` interpolation): the
// cursor is interpolated RAW into a filter expression, so the DAL validates
// it at entry instead of trusting the HTTP boundary alone (defense in depth
// for future direct callers). created_at must be a parseable timestamp AND
// free of PostgREST filter metacharacters (, and parens); id must be a UUID.
export const memoryCursorSchema = z.object({
  created_at: z
    .string()
    .min(1)
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: "bad created_at" })
    .refine((s) => !/[,()]/.test(s), { message: "filter metacharacters" }),
  id: memoryIdSchema,
});

export type MemoryKindInput = z.infer<typeof memoryKindSchema>;
export type DecideActionInput = z.infer<typeof decideActionSchema>;
export type StatusFilterInput = z.infer<typeof statusFilterSchema>;
