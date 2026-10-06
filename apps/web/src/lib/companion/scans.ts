// Write-time safety scans (Task 3, zero I/O). Every secret pattern is
// documented inline; PII checks run AFTER the self-contact allowlist pass.

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Stripe-style live restricted keys: "sk-live-" + ≥6 secret chars.
  { name: "stripe-sk-live", re: /sk-live-[A-Za-z0-9]{6,}/ },
  // AWS access key ID: "AKIA" + 16 uppercase alphanumerics.
  { name: "aws-access-key-id", re: /AKIA[0-9A-Z]{16}/ },
  // Slack bot token: "xoxb-" + token body (digits/dashes/letters).
  { name: "slack-bot-token", re: /xoxb-[0-9A-Za-z-]{8,}/ },
  // GitHub classic PAT: "ghp_" + 36 secret chars.
  { name: "github-pat", re: /ghp_[A-Za-z0-9]{36}/ },
  // Bare card-shaped run: 16 contiguous digits.
  { name: "card-pan-run", re: /\d{16}/ },
  // PEM private-key block header (RSA/EC/DSA/OPENSSH/plain).
  { name: "pem-private-key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
];

export function containsBlockedSecret(value: string): boolean {
  return SECRET_PATTERNS.some((p) => p.re.test(value));
}

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_RE = /\+?\d[\d\s-]{6,}\d/; // E.164-ish: ≥8-char digit run
const NATIONAL_ID_RE = /\d{10,14}/; // national-ID-shaped digit runs

export function containsThirdPartyPii(value: string, allowedContacts: string[]): boolean {
  // Self-contact allowlist: the user's OWN email/phone may appear (profile
  // facts like "my email is …"). Strip every occurrence before scanning.
  let rest = value;
  for (const contact of allowedContacts) {
    if (contact.length > 0) rest = rest.split(contact).join("");
  }
  return EMAIL_RE.test(rest) || PHONE_RE.test(rest) || NATIONAL_ID_RE.test(rest);
}
