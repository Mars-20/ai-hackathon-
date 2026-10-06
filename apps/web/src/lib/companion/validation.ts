import { z } from "zod";

// Zod mirrors of the DB CHECKs in 0011a (kind/value) + RPC action domain.
// Routes reference these; they do NOT duplicate them.

export const memoryKindSchema = z.enum(["fact", "preference", "style", "episode"]);

export const memoryValueSchema = z.string().min(1).max(500);

export const memoryIdSchema = z.string().uuid();

export const decideActionSchema = z.enum(["approve", "reject"]);

export const statusFilterSchema = z.enum(["pending", "approved", "rejected", "all"]);

export const memoryStartupIdSchema = z.string().uuid().nullish();

export type MemoryKindInput = z.infer<typeof memoryKindSchema>;
export type DecideActionInput = z.infer<typeof decideActionSchema>;
export type StatusFilterInput = z.infer<typeof statusFilterSchema>;
