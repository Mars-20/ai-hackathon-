import { describe, expect, test } from "vitest";
import { hashFingerprint, isTempMailDomain, resolveAgentGate, resolveInviteGate, resolveSaveGate, truncateIp } from "@/lib/entitlements";

describe("resolveAgentGate", () => {
  test("trial_active and subscribed and legacy allowed; consumed/paused blocked with codes", () => {
    expect(resolveAgentGate("trial_active")).toEqual({ allowed: true, code: "OK" });
    expect(resolveAgentGate("subscribed")).toEqual({ allowed: true, code: "OK" });
    expect(resolveAgentGate("legacy")).toEqual({ allowed: true, code: "OK" });
    expect(resolveAgentGate("trial_consumed")).toEqual({ allowed: false, code: "TRIAL_CONSUMED" });
    expect(resolveAgentGate("paused")).toEqual({ allowed: false, code: "ACCOUNT_PAUSED" });
    expect(resolveAgentGate(null)).toEqual({ allowed: false, code: "SUBSCRIPTION_REQUIRED" });
  });
});
describe("resolveSaveGate", () => {
  test("second new startup while trial_active consumes trial and blocks", () => {
    expect(resolveSaveGate("trial_active", true, 1)).toEqual({ allowed: false, code: "TRIAL_CONSUMED", consumeTrial: true });
    expect(resolveSaveGate("trial_active", true, 0)).toEqual({ allowed: true, code: "OK", consumeTrial: false });
    expect(resolveSaveGate("trial_active", false, 5)).toEqual({ allowed: true, code: "OK", consumeTrial: false });
    expect(resolveSaveGate("subscribed", true, 9)).toEqual({ allowed: true, code: "OK", consumeTrial: false });
  });
  test("all remaining paths assert full objects", () => {
    expect(resolveSaveGate("legacy", true, 9)).toEqual({ allowed: true, code: "OK", consumeTrial: false });
    expect(resolveSaveGate("legacy", false, 3)).toEqual({ allowed: true, code: "OK", consumeTrial: false });
    expect(resolveSaveGate("trial_consumed", true, 0)).toEqual({ allowed: false, code: "TRIAL_CONSUMED", consumeTrial: false });
    expect(resolveSaveGate("trial_consumed", false, 0)).toEqual({ allowed: false, code: "TRIAL_CONSUMED", consumeTrial: false });
    expect(resolveSaveGate("paused", true, 0)).toEqual({ allowed: false, code: "ACCOUNT_PAUSED", consumeTrial: false });
    expect(resolveSaveGate("paused", false, 0)).toEqual({ allowed: false, code: "ACCOUNT_PAUSED", consumeTrial: false });
    expect(resolveSaveGate(null, true, 0)).toEqual({ allowed: false, code: "SUBSCRIPTION_REQUIRED", consumeTrial: false });
    expect(resolveSaveGate(null, false, 0)).toEqual({ allowed: false, code: "SUBSCRIPTION_REQUIRED", consumeTrial: false });
  });
});
describe("resolveInviteGate", () => {
  test("only subscribed/legacy create and accept", () => {
    expect(resolveInviteGate("subscribed", "create")).toEqual({ allowed: true, code: "OK" });
    expect(resolveInviteGate("subscribed", "accept")).toEqual({ allowed: true, code: "OK" });
    expect(resolveInviteGate("legacy", "create")).toEqual({ allowed: true, code: "OK" });
    expect(resolveInviteGate("legacy", "accept")).toEqual({ allowed: true, code: "OK" });
    expect(resolveInviteGate("trial_active", "create")).toEqual({ allowed: false, code: "SUBSCRIPTION_REQUIRED" });
    expect(resolveInviteGate("trial_active", "accept")).toEqual({ allowed: false, code: "SUBSCRIPTION_REQUIRED" });
    expect(resolveInviteGate("trial_consumed", "create")).toEqual({ allowed: false, code: "TRIAL_CONSUMED" });
    expect(resolveInviteGate("trial_consumed", "accept")).toEqual({ allowed: false, code: "TRIAL_CONSUMED" });
    expect(resolveInviteGate("paused", "create")).toEqual({ allowed: false, code: "ACCOUNT_PAUSED" });
    expect(resolveInviteGate("paused", "accept")).toEqual({ allowed: false, code: "ACCOUNT_PAUSED" });
    expect(resolveInviteGate(null, "create")).toEqual({ allowed: false, code: "SUBSCRIPTION_REQUIRED" });
    expect(resolveInviteGate(null, "accept")).toEqual({ allowed: false, code: "SUBSCRIPTION_REQUIRED" });
  });
});
describe("truncateIp", () => {
  test("ipv4 /24, ipv6 /48, mapped-ipv4 treated as ipv4", () => {
    expect(truncateIp("1.2.3.4")).toBe("1.2.3");
    expect(truncateIp("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe("2001:0db8:85a3:0000");
    expect(truncateIp("::ffff:1.2.3.4")).toBe("1.2.3");
    expect(truncateIp("unknown")).toBe("unknown");
  });
  test("uppercase mapped prefix treated as ipv4", () => {
    expect(truncateIp("::FFFF:1.2.3.4")).toBe("1.2.3");
  });
  test("compressed and full-form ipv6 group identically", () => {
    const full = truncateIp("2001:0db8:0000:0000:0000:0000:0000:0001");
    expect(full).toBe("2001:0db8:0000:0000");
    expect(truncateIp("2001:db8::1")).toBe(full);
    const fe80Full = truncateIp("fe80:0000:0000:0000:0000:0000:0000:0001");
    expect(fe80Full).toBe("fe80:0000:0000:0000");
    expect(truncateIp("fe80::1")).toBe(fe80Full);
    expect(truncateIp("::")).toBe("0000:0000:0000:0000");
    // Case-insensitive grouping: upper- and lower-case compressions match.
    expect(truncateIp("2001:DB8::1")).toBe(full);
  });
});
describe("hashFingerprint", () => {
  test("stable 64-hex sha256 of canonical signals", () => {
    const s = { ua: "a", screen: "b", tz: "c", lang: "d" };
    expect(hashFingerprint(s)).toBe(hashFingerprint(s));
    expect(hashFingerprint(s)).toMatch(/^[0-9a-f]{64}$/);
  });
  test("pins known sha256 vector for ua|screen|tz|lang with pipe separator", () => {
    expect(hashFingerprint({ ua: "a", screen: "b", tz: "c", lang: "d" })).toBe(
      "b54856b7a8705958e13238b3d67eac1cf256afefd4ad405d644ac956b1164870",
    );
  });
  test("field order matters", () => {
    expect(hashFingerprint({ ua: "d", screen: "c", tz: "b", lang: "a" })).not.toBe(
      hashFingerprint({ ua: "a", screen: "b", tz: "c", lang: "d" }),
    );
  });
});
describe("isTempMailDomain", () => {
  test("exact match on a known domain", () => {
    expect(isTempMailDomain("mailinator.com")).toBe(true);
  });
  test("subdomain of a known domain matches", () => {
    expect(isTempMailDomain("sub.yopmail.com")).toBe(true);
  });
  test("non-matching domains are rejected, including suffix lookalikes", () => {
    expect(isTempMailDomain("gmail.com")).toBe(false);
    expect(isTempMailDomain("notmailinator.com")).toBe(false);
    expect(isTempMailDomain("")).toBe(false);
  });
  test("matching is case-insensitive and trims whitespace", () => {
    expect(isTempMailDomain("Mailinator.COM")).toBe(true);
    expect(isTempMailDomain("  sub.yopmail.com ")).toBe(true);
    expect(isTempMailDomain("  SUB.GuerrillaMail.COM  ")).toBe(true);
  });
  test("extra comma-separated list is honored", () => {
    expect(isTempMailDomain("custom.test", "custom.test")).toBe(true);
    expect(isTempMailDomain("Custom.Test", "  custom.test , other.io ")).toBe(true);
    expect(isTempMailDomain("sub.custom.test", "custom.test")).toBe(true);
    expect(isTempMailDomain("other.io", "custom.test")).toBe(false);
    expect(isTempMailDomain("gmail.com", "custom.test")).toBe(false);
  });
});
