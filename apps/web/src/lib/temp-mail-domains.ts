/**
 * Well-known disposable / temporary-mail domains.
 *
 * Stored lowercase. Matching (see `isTempMailDomain`) is exact-or-subdomain,
 * so `user@mailinator.com` and `user@sub.mailinator.com` both match.
 */
export const TEMP_MAIL_DOMAINS: readonly string[] = [
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "tempmail.com",
  "throwawaymail.com",
  "temp-mail.org",
  "fakeinbox.com",
  "maildrop.cc",
  "yopmail.com",
  "trashmail.com",
  "dispostable.com",
  "getnada.com",
  "moakt.com",
  "mohmal.com",
  "sharklasers.com",
  "spamgourmet.com",
  "mytrashmail.com",
  "mintemail.com",
  "mailnesia.com",
  "mailsac.com",
  "tempinbox.com",
  "filzmail.com",
  "20minutemail.com",
  "tempail.com",
  "emailondeck.com",
  "deadaddress.com",
  "incognitomail.org",
  "spambox.us",
  "binkmail.com",
  "dodgeit.com",
  "pookmail.com",
  "e4ward.com",
];

/**
 * Return true when `domain` is (or is a subdomain of) a known
 * temporary-mail domain. Comparison is case-insensitive and trims
 * surrounding whitespace. `extra` accepts additional domains as a
 * comma-separated string.
 */
export function isTempMailDomain(domain: string, extra?: string): boolean {
  const normalized = domain.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  const candidates: string[] = [...TEMP_MAIL_DOMAINS];
  if (extra !== undefined) {
    for (const part of extra.split(",")) {
      const entry = part.trim().toLowerCase();
      if (entry.length > 0) {
        candidates.push(entry);
      }
    }
  }
  return candidates.some(
    (blocked) => normalized === blocked || normalized.endsWith(`.${blocked}`),
  );
}
