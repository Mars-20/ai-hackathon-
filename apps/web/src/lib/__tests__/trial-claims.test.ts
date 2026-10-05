import { beforeEach, afterEach, describe, expect, test } from "vitest";
import {
  evaluateTrialStart,
  type ClaimsDb,
} from "@/lib/trial-claims";

const FP = { ua: "ua-1", screen: "1920x1080", tz: "Asia/Riyadh", lang: "ar" };

function makeDb(count: number, fpFound: boolean): ClaimsDb & {
  countCalls: Array<{ ipTrunc: string; sinceIso: string }>;
  fpCalls: Array<{ fpHash: string; userId: string }>;
  inserts: number;
} {
  const db = {
    countCalls: [] as Array<{ ipTrunc: string; sinceIso: string }>,
    fpCalls: [] as Array<{ fpHash: string; userId: string }>,
    inserts: 0,
    async countRecentClaims(ipTrunc: string, sinceIso: string): Promise<number> {
      db.countCalls.push({ ipTrunc, sinceIso });
      return count;
    },
    async findConsumedByFp(fpHash: string, userId: string): Promise<boolean> {
      db.fpCalls.push({ fpHash, userId });
      void userId;
      return fpFound;
    },
    async insertClaim(): Promise<void> {
      db.inserts += 1;
    },
  };
  return db;
}

const ENV_KEYS = ["TRIAL_MAX_PER_IP", "TRIAL_IP_WINDOW_DAYS", "TEMP_MAIL_EXTRA_DOMAINS"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = savedEnv[k];
    }
  }
});

describe("evaluateTrialStart", () => {
  test("unverified email blocked before any db abuse lookup", async () => {
    const db = makeDb(0, false);
    const res = await evaluateTrialStart({
      userId: "u-1",
      email: "user@example.com",
      emailConfirmedAt: null,
      ip: "1.2.3.4",
      fpSignals: FP,
      db,
    });
    expect(res.allowed).toBe(false);
    expect(res.code).toBe("TRIAL_NOT_ALLOWED");
    expect(res.reason).toBe("فعّل بريدك أولًا");
    expect(db.countCalls).toHaveLength(0);
    expect(db.fpCalls).toHaveLength(0);
  });

  test("temp-mail domain blocked and flagged", async () => {
    const db = makeDb(0, false);
    const res = await evaluateTrialStart({
      userId: "u-2",
      email: "user@mailinator.com",
      emailConfirmedAt: "2026-01-01T00:00:00.000Z",
      ip: "1.2.3.4",
      fpSignals: FP,
      db,
    });
    expect(res.allowed).toBe(false);
    expect(res.code).toBe("TRIAL_NOT_ALLOWED");
    expect(res.claim.is_temp_mail).toBe(true);
    expect(res.claim.email_domain).toBe("mailinator.com");
    expect(db.countCalls).toHaveLength(0);
  });

  test("3rd claim same IP allowed, 4th blocked", async () => {
    const third = await evaluateTrialStart({
      userId: "u-3",
      email: "clean@example.com",
      emailConfirmedAt: "2026-01-01T00:00:00.000Z",
      ip: "9.9.9.9",
      fpSignals: FP,
      db: makeDb(2, false),
      maxPerIp: 3,
      windowDays: 30,
    });
    expect(third.allowed).toBe(true);
    expect(third.code).toBe("OK");

    const fourth = await evaluateTrialStart({
      userId: "u-4",
      email: "clean@example.com",
      emailConfirmedAt: "2026-01-01T00:00:00.000Z",
      ip: "9.9.9.9",
      fpSignals: FP,
      db: makeDb(3, false),
      maxPerIp: 3,
      windowDays: 30,
    });
    expect(fourth.allowed).toBe(false);
    expect(fourth.code).toBe("TRIAL_NOT_ALLOWED");
    expect(fourth.reason).toBe("الحد الأقصى للتجارب من هذه الشبكة");
  });

  test("duplicate fingerprint allowed but flagged", async () => {
    const db = makeDb(0, true);
    const res = await evaluateTrialStart({
      userId: "u-new",
      email: "clean@example.com",
      emailConfirmedAt: "2026-01-01T00:00:00.000Z",
      ip: "5.6.7.8",
      fpSignals: FP,
      db,
    });
    expect(res.allowed).toBe(true);
    expect(res.code).toBe("OK");
    expect(res.claim.suspected_duplicate).toBe(true);
    expect(res.claim.is_temp_mail).toBe(false);
  });

  test("clean user allowed unflagged", async () => {
    const res = await evaluateTrialStart({
      userId: "u-clean",
      email: "Clean@Example.COM",
      emailConfirmedAt: "2026-01-01T00:00:00.000Z",
      ip: "1.2.3.4",
      fpSignals: FP,
      db: makeDb(0, false),
    });
    expect(res).toEqual({
      allowed: true,
      code: "OK",
      claim: {
        ip_trunc: "1.2.3",
        fp_hash: res.claim.fp_hash,
        email_domain: "example.com",
        is_temp_mail: false,
        suspected_duplicate: false,
      },
    });
    expect(res.claim.fp_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("junk TRIAL_MAX_PER_IP env falls back to 3", async () => {
    process.env.TRIAL_MAX_PER_IP = "abc";
    const atCap = await evaluateTrialStart({
      userId: "u-j1",
      email: "clean@example.com",
      emailConfirmedAt: "2026-01-01T00:00:00.000Z",
      ip: "7.7.7.7",
      fpSignals: FP,
      db: makeDb(3, false),
    });
    expect(atCap.allowed).toBe(false);
    expect(atCap.code).toBe("TRIAL_NOT_ALLOWED");

    const belowCap = await evaluateTrialStart({
      userId: "u-j2",
      email: "clean@example.com",
      emailConfirmedAt: "2026-01-01T00:00:00.000Z",
      ip: "7.7.7.7",
      fpSignals: FP,
      db: makeDb(2, false),
    });
    expect(belowCap.allowed).toBe(true);
    expect(belowCap.code).toBe("OK");
  });

  test("missing @ never throws and never matches blocklist", async () => {
    const res = await evaluateTrialStart({
      userId: "u-noat",
      email: "not-an-email",
      emailConfirmedAt: "2026-01-01T00:00:00.000Z",
      ip: "1.2.3.4",
      fpSignals: FP,
      db: makeDb(0, false),
    });
    expect(res.allowed).toBe(true);
    expect(res.claim.email_domain).toBe("");
    expect(res.claim.is_temp_mail).toBe(false);
  });
});
