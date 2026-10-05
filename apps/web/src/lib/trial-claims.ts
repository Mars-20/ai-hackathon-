import { hashFingerprint, truncateIp } from "@/lib/entitlements";
import { isTempMailDomain } from "@/lib/temp-mail-domains";

export interface ClaimsDb {
  countRecentClaims(ipTrunc: string, sinceIso: string): Promise<number>;
  findConsumedByFp(fpHash: string, excludeUserId: string): Promise<boolean>;
  insertClaim(row: { user_id: string; ip_trunc: string; fp_hash: string; email_domain: string; is_temp_mail: boolean; suspected_duplicate: boolean }): Promise<void>;
}

export interface TrialStartResult {
  allowed: boolean; code: "OK" | "TRIAL_NOT_ALLOWED"; reason?: string;
  claim: { ip_trunc: string; fp_hash: string; email_domain: string; is_temp_mail: boolean; suspected_duplicate: boolean };
}

const DEFAULT_MAX_PER_IP = 3;
const DEFAULT_IP_WINDOW_DAYS = 30;
const MS_PER_DAY = 86_400_000;

function parseEnvNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function extractDomain(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) {
    return "";
  }
  return email.slice(at + 1).toLowerCase();
}

export async function evaluateTrialStart(input: {
  userId: string; email: string; emailConfirmedAt: string | null; ip: string;
  fpSignals: { ua: string; screen: string; tz: string; lang: string };
  db: ClaimsDb; maxPerIp?: number; windowDays?: number; extraTempDomains?: string;
}): Promise<TrialStartResult> {
  const ipTrunc = truncateIp(input.ip);
  const fpHash = hashFingerprint(input.fpSignals);
  const emailDomain = extractDomain(input.email);
  const extra = input.extraTempDomains ?? process.env.TEMP_MAIL_EXTRA_DOMAINS;
  const isTemp = isTempMailDomain(emailDomain, extra);

  if (input.emailConfirmedAt == null) {
    return {
      allowed: false,
      code: "TRIAL_NOT_ALLOWED",
      reason: "فعّل بريدك أولًا",
      claim: { ip_trunc: ipTrunc, fp_hash: fpHash, email_domain: emailDomain, is_temp_mail: isTemp, suspected_duplicate: false },
    };
  }

  if (isTemp) {
    return {
      allowed: false,
      code: "TRIAL_NOT_ALLOWED",
      reason: "البريد المؤقت غير مسموح به للتجربة",
      claim: { ip_trunc: ipTrunc, fp_hash: fpHash, email_domain: emailDomain, is_temp_mail: true, suspected_duplicate: false },
    };
  }

  const max = input.maxPerIp ?? parseEnvNumber(process.env.TRIAL_MAX_PER_IP, DEFAULT_MAX_PER_IP);
  const window = input.windowDays ?? parseEnvNumber(process.env.TRIAL_IP_WINDOW_DAYS, DEFAULT_IP_WINDOW_DAYS);
  const sinceIso = new Date(Date.now() - window * MS_PER_DAY).toISOString();
  const recent = await input.db.countRecentClaims(ipTrunc, sinceIso);
  if (recent >= max) {
    return {
      allowed: false,
      code: "TRIAL_NOT_ALLOWED",
      reason: "الحد الأقصى للتجارب من هذه الشبكة",
      claim: { ip_trunc: ipTrunc, fp_hash: fpHash, email_domain: emailDomain, is_temp_mail: false, suspected_duplicate: false },
    };
  }

  const duplicate = await input.db.findConsumedByFp(fpHash, input.userId);
  if (duplicate) {
    return {
      allowed: true,
      code: "OK",
      claim: { ip_trunc: ipTrunc, fp_hash: fpHash, email_domain: emailDomain, is_temp_mail: false, suspected_duplicate: true },
    };
  }

  return {
    allowed: true,
    code: "OK",
    claim: { ip_trunc: ipTrunc, fp_hash: fpHash, email_domain: emailDomain, is_temp_mail: false, suspected_duplicate: false },
  };
}
