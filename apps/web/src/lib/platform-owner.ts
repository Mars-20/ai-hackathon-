// ─────────────────────────────────────────────────────────────────────────────
// Platform-owner gate — canonical PLATFORM_OWNER_EMAILS env contract.
// (Moved verbatim out of app/api/admin/requests/route.ts: Next.js 15 typed
// routes reject non-route value exports from route modules, which broke
// `next build`. No behavior change.)
//
//   PLATFORM_OWNER_EMAILS="owner@example.com,second@example.com"
// Comma-separated emails, case-insensitive compare. EMPTY pre-launch → the
// owner list is [] → every caller gets the stable 403
// {"error":"محظور","code":"FORBIDDEN"}.
// ─────────────────────────────────────────────────────────────────────────────

export function getPlatformOwnerEmails(): string[] {
  const raw = process.env.PLATFORM_OWNER_EMAILS ?? "";
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

export function isPlatformOwnerEmail(
  email: string | null | undefined,
): boolean {
  if (!email) return false;
  return getPlatformOwnerEmails().includes(email.trim().toLowerCase());
}
