// Client-safe pure helpers for the assistant UI (no server imports).
// Rendering rule: the panel renders assistant text as React text nodes
// only (never innerHTML); CitationChip splits out [S#]/[E#]/[W#]/[M#]
// markers. Server-side escaping lives in model.ts/http.ts.

export interface TextSegment {
  kind: "text";
  text: string;
}

export interface CiteSegment {
  kind: "cite";
  label: string;
}

export type MessageSegment = TextSegment | CiteSegment;

const CITE_RE = /\[(S|E|W|M)(\d{1,3})\]/g;

/** Split assistant text into plain-text and citation-chip segments. */
export function parseCitationTokens(text: string): MessageSegment[] {
  const segs: MessageSegment[] = [];
  let last = 0;
  CITE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITE_RE.exec(text)) !== null) {
    if (m.index > last) segs.push({ kind: "text", text: text.slice(last, m.index) });
    segs.push({ kind: "cite", label: `${m[1]}${m[2]}` });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ kind: "text", text: text.slice(last) });
  if (segs.length === 0) segs.push({ kind: "text", text });
  return segs;
}

/** 200 messages per thread. */
export const THREAD_CAP = 200;

/** Server message cap (http.ts MESSAGE_MAX). The composer mirrors it. */
export const MESSAGE_MAX = 4000;

/** Arabic 409 notice: the thread is full — start a new chat. */
export function formatThreadCapError(): string {
  return `هذه المحادثة ممتلئة (${THREAD_CAP} رسالة). ابدأ محادثة جديدة للمتابعة.`;
}

/** Map non-SSE error responses to an Arabic user-facing message. */
export function formatSseError(
  status: number,
  body: { error?: unknown; plans_url?: unknown; retryAfter?: unknown }
): string {
  const serverMsg = typeof body.error === "string" && body.error ? body.error : null;
  if (status === 402) {
    const url = typeof body.plans_url === "string" ? body.plans_url : "/plans";
    return `انتهت الحصة اليومية للمساعد. للمتابعة راجع الخطط: ${url}`;
  }
  if (status === 409) return formatThreadCapError();
  if (status === 422) return "تعذر إظهار هذه الإجابة (محتوى حساس). أعد الصياغة وحاول مجدداً.";
  if (status === 429) {
    const wait = typeof body.retryAfter === "number" && body.retryAfter > 0 ? ` (${body.retryAfter}s)` : "";
    return `طلبات كثيرة — انتظر قليلاً ثم أعد المحاولة${wait}.`;
  }
  return serverMsg ?? `Request failed (${status})`;
}
