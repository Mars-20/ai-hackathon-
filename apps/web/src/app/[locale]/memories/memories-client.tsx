"use client";

// Interactive memories console (Task 9): pending queue + approved list +
// decide/edit/forget/toggle against the Task 7 endpoints. All user-facing
// copy comes from the memories.* namespace (EN mirrors of MEMORY_COPY ids,
// resolved here in the component; lib/companion/copy.ts UNTOUCHED).

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { flagPossibleConflicts } from "@/lib/companion/ranker";
import { containsBlockedSecret } from "@/lib/companion/scans";
import { formatProvenance } from "@/lib/companion/provenance";

export interface MemoryItem {
  id: string;
  kind: string;
  value: string;
  status: string | null;
  confidence: number | null;
  source_ref: string | null;
  created_at: string;
  possible_conflict_with?: string;
}

const PENDING_CAP = 20;

interface ApiError {
  code?: unknown;
  error?: unknown;
}

async function readBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null) return body as Record<string, unknown>;
  } catch {
    // Non-JSON body — callers treat it as an unknown failure.
  }
  return {};
}

export default function MemoriesClient({
  initialItems,
  initialEnabled,
}: {
  initialItems: MemoryItem[];
  initialEnabled: boolean;
}) {
  const [items, setItems] = useState<MemoryItem[]>(initialItems);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [toggling, setToggling] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [forgetId, setForgetId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const forgetConfirmRef = useRef<HTMLButtonElement>(null);
  const locale = useLocale();
  const tMem = useTranslations("memories");
  const provenancePattern = tMem("provenance");

  // Toast auto-dismiss.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // Forget-confirm dialog semantics (dashboard paywall-modal precedent):
  // autofocus confirm on open, ESC-to-close, return focus to the trigger.
  useEffect(() => {
    if (!forgetId) return;
    forgetConfirmRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setForgetId(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.getElementById(`forget-btn-${forgetId}`)?.focus();
    };
  }, [forgetId]);

  const pending = useMemo(() => items.filter((r) => r.status === "pending"), [items]);
  const approved = useMemo(() => items.filter((r) => r.status === "approved"), [items]);
  const approvedById = useMemo(() => new Map(approved.map((r) => [r.id, r])), [approved]);
  // Deterministic spec §5 surfacing: pending rows conflicting with an
  // approved row show the pair together (no overwrite, ever).
  const conflictFlags = useMemo(() => flagPossibleConflicts(pending, approved), [pending, approved]);
  // Cached provenance strings: one Intl.DateTimeFormat per locale (see
  // lib/companion/provenance.ts) + one format per row per data/locale change.
  // Previously this ran 2x toLocaleDateString per row per render (~1ms each,
  // 240 calls ≈ 250ms long task blocking input on this page).
  const provenanceById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of items) {
      if (!m.has(r.id)) m.set(r.id, formatProvenance(provenancePattern, locale, r.created_at));
    }
    return m;
  }, [items, provenancePattern, locale]);

  function markBusy(id: string, on: boolean) {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function showCodeNotice(code: unknown): boolean {
    if (code === "MEMORY_FULL") {
      setNotice(tMem("memory_full"));
      return true;
    }
    if (code === "MEMORY_DUPLICATE") {
      setNotice(tMem("memory_duplicate"));
      return true;
    }
    if (code === "STARTUP_NOT_OWNED") {
      setToast(tMem("startup_not_owned"));
      return true;
    }
    return false;
  }

  async function refetch() {
    try {
      const res = await fetch("/api/companion/memory?status=all&limit=100", { cache: "no-store" });
      const body = await readBody(res);
      if (res.ok && Array.isArray(body.items)) {
        setItems((body.items as MemoryItem[]).filter((r) => typeof r?.id === "string"));
      }
    } catch {
      // Best-effort refresh; the current list stays on screen.
    }
  }

  async function decide(id: string, action: "approve" | "reject", value?: string) {
    if (value !== undefined && containsBlockedSecret(value)) {
      setToast(tMem("secret_blocked"));
      return;
    }
    markBusy(id, true);
    try {
      const res = await fetch(`/api/companion/memory/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(value === undefined ? { action } : { action, value }),
      });
      const body = await readBody(res);
      if (!res.ok) {
        const err = body as ApiError;
        if (!showCodeNotice(err.code)) {
          if (res.status === 404) await refetch();
          else setToast(typeof err.error === "string" ? err.error : tMem("empty_queue"));
        }
        return;
      }
      const updated = body as unknown as MemoryItem;
      if (action === "reject") {
        // Rejected rows are never surfaced — drop locally.
        setItems((prev) => prev.filter((r) => r.id !== id));
      } else {
        setItems((prev) => prev.map((r) => (r.id === id ? { ...r, ...updated } : r)));
      }
      setEditingId(null);
    } catch {
      setToast(tMem("empty_queue"));
    } finally {
      markBusy(id, false);
    }
  }

  async function forget(id: string) {
    markBusy(id, true);
    try {
      const res = await fetch(`/api/companion/memory/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await readBody(res);
        if (res.status === 404) await refetch();
        else if (!showCodeNotice((body as ApiError).code)) setToast(tMem("empty_queue"));
        return;
      }
      setItems((prev) => prev.filter((r) => r.id !== id));
    } catch {
      setToast(tMem("empty_queue"));
    } finally {
      markBusy(id, false);
      setForgetId(null);
    }
  }

  async function toggle(next: boolean) {
    setToggling(true);
    try {
      const res = await fetch("/api/companion/profile/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memory_enabled: next }),
      });
      const body = await readBody(res);
      if (!res.ok) {
        if (!showCodeNotice((body as ApiError).code)) setToast(tMem("disable_hint"));
        return;
      }
      setEnabled(next);
    } catch {
      setToast(tMem("disable_hint"));
    } finally {
      setToggling(false);
    }
  }

  function startEdit(item: MemoryItem) {
    setEditingId(item.id);
    setDraft(item.value);
  }

  return (
    <div className="space-y-8">
      {toast && (
        <div role="status" className="glass rounded-xl p-3 text-xs text-amber-300 border border-amber-500/20">
          {toast}
        </div>
      )}
      {notice && (
        <div className="glass rounded-xl p-3 text-xs text-slate-300 border border-white/10 flex items-center justify-between gap-3">
          <span>{notice}</span>
          <button
            onClick={() => setNotice(null)}
            aria-label={tMem("dismissAria")}
            className="text-slate-500 hover:text-slate-200"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ── Pending queue ── */}
      <section aria-label={tMem("pending_queue")}>
        <h2 className="font-bold text-slate-200 text-sm mb-4">{tMem("pending_queue")}</h2>
        {pending.length === 0 ? (
          <div className="glass rounded-2xl p-6 text-sm text-slate-400">{tMem("empty_queue")}</div>
        ) : (
          <ul id="pending-queue" className="space-y-3">
            {pending.map((item, index) => {
              const conflictId = conflictFlags.get(index) ?? item.possible_conflict_with;
              const conflictWith = conflictId ? approvedById.get(conflictId) : undefined;
              const busy = busyIds.has(item.id);
              return (
                <li
                  key={item.id}
                  id={`memory-row-${item.id}`}
                  className="glass rounded-2xl p-4 space-y-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <span className="text-[11px] text-slate-500 border border-white/10 rounded-md px-1.5 py-0.5">
                        {item.kind}
                      </span>
                      <p className="text-sm text-slate-200 mt-2 break-words">{item.value}</p>
                      <p className="text-[11px] text-slate-500 mt-1">{provenanceById.get(item.id) ?? item.created_at}</p>
                    </div>
                  </div>
                  {conflictWith && (
                    <div className="rounded-xl p-3 text-xs border border-amber-500/20 bg-amber-500/5 space-y-2">
                      <p className="text-amber-300">{tMem("conflict_pair")}</p>
                      <p className="text-slate-300 break-words">{conflictWith.value}</p>
                      <p className="text-[11px] text-slate-500">{provenanceById.get(conflictWith.id) ?? conflictWith.created_at}</p>
                    </div>
                  )}
                  {editingId === item.id ? (
                    <div className="space-y-2">
                      <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        rows={3}
                        maxLength={500}
                        aria-label={tMem("edit_approve")}
                        className="w-full glass rounded-xl p-3 text-sm text-slate-200"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => void decide(item.id, "approve", draft.trim())}
                          disabled={busy || draft.trim().length === 0}
                          aria-label={tMem("edit_approve")}
                          className="btn-glow text-white text-xs font-semibold px-4 py-2 rounded-lg disabled:opacity-50 flex items-center gap-1.5"
                        >
                          <Check className="w-3.5 h-3.5" />
                          {tMem("edit_approve")}
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          aria-label={tMem("cancelAria")}
                          className="glass py-2 px-4 rounded-lg text-xs text-slate-400"
                        >
                          {tMem("cancelAria")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => void decide(item.id, "approve")}
                        disabled={busy}
                        aria-label={tMem("approve")}
                        id={`approve-${item.id}`}
                        className="btn-glow text-white text-xs font-semibold px-4 py-2 rounded-lg disabled:opacity-50 flex items-center gap-1.5"
                      >
                        <Check className="w-3.5 h-3.5" />
                        {tMem("approve")}
                      </button>
                      <button
                        onClick={() => startEdit(item)}
                        disabled={busy}
                        aria-label={tMem("edit_approve")}
                        className="glass glass-hover px-4 py-2 rounded-lg text-xs text-slate-300 flex items-center gap-1.5"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                        {tMem("edit_approve")}
                      </button>
                      <button
                        onClick={() => void decide(item.id, "reject")}
                        disabled={busy}
                        aria-label={tMem("reject")}
                        className="glass glass-hover px-4 py-2 rounded-lg text-xs text-slate-400 flex items-center gap-1.5"
                      >
                        <X className="w-3.5 h-3.5" />
                        {tMem("reject")}
                      </button>
                      <button
                        onClick={() => setForgetId(item.id)}
                        disabled={busy}
                        aria-label={tMem("forget")}
                        id={`forget-btn-${item.id}`}
                        className="glass glass-hover px-4 py-2 rounded-lg text-xs text-red-400/80 flex items-center gap-1.5"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        {tMem("forget")}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {pending.length >= PENDING_CAP && (
          <p className="text-xs text-slate-500 mt-3">{tMem("cap_full")}</p>
        )}
      </section>

      {/* ── Approved ── */}
      {approved.length > 0 && (
        <section aria-label={tMem("approvedAria")}>
          <ul id="approved-list" className="space-y-3">
            {approved.map((item) => (
              <li key={item.id} id={`memory-row-${item.id}`} className="glass rounded-2xl p-4">
                <span className="text-[11px] text-slate-500 border border-white/10 rounded-md px-1.5 py-0.5">
                  {item.kind}
                </span>
                <p className="text-sm text-slate-200 mt-2 break-words">{item.value}</p>
                <p className="text-[11px] text-slate-500 mt-1">{provenanceById.get(item.id) ?? item.created_at}</p>
                <div className="mt-3">
                  <button
                    onClick={() => setForgetId(item.id)}
                    disabled={busyIds.has(item.id)}
                    aria-label={tMem("forget")}
                    id={`forget-btn-${item.id}`}
                    className="glass glass-hover px-4 py-2 rounded-lg text-xs text-red-400/80 flex items-center gap-1.5"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {tMem("forget")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Toggle ── */}
      <section className="glass rounded-2xl p-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm text-slate-200">{tMem("disable")}</p>
          <p className="text-[11px] text-slate-500 mt-1">{tMem("disable_hint")}</p>
        </div>
        <button
          onClick={() => void toggle(!enabled)}
          disabled={toggling}
          aria-label={tMem("disable")}
          aria-pressed={enabled}
          className={`px-4 py-2 rounded-lg text-xs font-semibold disabled:opacity-50 ${
            enabled ? "btn-glow text-white" : "glass text-slate-400"
          }`}
        >
          {enabled ? tMem("onLabel") : tMem("offLabel")}
        </button>
      </section>

      {/* ── Forget confirm (dashboard paywall-modal precedent) ── */}
      {forgetId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)" }}>
          <div dir={locale === "ar" ? "rtl" : "ltr"} role="dialog" aria-modal="true" aria-labelledby="forget-modal-title" className="glass rounded-3xl p-8 w-full max-w-md border border-white/10">
            <h3 id="forget-modal-title" className="font-bold text-slate-200 text-lg mb-2">
              {tMem("forget")}
            </h3>
            <p className="text-slate-400 text-sm mb-6">{tMem("forget_confirm")}</p>
            <div className="flex gap-3">
              <button
                ref={forgetConfirmRef}
                onClick={() => void forget(forgetId)}
                disabled={busyIds.has(forgetId)}
                aria-label={tMem("forget")}
                className="flex-1 py-3 rounded-xl text-sm font-bold text-white bg-red-500/80 hover:bg-red-500 disabled:opacity-50"
              >
                {tMem("forget")}
              </button>
              <button
                onClick={() => setForgetId(null)}
                aria-label={tMem("forgetCancel")}
                className="flex-1 glass py-3 rounded-xl text-sm text-slate-400 hover:text-slate-200 transition-all"
              >
                {tMem("forgetCancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
