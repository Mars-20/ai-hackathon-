import { describe, expect, test } from "vitest";
import { hashFingerprint, resolveAgentGate, resolveInviteGate, resolveSaveGate, truncateIp } from "@/lib/entitlements";

describe("resolveAgentGate", () => {
  test("trial_active and subscribed and legacy allowed; consumed/paused blocked with codes", () => {
    expect(resolveAgentGate("trial_active")).toEqual({ allowed: true, code: "OK" });
    expect(resolveAgentGate("subscribed").allowed).toBe(true);
    expect(resolveAgentGate("legacy").allowed).toBe(true);
    expect(resolveAgentGate("trial_consumed")).toEqual({ allowed: false, code: "TRIAL_CONSUMED" });
    expect(resolveAgentGate("paused")).toEqual({ allowed: false, code: "ACCOUNT_PAUSED" });
    expect(resolveAgentGate(null)).toEqual({ allowed: false, code: "SUBSCRIPTION_REQUIRED" });
  });
});
describe("resolveSaveGate", () => {
  test("second new startup while trial_active consumes trial and blocks", () => {
    expect(resolveSaveGate("trial_active", true, 1)).toEqual({ allowed: false, code: "TRIAL_CONSUMED", consumeTrial: true });
    expect(resolveSaveGate("trial_active", true, 0).allowed).toBe(true);
    expect(resolveSaveGate("trial_active", false, 5).allowed).toBe(true);
    expect(resolveSaveGate("subscribed", true, 9).allowed).toBe(true);
  });
});
describe("resolveInviteGate", () => {
  test("only subscribed/legacy create and accept", () => {
    expect(resolveInviteGate("subscribed", "create").allowed).toBe(true);
    expect(resolveInviteGate("legacy", "accept").allowed).toBe(true);
    expect(resolveInviteGate("trial_active", "accept").allowed).toBe(false);
    expect(resolveInviteGate("trial_consumed", "create").allowed).toBe(false);
  });
});
describe("truncateIp", () => {
  test("ipv4 /24, ipv6 /48, mapped-ipv4 treated as ipv4", () => {
    expect(truncateIp("1.2.3.4")).toBe("1.2.3");
    expect(truncateIp("2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe("2001:0db8:85a3:0000");
    expect(truncateIp("::ffff:1.2.3.4")).toBe("1.2.3");
    expect(truncateIp("unknown")).toBe("unknown");
  });
});
describe("hashFingerprint", () => {
  test("stable 64-hex sha256 of canonical signals", () => {
    const s = { ua: "a", screen: "b", tz: "c", lang: "d" };
    expect(hashFingerprint(s)).toBe(hashFingerprint(s));
    expect(hashFingerprint(s)).toMatch(/^[0-9a-f]{64}$/);
  });
});
