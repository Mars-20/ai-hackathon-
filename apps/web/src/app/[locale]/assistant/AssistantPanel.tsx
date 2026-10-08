"use client";

// Assistant chat panel — threads sidebar + messages + composer.
// Wire contract (lib/assistant/http.ts):
//   POST { message, conversation_id?, client_message_id } → pre-persist
//   denials as JSON, otherwise SSE token/tool/done/error (HTTP 200).
// Text renders as React text nodes only (never innerHTML); [S#]/[E#]/
// [W#]/[M#] markers become CitationChip buttons. SSE parsing reuses
// lib/sse-client with the validate page's terminal-guard discipline.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Send, Square, Plus, Trash2, Pencil, MessageCircle, X } from "lucide-react";
import { createSseParser } from "@/lib/sse-client";
import { stripLocale, withLocale } from "@/lib/i18n-path";
import {
  MESSAGE_MAX,
  formatSseError,
  parseCitationTokens,
} from "@/lib/assistant/format";
import CitationChip from "./CitationChip";
import ActionCards, { toolCardFromRow } from "./ActionCards";
import type {
  AssistantListItem,
  AssistantMessageRow,
  AssistantPrefs,
  AssistantQuota,
  AssistantThread,
  SseAssistantEvent,
  ToolCard,
} from "@/lib/assistant/types";

interface ClientMsg extends AssistantMessageRow {
  cards?: ToolCard[];
}

const SAMPLE_QUESTIONS = [
  "ما أقوى دليل يدعم فكرتي؟",
  "أنشئ تجربة لاختبار أهم افتراض",
  "ما أضعف نقطة في التحقق الحالي؟",
];

/** Attach persisted `tool` rows to the preceding assistant message. */
function groupRows(rows: AssistantMessageRow[]): ClientMsg[] {
  const out: ClientMsg[] = [];
  for (const r of rows) {
    if (r.role === "tool") {
      const card = toolCardFromRow(r.tool_name, r.content);
      const last = out[out.length - 1];
      if (card && last && last.role === "assistant") {
        last.cards = [...(last.cards ?? []), card];
      }
      continue;
    }
    out.push({ ...r });
  }
  return out;
}

