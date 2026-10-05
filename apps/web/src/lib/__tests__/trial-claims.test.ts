import { beforeEach, afterEach, describe, expect, test } from "vitest";
import {
  evaluateTrialStart,
  type ClaimsDb,
} from "@/lib/trial-claims";
import { hashFingerprint } from "@/lib/entitlements";

const FP = { ua: "ua-1", screen: "1920x1080", tz: "Asia/Riyadh", lang: "ar" };
const EXPECTED_FP = hashFingerprint(FP);
const MS_PER_DAY = 86_400_000;

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
    expect(res).toEqual({
      allowed: false,
      code: "TRIAL_NOT_ALLOWED",
      reason: "فعّل بريدك أولًا",
      claim: {
        ip_trunc: "1.2.3",
        fp_hash: EXPECTED_FP,
        email_domain: "example.com",
        is_temp_mail: false,
        suspected_duplicate: false,
      },
    });
    expect(res.claim.fp_hash).toMatch(/^[0-9a-f]{64}$/);
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
    expect(res).toEqual({
      allowed: false,
      code: "TRIAL_NOT_ALLOWED",
      reason: "البريد المؤقت غير مسموح به للتجربة",
      claim: {
        ip_trunc: "1.2.3",
        fp_hash: EXPECTED_FP,
        email_domain: "mailinator.com",
        is_temp_mail: true,
        suspected_duplicate: false,
      },
    });
    expect(res.claim.fp_hash).toMatch(/^[0-9a-f]{64}$/);
    // Deliberate design choice: temp-mail is a pre-DB gate that returns before
    // any abuse lookup, so the fp lookup is intentionally skipped (no
    // consumption history is needed once the domain alone decides the deny).
    expect(db.countCalls).toHaveLength(0);
    expect(db.fpCalls).toHaveLength(0);
  });

  test("3rd claim same IP allowed, 4th blocked", async () => {
    const dbThird = makeDb(2, false);
    const third = await evaluateTrialStart({
      userId: "u-3",
      email: "clean@example.com",
      emailConfirmedAt: "2026-01-01T00:00:00.000Z",
      ip: "9.9.9.9",
      fpSignals: FP,
      db: dbThird,
      maxPerIp: 3,
      windowDays: 30,
    });
    expect(third).toEqual({
      allowed: true,
      code: "OK",
      claim: {
        ip_trunc: "9.9.9",
        fp_hash: EXPECTED_FP,
        email_domain: "example.com",
        is_temp_mail: false,
        suspected_duplicate: false,
      },
    });
    expect(third.claim.fp_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(dbThird.countCalls).toHaveLength(1);
    expect(dbThird.fpCalls).toHaveLength(1);

    const dbFourth = makeDb(3, false);
    const fourth = await evaluateTrialStart({
      userId: "u-4",
      email: "clean@example.com",
      emailConfirmedAt: "2026-01-01T00:00:00.000Z",
      ip: "9.9.9.9",
      fpSignals: FP,
      db: dbFourth,
      maxPerIp: 3,
      windowDays: 30,
    });
    expect(fourth).toEqual({
      allowed: false,
      code: "TRIAL_NOT_ALLOWED",
      reason: "الحد الأقصى للتجارب من هذه الشبكة",
      claim: {
        ip_trunc: "9.9.9",
        fp_hash: EXPECTED_FP,
        email_domain: "example.com",
        is_temp_mail: false,
        suspected_duplicate: false,
      },
    });
    expect(fourth.claim.fp_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(dbFourth.countCalls).toHaveLength(1);
    expect(dbFourth.fpCalls).toHaveLength(0);
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
    expect(res).toEqual({
      allowed: true,
      code: "OK",
      claim: {
        ip_trunc: "5.6.7",
        fp_hash: EXPECTED_FP,
        email_domain: "example.com",
        is_temp_mail: false,
        suspected_duplicate: true,
      },
    });
    expect(res.claim.fp_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(db.countCalls).toHaveLength(1);
    expect(db.fpCalls).toHaveLength(1);
  });

  test("clean user allowed unflagged", async () => {
    const db = makeDb(0, false);
    const res = await evaluateTrialStart({
      userId: "u-clean",
      email: "Clean@Example.COM",
      emailConfirmedAt: "2026-01-01T00:00:00.000Z",
      ip: "1.2.3.4",
      fpSignals: FP,
      db,
    });
    expect(res).toEqual({
      allowed: true,
      code: "OK",
      claim: {
        ip_trunc: "1.2.3",
        fp_hash: EXPECTED_FP,
        email_domain: "example.com",
        is_temp_mail: false,
        suspected_duplicate: false,
      },
    });
    expect(res.claim.fp_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(db.countCalls).toHaveLength(1);
    expect(db.fpCalls).toHaveLength(1);
  });

  test.each(["", "  ", "0", "-1", "-5", "abc", "NaN"])(
    "TRIAL_MAX_PER_IP=%j fails open to default 3",
    async (raw) => {
      process.env.TRIAL_MAX_PER_IP = raw;

      const dbBelow = makeDb(2, false);
      const belowCap = await evaluateTrialStart({
        userId: "u-j-below",
        email: "clean@example.com",
        emailConfirmedAt: "2026-01-01T00:00:00.000Z",
        ip: "7.7.7.7",
        fpSignals: FP,
        db: dbBelow,
      });
      expect(belowCap).toEqual({
        allowed: true,
        code: "OK",
        claim: {
          ip_trunc: "7.7.7",
          fp_hash: EXPECTED_FP,
          email_domain: "example.com",
          is_temp_mail: false,
          suspected_duplicate: false,
        },
      });
      expect(dbBelow.countCalls).toHaveLength(1);
      expect(dbBelow.fpCalls).toHaveLength(1);

      const dbAt = makeDb(3, false);
      const atCap = await evaluateTrialStart({
        userId: "u-j-at",
        email: "clean@example.com",
        emailConfirmedAt: "2026-01-01T00:00:00.000Z",
        ip: "7.7.7.7",
        fpSignals: FP,
        db: dbAt,
      });
      expect(atCap).toEqual({
        allowed: false,
        code: "TRIAL_NOT_ALLOWED",
        reason: "الحد الأقصى للتجارب من هذه الشبكة",
        claim: {
          ip_trunc: "7.7.7",
          fp_hash: EXPECTED_FP,
          email_domain: "example.com",
          is_temp_mail: false,
          suspected_duplicate: false,
        },
      });
      expect(dbAt.countCalls).toHaveLength(1);
      expect(dbAt.fpCalls).toHaveLength(0);
    },
  );

  test.each(["", "  ", "0", "-1", "-5", "abc", "NaN"])(
    "TRIAL_IP_WINDOW_DAYS=%j fails open to default 30d window",
    async (raw) => {
      process.env.TRIAL_IP_WINDOW_DAYS = raw;
      const before = Date.now();
      const db = makeDb(0, false);
      const res = await evaluateTrialStart({
        userId: "u-w",
        email: "clean@example.com",
        emailConfirmedAt: "2026-01-01T00:00:00.000Z",
        ip: "7.7.7.7",
        fpSignals: FP,
        db,
      });
      expect(res).toEqual({
        allowed: true,
        code: "OK",
        claim: {
          ip_trunc: "7.7.7",
          fp_hash: EXPECTED_FP,
          email_domain: "example.com",
          is_temp_mail: false,
          suspected_duplicate: false,
        },
      });
      expect(db.countCalls).toHaveLength(1);
      expect(db.fpCalls).toHaveLength(1);
      const expectedSince = before - 30 * MS_PER_DAY;
      const actualSince = Date.parse(db.countCalls[0].sinceIso);
      expect(Math.abs(actualSince - expectedSince)).toBeLessThan(60_000);
    },
  );

  test.each([0, -1, -5, Number.NaN])(
    "explicit maxPerIp=%j falls back to default 3",
    async (maxPerIp) => {
      const dbBelow = makeDb(2, false);
      const belowCap = await evaluateTrialStart({
        userId: "u-e-below",
        email: "clean@example.com",
        emailConfirmedAt: "2026-01-01T00:00:00.000Z",
        ip: "7.7.7.7",
        fpSignals: FP,
        db: dbBelow,
        maxPerIp,
      });
      expect(belowCap).toEqual({
        allowed: true,
        code: "OK",
        claim: {
          ip_trunc: "7.7.7",
          fp_hash: EXPECTED_FP,
          email_domain: "example.com",
          is_temp_mail: false,
          suspected_duplicate: false,
        },
      });

      const dbAt = makeDb(3, false);
      const atCap = await evaluateTrialStart({
        userId: "u-e-at",
        email: "clean@example.com",
        emailConfirmedAt: "2026-01-01T00:00:00.000Z",
        ip: "7.7.7.7",
        fpSignals: FP,
        db: dbAt,
        maxPerIp,
      });
      expect(atCap).toEqual({
        allowed: false,
        code: "TRIAL_NOT_ALLOWED",
        reason: "الحد الأقصى للتجارب من هذه الشبكة",
        claim: {
          ip_trunc: "7.7.7",
          fp_hash: EXPECTED_FP,
          email_domain: "example.com",
          is_temp_mail: false,
          suspected_duplicate: false,
        },
      });
    },
  );

  test.each([0, -5, Number.NaN])(
    "explicit windowDays=%j falls back to default 30d window",
    async (windowDays) => {
      const before = Date.now();
      const db = makeDb(0, false);
      const res = await evaluateTrialStart({
        userId: "u-ew",
        email: "clean@example.com",
        emailConfirmedAt: "2026-01-01T00:00:00.000Z",
        ip: "7.7.7.7",
        fpSignals: FP,
        db,
        windowDays,
      });
      expect(res).toEqual({
        allowed: true,
        code: "OK",
        claim: {
          ip_trunc: "7.7.7",
          fp_hash: EXPECTED_FP,
          email_domain: "example.com",
          is_temp_mail: false,
          suspected_duplicate: false,
        },
      });
      expect(db.countCalls).toHaveLength(1);
      const expectedSince = before - 30 * MS_PER_DAY;
      const actualSince = Date.parse(db.countCalls[0].sinceIso);
      expect(Math.abs(actualSince - expectedSince)).toBeLessThan(60_000);
    },
  );

  test("precedence: unverified beats temp-mail (zero DB calls)", async () => {
    const db = makeDb(99, true);
    const res = await evaluateTrialStart({
      userId: "u-prec-1",
      email: "user@mailinator.com",
      emailConfirmedAt: null,
      ip: "1.2.3.4",
      fpSignals: FP,
      db,
    });
    expect(res).toEqual({
      allowed: false,
      code: "TRIAL_NOT_ALLOWED",
      reason: "فعّل بريدك أولًا",
      claim: {
        ip_trunc: "1.2.3",
        fp_hash: EXPECTED_FP,
        email_domain: "mailinator.com",
        is_temp_mail: true,
        suspected_duplicate: false,
      },
    });
    expect(db.countCalls).toHaveLength(0);
    expect(db.fpCalls).toHaveLength(0);
  });

  test("precedence: temp-mail beats IP cap (zero DB calls)", async () => {
    const db = makeDb(99, true);
    const res = await evaluateTrialStart({
      userId: "u-prec-2",
      email: "user@mailinator.com",
      emailConfirmedAt: "2026-01-01T00:00:00.000Z",
      ip: "9.9.9.9",
      fpSignals: FP,
      db,
      maxPerIp: 3,
      windowDays: 30,
    });
    expect(res).toEqual({
      allowed: false,
      code: "TRIAL_NOT_ALLOWED",
      reason: "البريد المؤقت غير مسموح به للتجربة",
      claim: {
        ip_trunc: "9.9.9",
        fp_hash: EXPECTED_FP,
        email_domain: "mailinator.com",
        is_temp_mail: true,
        suspected_duplicate: false,
      },
    });
    expect(db.countCalls).toHaveLength(0);
    expect(db.fpCalls).toHaveLength(0);
  });

  test("precedence: IP cap beats fp-duplicate (deny, fp lookup skipped)", async () => {
    const db = makeDb(3, true);
    const res = await evaluateTrialStart({
      userId: "u-prec-3",
      email: "clean@example.com",
      emailConfirmedAt: "2026-01-01T00:00:00.000Z",
      ip: "9.9.9.9",
      fpSignals: FP,
      db,
      maxPerIp: 3,
      windowDays: 30,
    });
    expect(res).toEqual({
      allowed: false,
      code: "TRIAL_NOT_ALLOWED",
      reason: "الحد الأقصى للتجارب من هذه الشبكة",
      claim: {
        ip_trunc: "9.9.9",
        fp_hash: EXPECTED_FP,
        email_domain: "example.com",
        is_temp_mail: false,
        suspected_duplicate: false,
      },
    });
    expect(db.countCalls).toHaveLength(1);
    expect(db.fpCalls).toHaveLength(0);
  });

  test("missing @ never throws and never matches blocklist", async () => {
    const db = makeDb(0, false);
    const res = await evaluateTrialStart({
      userId: "u-noat",
      email: "not-an-email",
      emailConfirmedAt: "2026-01-01T00:00:00.000Z",
      ip: "1.2.3.4",
      fpSignals: FP,
      db,
    });
    expect(res).toEqual({
      allowed: true,
      code: "OK",
      claim: {
        ip_trunc: "1.2.3",
        fp_hash: EXPECTED_FP,
        email_domain: "",
        is_temp_mail: false,
        suspected_duplicate: false,
      },
    });
    expect(res.claim.fp_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(db.countCalls).toHaveLength(1);
    expect(db.fpCalls).toHaveLength(1);
  });
});
