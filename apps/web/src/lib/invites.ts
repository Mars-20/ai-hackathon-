import { createHash } from "node:crypto";

// Task 8: invite lifecycle shared constants/helpers (kept out of the
// route module — Next.js route type-checks reject non-handler exports).

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function hashInviteToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
