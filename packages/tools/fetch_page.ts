/**
 * fetch_page tool (Section 7)
 * Safely fetches and extracts text from competitor/pricing pages.
 * Respects 10s timeout, returns explicit error rather than hallucinating content.
 */

export interface FetchPageResult {
  text: string;
  url: string;
  fetched_at: string;
  error?: string;
}

export async function fetchPage(url: string, timeoutMs = 10000): Promise<FetchPageResult> {
  const fetched_at = new Date().toISOString();
  // SSRF guard: http(s) only, block localhost/metadata/private ranges.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, fetched_at, text: "", error: "Invalid URL" };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { url, fetched_at, text: "", error: "Only http(s) URLs allowed" };
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" || host === "127.0.0.1" || host === "::1" ||
    host === "169.254.169.254" || host.endsWith(".internal") ||
    host.startsWith("10.") || host.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return { url, fetched_at, text: "", error: "Blocked private/internal host (SSRF guard)" };
  }
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "ValidationCopilot/2.0 (+https://github.com/validation-copilot)",
        Accept: "text/html,application/xhtml+xml,text/plain",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        url,
        fetched_at,
        text: "",
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    const html = await response.text();
    // Strip scripts, styles, and extract plain text
    const cleanText = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 15000); // Guard max payload

    return {
      url,
      fetched_at,
      text: cleanText,
    };
  } catch (err) {
    return {
      url,
      fetched_at,
      text: "",
      error: err instanceof Error ? err.message : "Fetch failed",
    };
  }
}
