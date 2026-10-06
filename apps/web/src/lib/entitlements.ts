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
const IPV4_KEPT_OCTETS = 3;
const IPV6_KEPT_GROUPS = 4;
const IPV6_TOTAL_GROUPS = 8;

/**
 * Expand an IPv6 address into its 8 normalized hextet groups
 * (lowercase, zero-padded to 4 chars) so compressed (`::`) and full forms
 * truncate identically. Returns null when the input is not parseable as
 * pure IPv6 (embedded IPv4, zone ids, bad groups) — the caller then
 * returns the input as-is.
 */
function expandIpv6Groups(ip: string): string[] | null {
  if (ip.includes(".") || ip.includes("%")) {
    return null;
  }
  const normalize = (g: string): string | null =>
    /^[0-9a-fA-F]{1,4}$/.test(g) ? g.toLowerCase().padStart(4, "0") : null;
  if (ip.includes("::")) {
    if (ip.indexOf("::") !== ip.lastIndexOf("::")) {
      return null;
    }
    const parts = ip.split("::");
    if (parts.length !== 2) {
      return null;
    }
    const [headRaw, tailRaw] = parts;
    const head = headRaw === "" ? [] : headRaw.split(":");
    const tail = tailRaw === "" ? [] : tailRaw.split(":");
    const normalizedHead: string[] = [];
    for (const g of head) {
      const n = normalize(g);
      if (n === null) {
        return null;
      }
      normalizedHead.push(n);
    }
    const normalizedTail: string[] = [];
    for (const g of tail) {
      const n = normalize(g);
      if (n === null) {
        return null;
      }
      normalizedTail.push(n);
    }
    const missing = IPV6_TOTAL_GROUPS - normalizedHead.length - normalizedTail.length;
    if (missing < 1) {
      return null;
    }
    return [...normalizedHead, ...Array<string>(missing).fill("0000"), ...normalizedTail];
  }
  const parts = ip.split(":");
  if (parts.length !== IPV6_TOTAL_GROUPS) {
    return null;
  }
  const normalized: string[] = [];
  for (const g of parts) {
    const n = normalize(g);
    if (n === null) {
      return null;
    }
    normalized.push(n);
  }
  return normalized;
}

/**
 * Truncate an IP address for privacy-preserving storage.
 *
 * Plain IPv4 (or IPv4-mapped IPv6 `::ffff:a.b.c.d`) → first 3 octets
 * (/24). Any other IPv6 value → first 4 hextets (/48), expanding
 * compressed `::` first so compressed and full forms group identically.
 * Anything else is returned as-is.
 */
export function truncateIp(ip: string): string {
  const mapped = ip.toLowerCase().startsWith(IPV4_MAPPED_PREFIX)
    ? ip.slice(IPV4_MAPPED_PREFIX.length)
    : null;
  if (mapped !== null) {
    return IPV4_PATTERN.test(mapped) ? mapped.split(".").slice(0, IPV4_KEPT_OCTETS).join(".") : ip;
  }
  if (IPV4_PATTERN.test(ip)) {
    return ip.split(".").slice(0, IPV4_KEPT_OCTETS).join(".");
  }
  if (ip.includes(":")) {
    const groups = expandIpv6Groups(ip);
    if (groups === null) {
      return ip;
    }
    return groups.slice(0, IPV6_KEPT_GROUPS).join(":");
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
