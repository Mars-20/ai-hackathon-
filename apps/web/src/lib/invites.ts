import { createHash } from "node:crypto";

// Task 8: invite lifecycle shared constants/helpers (kept out of the
// route module — Next.js route type-checks reject non-handler exports).
// Task 8 R1: hash-only tokens — the raw token is never persisted (DB
// `token` column stays NULL for new rows); only the sha256 hex below is
// stored. Invite lookup is BY ID + auth-email match, never by token.

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function hashInviteToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

// Shared expiry predicate (pending rows past expires_at count as expired).
// Used by the invite route for every mutation gate.
export function isInviteExpired(invite: { status: string; expires_at: string }): boolean {
  return (
    invite.status === "expired" ||
    (invite.status === "pending" && new Date(invite.expires_at).getTime() <= Date.now())
  );
}
