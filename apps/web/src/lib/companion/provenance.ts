// Provenance date formatting with cached Intl.DateTimeFormat instances.
//
// memories-client previously called `new Date(...).toLocaleDateString(locale,
// { year, month: "long", day })` twice per row per render. Each call parses
// options + resolves ICU data (~0.1-1ms); with 120 rows that's a 100ms+
// long task blocking input (INP input-delay). Reusing one formatter per
// locale is ~18x faster and output-identical.
const formatters = new Map<string, Intl.DateTimeFormat>();

export function getProvenanceFormatter(locale: string): Intl.DateTimeFormat {
  const tag = locale === "ar" ? "ar-EG-u-nu-latn" : "en-US";
  let fmt = formatters.get(tag);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(tag, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    formatters.set(tag, fmt);
  }
  return fmt;
}

export function formatProvenance(pattern: string, locale: string, createdAt: string): string {
  let date = createdAt;
  try {
    const parsed = new Date(createdAt);
    if (!Number.isNaN(parsed.getTime())) {
      date = getProvenanceFormatter(locale).format(parsed);
    }
    // Invalid dates keep the raw timestamp (previous code surfaced
    // "Invalid Date" because toLocaleDateString doesn't throw on it).
  } catch {
    // Keep the raw timestamp when the locale format fails.
  }
  return pattern.replace("{date}", date);
}
