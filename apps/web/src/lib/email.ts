// Bilingual email subjects (Task 5).
// Send language = the RECIPIENT's locale (their profiles.locale), never the
// sender's; default 'en'. Delivery itself stays out of scope in v1 (invite
// resend is audit-trail-only) — this module owns the subject lines.
import type { AiLocale } from "./ai-locale";

export const EMAIL_SUBJECTS = {
  welcome: {
    ar: "أهلاً بيك في مساعد التحقق",
    en: "Welcome to Validation Copilot",
  },
  report: {
    ar: "تقرير التحقق جاهز",
    en: "Your validation report is ready",
  },
} as const;

export type EmailKind = keyof typeof EMAIL_SUBJECTS;

export function getEmailSubject(kind: EmailKind, locale: AiLocale): string {
  return EMAIL_SUBJECTS[kind][locale];
}
