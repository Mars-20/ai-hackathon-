import { createHash } from "node:crypto";
import { isTempMailDomain } from "@/lib/temp-mail-domains";

export { isTempMailDomain };

export type EntitlementStatus =
  | "trial_active"
  | "trial_consumed"
  | "subscribed"
  | "paused"
  | "legacy";

export type AgentGateCode =
  | "OK"
  | "TRIAL_CONSUMED"
  | "SUBSCRIPTION_REQUIRED"
  | "ACCOUNT_PAUSED";

export interface AgentGateResult {
  allowed: boolean;
  code: AgentGateCode;
}

export interface SaveGateResult {
  allowed: boolean;
  code: string;
  consumeTrial: boolean;
}

export interface InviteGateResult {
  allowed: boolean;
  code: string;
}

export interface FingerprintSignals {
  ua: string;
  screen: string;
  tz: string;
  lang: string;
}

/**
 * Gate for agent (analysis) runs.
 *
 * trial_active / subscribed / legacy are allowed; every other state is
 * denied with a machine-readable code the UI can act on.
 */
export function resolveAgentGate(status: EntitlementStatus | null): AgentGateResult {
  if (status === "trial_active" || status === "subscribed" || status === "legacy") {
    return { allowed: true, code: "OK" };
  }
  if (status === "trial_consumed") {
    return { allowed: false, code: "TRIAL_CONSUMED" };
  }
  if (status === "paused") {
    return { allowed: false, code: "ACCOUNT_PAUSED" };
  }
  return { allowed: false, code: "SUBSCRIPTION_REQUIRED" };
}

/**
 * Gate for saving (creating/updating) a startup.
 *
 * A trial covers exactly one startup: the second *new* save while
 * `trial_active` is denied and flags `consumeTrial` so the caller can
 * mark the trial consumed. Updates (`isNewStartup === false`) never
 * consume the trial — frozen-row enforcement lives in the route layer.
 * Paid / legacy states always pass; consumed, paused, and unknown states
 * are denied.
 */
export function resolveSaveGate(
  status: EntitlementStatus | null,
  isNewStartup: boolean,
  existingCount: number,
): SaveGateResult {
  if (status === "subscribed" || status === "legacy") {
    return { allowed: true, code: "OK", consumeTrial: false };
  }
  if (status === "trial_active") {
    if (isNewStartup && existingCount >= 1) {
      return { allowed: false, code: "TRIAL_CONSUMED", consumeTrial: true };
    }
    return { allowed: true, code: "OK", consumeTrial: false };
  }
  if (status === "trial_consumed") {
    return { allowed: false, code: "TRIAL_CONSUMED", consumeTrial: false };
  }
  if (status === "paused") {
    return { allowed: false, code: "ACCOUNT_PAUSED", consumeTrial: false };
  }
  return { allowed: false, code: "SUBSCRIPTION_REQUIRED", consumeTrial: false };
}

/**
 * Gate for workspace invites. Only paying (`subscribed`) or grandfathered
 * (`legacy`) accounts may create or accept invites.
 */
export function resolveInviteGate(
  status: EntitlementStatus | null,
  action: "create" | "accept",
): InviteGateResult {
  void action;
  if (status === "subscribed" || status === "legacy") {
    return { allowed: true, code: "OK" };
  }
  if (status === "trial_consumed") {
    return { allowed: false, code: "TRIAL_CONSUMED" };
  }
  if (status === "paused") {
    return { allowed: false, code: "ACCOUNT_PAUSED" };
  }
  return { allowed: false, code: "SUBSCRIPTION_REQUIRED" };
}

const IPV4_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const IPV4_MAPPED_PREFIX = "::ffff:";

/**
 * Truncate an IP address for privacy-preserving storage.
 *
 * Plain IPv4 (or IPv4-mapped IPv6 `::ffff:a.b.c.d`) → first 3 octets
 * (/24). Any other IPv6 value → first 4 hextets (/48). Anything else is
 * returned as-is.
 */
export function truncateIp(ip: string): string {
  const mapped = ip.toLowerCase().startsWith(IPV4_MAPPED_PREFIX)
    ? ip.slice(IPV4_MAPPED_PREFIX.length)
    : null;
  if (mapped !== null) {
    return IPV4_PATTERN.test(mapped) ? mapped.split(".").slice(0, 3).join(".") : ip;
  }
  if (IPV4_PATTERN.test(ip)) {
    return ip.split(".").slice(0, 3).join(".");
  }
  if (ip.includes(":")) {
    return ip.split(":").slice(0, 4).join(":");
  }
  return ip;
}

/**
 * Stable SHA-256 hex digest of the canonical `ua|screen|tz|lang` signal
 * string, used for trial-abuse device fingerprinting.
 */
export function hashFingerprint(signals: FingerprintSignals): string {
  const canonical = `${signals.ua}|${signals.screen}|${signals.tz}|${signals.lang}`;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export { TEMP_MAIL_DOMAINS } from "@/lib/temp-mail-domains";
