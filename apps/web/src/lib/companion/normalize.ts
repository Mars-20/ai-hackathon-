// Token pipeline for Arabic-first memory matching (Task 3, zero I/O).
// Order matters: lowercase -> NFKD -> strip Arabic combining marks ->
// strip URLs -> fold Arabic-Indic digits -> strip emoji ->
// split on whitespace/punctuation.

const ARABIC_COMBINING = new RegExp(
  "[" + String.fromCharCode(0x64b) + "-" + String.fromCharCode(0x652) + "]",
  "g",
); // U+064B-U+0652 fatha..sukun
const URL_RE = /https?:\/\/\S+/g;
const EMOJI_RE = /[\p{Extended_Pictographic}\uFE0F]/gu;
const AR_INDIC_ZERO = 1632; // U+0660

function foldArabicIndicDigits(s: string): string {
  const lo = String.fromCharCode(0x660);
  const hi = String.fromCharCode(0x669);
  return s.replace(new RegExp("[" + lo + "-" + hi + "]", "g"), (d) => String(d.charCodeAt(0) - AR_INDIC_ZERO));
}

export function normalizeForMatch(s: string): string[] {
  const cleaned = foldArabicIndicDigits(
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(ARABIC_COMBINING, "")
      .replace(URL_RE, " ")
      .replace(EMOJI_RE, " "),
  );
  return cleaned.split(/[\s\p{P}]+/u).filter((t) => t.length > 0);
}

// Compiler-budget approximation ONLY (total prompt math lives in cost.ts).
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}