export default function AssistantPanel({
  initialThreads = [],
  embedded = false,
}: {
  initialThreads?: AssistantThread[];
  embedded?: boolean;
}) {
  const [threads, setThreads] = useState<AssistantThread[]>(initialThreads);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ClientMsg[]>([]);
  const [liveText, setLiveText] = useState("");
  const [liveCards, setLiveCards] = useState<ToolCard[]>([]);
  const [thinking, setThinking] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plansUrl, setPlansUrl] = useState<string | null>(null);
  const [threadFull, setThreadFull] = useState(false);
  const [quota, setQuota] = useState<AssistantQuota | null>(null);
  const [prefs, setPrefs] = useState<AssistantPrefs | null>(null);
  const [showThreads, setShowThreads] = useState(false);
  // Locale for hrefs: this panel renders both inside [locale] pages AND in
  // the root-level float widget (no NextIntl provider there), so derive it
  // from the pathname (Task 2 stripLocale) instead of useLocale().
  const pathname = usePathname();
  const panelLocale = stripLocale(pathname ?? "/").locale ?? "en";
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const deleteConfirmRef = useRef<HTMLButtonElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, liveText, thinking]);

  useEffect(() => {
    if (deleteId) deleteConfirmRef.current?.focus();
  }, [deleteId]);

  const refreshThreads = useCallback(async () => {
    try {
      const res = await fetch("/api/assistant/conversations");
      if (!res.ok) return;
      const body = (await res.json()) as {
        conversations?: AssistantListItem[];
        quota?: AssistantQuota;
      };
      if (Array.isArray(body.conversations)) {
        setThreads(
          body.conversations.map((c) => ({
            id: c.id,
            title: c.title,
            created_at: c.updated_at,
          }))
        );
      }
      if (body.quota) setQuota(body.quota);
    } catch {
      // threads stay as-is; surfaced on next action
    }
  }, []);

  useEffect(() => {
    void refreshThreads();
    if (!embedded) {
      void fetch("/api/assistant/prefs")
        .then((r) => (r.ok ? r.json() : null))
        .then((b) => {
          if (b && typeof b.float_enabled === "boolean") {
            setPrefs({ float_enabled: b.float_enabled });
          }
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openThread = useCallback(async (id: string) => {
    setActiveId(id);
    setMessages([]);
    setLiveText("");
    setLiveCards([]);
    setError(null);
    setPlansUrl(null);
    setThreadFull(false);
    setShowThreads(false);
    try {
      const res = await fetch(
        `/api/assistant/conversations/${encodeURIComponent(id)}/messages`
      );
      if (res.status === 403) {
        setError("هذه المحادثة لم تعد متاحة.");
        void refreshThreads();
        return;
      }
      if (!res.ok) throw new Error(`messages ${res.status}`);
      const body = (await res.json()) as { messages?: AssistantMessageRow[] };
      setMessages(groupRows(Array.isArray(body.messages) ? body.messages : []));
    } catch {
      setError("تعذر تحميل الرسائل. حاول مجدداً.");
    }
  }, [refreshThreads]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    if (text.length > MESSAGE_MAX) {
      setError(`الرسالة طويلة (الحد ${MESSAGE_MAX} حرف). اختصر وحاول مجدداً.`);
      return;
    }
    const key = crypto.randomUUID();
    setInput("");
    setError(null);
    setPlansUrl(null);
    setThreadFull(false);
    setLiveText("");
    setLiveCards([]);
    setThinking(true);
    setSending(true);
    setMessages((prev) => [
      ...prev,
      {
        id: key,
        role: "user",
        content: text,
        tool_name: null,
        tool_args: null,
        citations: null,
        created_at: new Date().toISOString(),
      },
    ]);
    abortRef.current = new AbortController();
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          conversation_id: activeId ?? undefined,
          client_message_id: key,
        }),
        signal: abortRef.current.signal,
      });
      if (!res.ok) {
        let body: { error?: unknown; plans_url?: unknown; retryAfter?: unknown } = {};
        try {
          body = (await res.json()) as typeof body;
        } catch {
          // keep default
        }
        if (res.status === 402 && typeof body.plans_url === "string") {
          setPlansUrl(body.plans_url);
        }
        if (res.status === 409) setThreadFull(true);
        if (res.status === 403 || res.status === 404) void refreshThreads();
        setError(formatSseError(res.status, body));
        setSending(false);
        setThinking(false);
        return;
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const sse = createSseParser();
      let full = "";
      let cards: ToolCard[] = [];
      let conversationId: string | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of sse.push(decoder.decode(value, { stream: true }))) {
          const data = event as unknown as SseAssistantEvent;
          switch (data.type) {
            case "token":
              if (typeof data.text === "string") {
                full += data.text;
                setLiveText(full);
                setThinking(false);
              }
              break;
            case "tool": {
              const card: ToolCard = {
                tool: data.tool,
                result_summary: data.result_summary,
                ...(data.url ? { url: data.url } : {}),
                ...(data.error ? { error: true } : {}),
              };
              cards = [...cards, card];
              setLiveCards(cards);
              break;
            }
            case "done":
              conversationId = data.conversation_id;
              break;
            case "error":
              setError(
                typeof data.message === "string" && data.message
                  ? data.message
                  : "فشل المساعد"
              );
              break;
          }
        }
      }
      if (!sse.hasTerminalEvent()) {
        setError("انقطع الاتصال قبل وصول الإجابة. أعد المحاولة.");
      } else if (conversationId) {
        if (!activeId) {
          const cid = conversationId;
          setActiveId(cid);
          setThreads((prev) =>
            prev.some((t) => t.id === cid)
              ? prev
              : [{ id: cid, title: text.slice(0, 60), created_at: new Date().toISOString() }, ...prev]
          );
        }
        if (full || cards.length > 0) {
          setMessages((prev) => [
            ...prev,
            {
              id: `a-${key}`,
              role: "assistant",
              content: full,
              tool_name: null,
              tool_args: null,
              citations: null,
              created_at: new Date().toISOString(),
              cards,
            },
          ]);
        }
        setLiveText("");
        setLiveCards([]);
        // Threads order + quota snapshot refresh (SSE carries neither).
        void refreshThreads();
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError("تعذر الوصول إلى الخادم. تحقق من الاتصال وحاول مجدداً.");
      }
    } finally {
      setSending(false);
      setThinking(false);
    }
  }, [input, sending, activeId, refreshThreads]);

  const stop = () => {
    abortRef.current?.abort();
    setSending(false);
    setThinking(false);
  };

  const newChat = () => {
    stop();
    setActiveId(null);
    setMessages([]);
    setLiveText("");
    setLiveCards([]);
    setError(null);
    setPlansUrl(null);
    setThreadFull(false);
    setShowThreads(false);
  };

  const commitRename = async (id: string) => {
    const title = renameValue.trim().slice(0, 80);
    setRenameId(null);
    if (!title) return;
    try {
      const res = await fetch(`/api/assistant/conversations/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error(`rename ${res.status}`);
      setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
    } catch {
      setError("تعذر إعادة التسمية.");
    }
  };

  const confirmDelete = async () => {
    const id = deleteId;
    setDeleteId(null);
    if (!id) return;
    try {
      const res = await fetch(`/api/assistant/conversations/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404) throw new Error(`delete ${res.status}`);
      setThreads((prev) => prev.filter((t) => t.id !== id));
      if (activeId === id) newChat();
    } catch {
      setError("تعذر حذف المحادثة.");
    }
  };

  const toggleFloat = async (next: boolean) => {
    setPrefs({ float_enabled: next });
    try {
      await fetch("/api/assistant/prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ float_enabled: next }),
      });
    } catch {
      // pref reverts on next load; non-fatal
    }
  };

  const renderSegments = (text: string, msgId: string) =>
    parseCitationTokens(text).map((seg, i) =>
      seg.kind === "cite" ? (
        <CitationChip key={`${msgId}-cite-${i}`} label={seg.label} />
      ) : (
        <span key={`${msgId}-t-${i}`}>{seg.text}</span>
      )
    );

  return (
    <div className="flex flex-col md:flex-row gap-4 min-h-[60dvh]">
      {/* ── Threads sidebar ── */}
      {!embedded && (
        <>
          <button
            onClick={() => setShowThreads((v) => !v)}
            className="md:hidden glass rounded-xl px-3 py-2 text-xs text-slate-300 flex items-center gap-2 self-start"
          >
            <MessageCircle className="w-4 h-4" /> المحادثات ({threads.length})
          </button>
          <aside
            className={`${showThreads ? "flex" : "hidden"} md:flex flex-col gap-2 md:w-64 shrink-0`}
          >
            <button
              onClick={newChat}
              className="btn-glow text-white text-xs font-semibold px-3 py-2 rounded-xl flex items-center gap-1.5 justify-center"
            >
              <Plus className="w-3.5 h-3.5" /> محادثة جديدة
            </button>
            <div className="flex flex-col gap-1.5 overflow-y-auto max-h-[40dvh] md:max-h-[60dvh]">
              {threads.length === 0 ? (
                <div className="glass rounded-xl p-6 text-center border border-dashed border-white/10">
                  <MessageCircle className="w-6 h-6 text-slate-700 mx-auto mb-2" />
                  <p className="text-slate-500 text-xs">لا محادثات بعد — ابدأ بسؤال.</p>
                </div>
              ) : (
                threads.map((t) => (
                  <div
                    key={t.id}
                    className={`glass rounded-xl px-3 py-2 flex items-center gap-1.5 border ${
                      t.id === activeId ? "border-brand-500/50" : "border-white/5"
                    }`}
                  >
                    {renameId === t.id ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void commitRename(t.id);
                          if (e.key === "Escape") setRenameId(null);
                        }}
                        onBlur={() => setRenameId(null)}
                        maxLength={80}
                        className="flex-1 min-w-0 bg-transparent text-xs text-slate-200 outline-none"
                        aria-label="اسم المحادثة"
                      />
                    ) : (
                      <button
                        onClick={() => void openThread(t.id)}
                        className="flex-1 min-w-0 text-right text-xs text-slate-300 truncate hover:text-slate-100"
                        title={t.title ?? "محادثة"}
                      >
                        {t.title ?? "محادثة"}
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setRenameId(t.id);
                        setRenameValue(t.title ?? "");
                      }}
                      className="text-slate-600 hover:text-slate-300 shrink-0"
                      title="إعادة تسمية"
                      aria-label="إعادة تسمية المحادثة"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setDeleteId(t.id)}
                      className="text-slate-600 hover:text-red-400 shrink-0"
                      title="حذف"
                      aria-label="حذف المحادثة"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </aside>
        </>
      )}

      {/* ── Conversation ── */}
      <section className="flex-1 min-w-0 flex flex-col gap-3">
        {/* Quota + prefs */}
        <div className="flex items-center gap-3 flex-wrap">
          {quota && (
            <div
              className="glass rounded-xl px-3 py-1.5 text-[11px] text-slate-400 flex items-center gap-2"
              title="الحصة اليومية للمساعد"
            >
              <span>الحصة {quota.used}/{quota.quota}</span>
              <span className="w-16 h-1 rounded bg-white/10 overflow-hidden inline-block">
                <span
                  className="progress-fill block h-full"
                  style={{ width: `${Math.min(100, (quota.used / Math.max(1, quota.quota)) * 100)}%` }}
                />
              </span>
            </div>
          )}
          {!embedded && prefs && (
            <label className="glass rounded-xl px-3 py-1.5 text-[11px] text-slate-400 flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={prefs.float_enabled}
                onChange={(e) => void toggleFloat(e.target.checked)}
                className="accent-[#5c7cfa]"
              />
              الزر العائم
            </label>
          )}
          {embedded && (
            <Link href={withLocale("/assistant", panelLocale)} className="text-[11px] text-brand-400 hover:underline">
              فتح الصفحة الكاملة
            </Link>
          )}
        </div>

        {/* Errors */}
        {error && (
          <div className="glass rounded-xl p-3 border border-red-500/20 text-xs text-red-300 flex items-start gap-2">
            <span className="flex-1">{error}</span>
            {plansUrl && (
              <Link href={plansUrl.startsWith("/") ? withLocale(plansUrl, panelLocale) : plansUrl} className="text-brand-400 hover:underline shrink-0">
                عرض الخطط
              </Link>
            )}
            {threadFull && (
              <button onClick={newChat} className="text-brand-400 hover:underline shrink-0">
                محادثة جديدة
              </button>
            )}
            <button onClick={() => { setError(null); setPlansUrl(null); setThreadFull(false); }} aria-label="إغلاق" className="shrink-0 text-slate-500 hover:text-slate-300">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Messages */}
        <div className="flex flex-col gap-3 overflow-y-auto max-h-[55dvh] md:max-h-[60dvh] pb-2">
          {messages.length === 0 && !sending && (
            <div className="glass rounded-2xl p-8 text-center border border-dashed border-white/10">
              <MessageCircle className="w-8 h-8 text-slate-700 mx-auto mb-3" />
              <p className="text-slate-400 text-sm mb-4">اسأل عن أفكارك وأدلتك — الإجابات مؤرضة على بياناتك فقط.</p>
              <div className="flex flex-wrap gap-2 justify-center">
                {SAMPLE_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    onClick={() => setInput(q)}
                    className="glass glass-hover rounded-xl px-3 py-1.5 text-xs text-slate-300 border border-white/5"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="assistant-user self-start max-w-[85%] rounded-2xl px-4 py-2.5 text-sm">
                {m.content}
              </div>
            ) : m.role === "assistant" ? (
              <div key={m.id} data-assistant-message className="glass rounded-2xl px-4 py-3 text-sm text-slate-200 border border-white/5">
                <div className="whitespace-pre-wrap leading-relaxed">
                  {renderSegments(m.content, m.id)}
                </div>
                {m.cards && m.cards.length > 0 && <ActionCards cards={m.cards} />}
              </div>
            ) : null
          )}
          {(sending || liveText || liveCards.length > 0) && (
            <div data-assistant-message className="glass rounded-2xl px-4 py-3 text-sm text-slate-200 border border-white/5">
              {thinking && !liveText && (
                <p className="text-xs text-slate-500 shimmer">يفكر…</p>
              )}
              {liveText && (
                <div className="whitespace-pre-wrap leading-relaxed">
                  {renderSegments(liveText, "live")}
                </div>
              )}
              {liveCards.length > 0 && <ActionCards cards={liveCards} />}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Composer */}
        <div className="glass rounded-2xl p-3 border border-white/5">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value.slice(0, MESSAGE_MAX))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder="اسأل المساعد…"
            className="w-full bg-transparent text-sm text-slate-200 placeholder:text-slate-600 outline-none resize-none"
            aria-label="رسالة المساعد"
            disabled={sending}
          />
          <div className="flex items-center justify-between mt-1">
            <span className="text-[11px] text-slate-600">
              {input.length}/{MESSAGE_MAX}
            </span>
            {sending ? (
              <button
                onClick={stop}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-red-500/20 text-red-300 hover:bg-red-500/30"
                aria-label="إيقاف"
              >
                <Square className="w-3.5 h-3.5" /> إيقاف
              </button>
            ) : (
              <button
                onClick={() => void send()}
                disabled={!input.trim()}
                className="btn-glow text-white text-xs font-semibold px-4 py-1.5 rounded-lg flex items-center gap-1.5 disabled:opacity-40"
                aria-label="إرسال"
              >
                <Send className="w-3.5 h-3.5 rtl:rotate-180" /> إرسال
              </button>
            )}
          </div>
        </div>
      </section>

      {/* ── Delete confirm (memories precedent) ── */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)" }}>
          <div dir="rtl" role="dialog" aria-modal="true" aria-labelledby="assistant-delete-title" className="glass rounded-3xl p-8 w-full max-w-md border border-white/10">
            <h3 id="assistant-delete-title" className="font-bold text-slate-200 text-lg mb-2">
              حذف المحادثة؟
            </h3>
            <p className="text-slate-400 text-sm mb-6">سيتم حذف جميع رسائل هذه المحادثة نهائياً.</p>
            <div className="flex gap-3">
              <button
                ref={deleteConfirmRef}
                onClick={() => void confirmDelete()}
                onKeyDown={(e) => { if (e.key === "Escape") setDeleteId(null); }}
                aria-label="تأكيد الحذف"
                className="flex-1 py-3 rounded-xl text-sm font-bold text-white bg-red-500/80 hover:bg-red-500"
              >
                حذف
              </button>
              <button
                onClick={() => setDeleteId(null)}
                aria-label="إلغاء"
                className="flex-1 glass py-3 rounded-xl text-sm text-slate-400 hover:text-slate-200 transition-all"
              >
                إلغاء
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
