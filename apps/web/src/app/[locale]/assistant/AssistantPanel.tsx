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
import { useTranslations } from "next-intl";
import { Send, Square, Plus, Trash2, Pencil, MessageCircle, X } from "lucide-react";
import { createSseParser } from "@/lib/sse-client";
import { stripLocale, withLocale } from "@/lib/i18n-path";
import {
  MESSAGE_MAX,
  THREAD_CAP,
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

/** Attach persisted `tool` rows to the preceding assistant message. */
function groupRows(rows: AssistantMessageRow[]): ClientMsg[] {
  const out: ClientMsg[] = [];
  for (const r of rows) {
    if (r.role === "tool") {
      const card = toolCardFromRow(r.tool_name, r.content, r.id);
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
  const tAsst = useTranslations("assistant");
  const tShared = useTranslations("shared");
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
        setError(tAsst("errors.unavailable"));
        void refreshThreads();
        return;
      }
      if (!res.ok) throw new Error(`messages ${res.status}`);
      const body = (await res.json()) as { messages?: AssistantMessageRow[] };
      setMessages(groupRows(Array.isArray(body.messages) ? body.messages : []));
    } catch {
      setError(tAsst("errors.loadFailed"));
    }
  }, [refreshThreads, tAsst]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    if (text.length > MESSAGE_MAX) {
      setError(tAsst("errors.tooLong", { max: MESSAGE_MAX }));
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
        // Error copy resolves here against assistant.errors.* (stable ids
        // mirror lib/assistant/format.ts; lib UNTOUCHED, server bodies unchanged).
        if (res.status === 402) {
          const url = typeof body.plans_url === "string" ? body.plans_url : "/plans";
          setError(tAsst("errors.quotaExceeded", { url }));
        } else if (res.status === 409) {
          setError(tAsst("errors.threadCap", { max: THREAD_CAP }));
        } else if (res.status === 422) {
          setError(tAsst("errors.sensitiveContent"));
        } else if (res.status === 429) {
          const wait =
            typeof body.retryAfter === "number" && body.retryAfter > 0
              ? ` (${body.retryAfter}s)`
              : "";
          setError(tAsst("errors.rateLimited", { wait }));
        } else {
          const serverMsg = typeof body.error === "string" && body.error ? body.error : null;
          setError(serverMsg ?? tAsst("errors.requestFailed", { status: res.status }));
        }
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
                ...(data.needs_confirm ? { needsConfirm: true as const } : {}),
                ...(data.message_id ? { messageId: data.message_id } : {}),
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
                  : tAsst("errors.failed")
              );
              break;
          }
        }
      }
      if (!sse.hasTerminalEvent()) {
        setError(tAsst("errors.disconnected"));
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
        setError(tAsst("errors.serverUnreachable"));
      }
    } finally {
      setSending(false);
      setThinking(false);
    }
  }, [input, sending, activeId, refreshThreads, tAsst]);

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
      setError(tAsst("errors.renameFailed"));
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
      setError(tAsst("errors.deleteFailed"));
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
            <MessageCircle className="w-4 h-4" /> {tAsst("list.titlePattern", { count: threads.length })}
          </button>
          <aside
            className={`${showThreads ? "flex" : "hidden"} md:flex flex-col gap-2 md:w-64 shrink-0`}
          >
            <button
              onClick={newChat}
              className="btn-glow text-white text-xs font-semibold px-3 py-2 rounded-xl flex items-center gap-1.5 justify-center"
            >
              <Plus className="w-3.5 h-3.5" /> {tAsst("list.newCta")}
            </button>
            <div className="flex flex-col gap-1.5 overflow-y-auto max-h-[40dvh] md:max-h-[60dvh]">
              {threads.length === 0 ? (
                <div className="glass rounded-xl p-6 text-center border border-dashed border-white/10">
                  <MessageCircle className="w-6 h-6 text-slate-700 mx-auto mb-2" />
                  <p className="text-slate-500 text-xs">{tAsst("list.emptyLine")}</p>
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
                        aria-label={tAsst("list.renameTitle")}
                      />
                    ) : (
                      <button
                        onClick={() => void openThread(t.id)}
                        className="flex-1 min-w-0 text-end text-xs text-slate-300 truncate hover:text-slate-100"
                        title={t.title ?? tShared("misc.conversation")}
                      >
                        {t.title ?? tShared("misc.conversation")}
                      </button>
                    )}
                    <button
                      onClick={() => {
                        setRenameId(t.id);
                        setRenameValue(t.title ?? "");
                      }}
                      className="text-slate-600 hover:text-slate-300 shrink-0"
                      title={tAsst("list.renameAria")}
                      aria-label={tAsst("list.renameAria")}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setDeleteId(t.id)}
                      className="text-slate-600 hover:text-red-400 shrink-0"
                      title={tAsst("list.deleteTitle")}
                      aria-label={tAsst("list.deleteAria")}
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
              title={tAsst("list.quotaTitle")}
            >
              <span>{tAsst("list.quotaPattern", { used: quota.used, quota: quota.quota })}</span>
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
              {tAsst("hints.floatLabel")}
            </label>
          )}
          {embedded && (
            <Link href={withLocale("/assistant", panelLocale)} className="text-[11px] text-brand-400 hover:underline">
              {tAsst("hints.openFull")}
            </Link>
          )}
        </div>

        {/* Errors */}
        {error && (
          <div className="glass rounded-xl p-3 border border-red-500/20 text-xs text-red-300 flex items-start gap-2">
            <span className="flex-1">{error}</span>
            {plansUrl && (
              <Link href={plansUrl.startsWith("/") ? withLocale(plansUrl, panelLocale) : plansUrl} className="text-brand-400 hover:underline shrink-0">
                {tAsst("hints.viewPlans")}
              </Link>
            )}
            {threadFull && (
              <button onClick={newChat} className="text-brand-400 hover:underline shrink-0">
                {tAsst("hints.newChatCta")}
              </button>
            )}
            <button onClick={() => { setError(null); setPlansUrl(null); setThreadFull(false); }} aria-label={tAsst("hints.closeAria")} className="shrink-0 text-slate-500 hover:text-slate-300">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Messages */}
        <div className="flex flex-col gap-3 overflow-y-auto max-h-[55dvh] md:max-h-[60dvh] pb-2">
          {messages.length === 0 && !sending && (
            <div className="glass rounded-2xl p-8 text-center border border-dashed border-white/10">
              <MessageCircle className="w-8 h-8 text-slate-700 mx-auto mb-3" />
              <p className="text-slate-400 text-sm mb-4">{tAsst("hints.composerHint")}</p>
              <div className="flex flex-wrap gap-2 justify-center">
                {[tAsst("samples.0"), tAsst("samples.1"), tAsst("samples.2")].map((q) => (
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
                {m.cards && m.cards.length > 0 && (
                  <ActionCards
                    cards={m.cards}
                    onCardUpdate={(ci, card) =>
                      setMessages((prev) =>
                        prev.map((pm) =>
                          pm.id === m.id
                            ? { ...pm, cards: (pm.cards ?? []).map((c, j) => (j === ci ? card : c)) }
                            : pm
                        )
                      )
                    }
                  />
                )}
              </div>
            ) : null
          )}
          {(sending || liveText || liveCards.length > 0) && (
            <div data-assistant-message className="glass rounded-2xl px-4 py-3 text-sm text-slate-200 border border-white/5">
              {thinking && !liveText && (
                <p className="text-xs text-slate-500 shimmer">{tAsst("composer.thinking")}</p>
              )}
              {liveText && (
                <div className="whitespace-pre-wrap leading-relaxed">
                  {renderSegments(liveText, "live")}
                </div>
              )}
              {liveCards.length > 0 && (
                <ActionCards
                  cards={liveCards}
                  onCardUpdate={(ci, card) => setLiveCards((prev) => prev.map((c, j) => (j === ci ? card : c)))}
                />
              )}
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
            placeholder={tAsst("composer.placeholder")}
            className="w-full bg-transparent text-sm text-slate-200 placeholder:text-slate-600 outline-none resize-none"
            aria-label={tAsst("composer.placeholder")}
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
                aria-label={tAsst("composer.stopAria")}
              >
                <Square className="w-3.5 h-3.5" /> {tAsst("composer.stopLabel")}
              </button>
            ) : (
              <button
                onClick={() => void send()}
                disabled={!input.trim()}
                className="btn-glow text-white text-xs font-semibold px-4 py-1.5 rounded-lg flex items-center gap-1.5 disabled:opacity-40"
                aria-label={tAsst("composer.sendAria")}
              >
                <Send className="w-3.5 h-3.5 rtl:rotate-180" /> {tAsst("composer.sendLabel")}
              </button>
            )}
          </div>
        </div>
      </section>

      {/* ── Delete confirm (memories precedent) ── */}
      {deleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)" }}>
          <div dir={panelLocale === "ar" ? "rtl" : "ltr"} role="dialog" aria-modal="true" aria-labelledby="assistant-delete-title" className="glass rounded-3xl p-8 w-full max-w-md border border-white/10">
            <h3 id="assistant-delete-title" className="font-bold text-slate-200 text-lg mb-2">
              {tAsst("dialogs.deleteTitle")}
            </h3>
            <p className="text-slate-400 text-sm mb-6">{tAsst("dialogs.deleteBody")}</p>
            <div className="flex gap-3">
              <button
                ref={deleteConfirmRef}
                onClick={() => void confirmDelete()}
                onKeyDown={(e) => { if (e.key === "Escape") setDeleteId(null); }}
                aria-label={tAsst("dialogs.confirmAria")}
                className="flex-1 py-3 rounded-xl text-sm font-bold text-white bg-red-500/80 hover:bg-red-500"
              >
                {tAsst("dialogs.deleteConfirm")}
              </button>
              <button
                onClick={() => setDeleteId(null)}
                aria-label={tAsst("dialogs.cancelAria")}
                className="flex-1 glass py-3 rounded-xl text-sm text-slate-400 hover:text-slate-200 transition-all"
              >
                {tAsst("dialogs.cancelAria")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
