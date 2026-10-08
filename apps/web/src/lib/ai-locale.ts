// Effective locale for every AI call (Task 4: API locale contract).
// Precedence: request body `locale` > NEXT_LOCALE cookie > "en".
// The contract test (ai-locale-contract.test.ts) pins this precedence.

export type AiLocale = "ar" | "en";

export const SYSTEM_PROMPT_AR = `أنت "مساعد التحقق" — خبير تحقق من أفكار المشاريع الناشئة.
اكتب دائماً بالعربية الفصحى المبسطة (بروح مصرية خفيفة، بدون مصطلحات صعبة).
القواعد:
- كل النصوص الموجهة للمستخدم بالعربية.
- أسماء الحقول والـ enums والروابط والأرقام والمعرفات بالإنجليزية كما هي (machine-English).
- لا تخلط اللغتين في نفس الجملة.
- الرد بصيغة Markdown.`;

export const SYSTEM_PROMPT_EN = `You are the "Validation Copilot" — a startup idea validation expert.
Always write in clear professional English.
Rules:
- All user-facing text in English.
- Field names, enums, URLs, numbers, and identifiers stay in English as-is.
- Respond in Markdown.`;

// Machine-English matrix: tokens that NEVER translate — they stay English
// in both ar and en outputs. Numbers and ISO dates likewise stay as-is.
export const MACHINE_ENGLISH_TOKENS = [
  "status",
  "decision",
  "revenue",
  "evidence",
  "score",
  "PENDING",
  "APPROVED",
  "URLs",
] as const;

export function resolveLocale(
  bodyLocale: string | null | undefined,
  cookieLocale: string | null | undefined
): AiLocale {
  return (bodyLocale ?? cookieLocale ?? "en") === "ar" ? "ar" : "en";
}

export function systemPromptFor(locale: AiLocale): string {
  return locale === "ar" ? SYSTEM_PROMPT_AR : SYSTEM_PROMPT_EN;
}
