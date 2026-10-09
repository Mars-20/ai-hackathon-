// ─────────────────────────────────────────────────────────────────────────────
// ContentActions — client island for the content review queue (spec §§3,7).
// Flag/unflag is open to member+ (viewers never reach the page — the
// requireAdmin gate rejects them); policy screen (approve → go, reject →
// stop) requires admin/owner and is enforced by POST
// /api/admin/content/screen (denials surface as messages and are audit
// logged). The page always renders flagging; screening needs browser
// confirm state, so both live here. Same-origin fetches only.
// ─────────────────────────────────────────────────────────────────────────────
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

interface ContentActionsProps {
  startupId: string;
  startupName: string;
  flagged: boolean;
}

const CONFIDENCES = ["low", "medium", "high"] as const;

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record["error"] === "string") return record["error"];
  }
  return fallback;
}

export default function ContentActions({
  startupId,
  startupName,
  flagged,
}: ContentActionsProps) {
  const router = useRouter();
  const t = useTranslations("admin.contentActions");
  const tDialogs = useTranslations("admin.dialogs");
  const tShared = useTranslations("shared");
  const tErr = useTranslations("admin.errors");
  const [screenOpen, setScreenOpen] = useState(false);
  const [confidence, setConfidence] =
    useState<(typeof CONFIDENCES)[number]>("medium");
  const [rationale, setRationale] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function runFlag(next: boolean) {
    setPending(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/content/flag", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ startup_id: startupId, flagged: next }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setMessage(errorMessage(body, tErr("requestFailed")));
        return;
      }
      router.refresh();
    } catch {
      setMessage(tErr("networkError"));
    } finally {
      setPending(false);
    }
  }

  async function runScreen(decision: "approve" | "reject") {
    setPending(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/content/screen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          startup_id: startupId,
          decision,
          confidence,
          ...(rationale.trim().length > 0
            ? { rationale: rationale.trim() }
            : {}),
        }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setMessage(errorMessage(body, tErr("requestFailed")));
        return;
      }
      setScreenOpen(false);
      setRationale("");
      router.refresh();
    } catch {
      setMessage(tErr("networkError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 min-w-40">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => void runFlag(!flagged)}
          className={`text-xs px-2 py-1 rounded-lg border transition-colors disabled:opacity-50 ${
            flagged
              ? "border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/10"
              : "border-white/10 text-slate-300 hover:bg-white/5"
          }`}
        >
          {pending ? "…" : flagged ? t("unflag") : t("flag")}
        </button>
        <button
          type="button"
          onClick={() => {
            setScreenOpen((open) => !open);
            setMessage(null);
          }}
          className="text-xs px-2 py-1 rounded-lg border border-white/10 text-slate-300 hover:bg-white/5 transition-colors"
          title={t("screenTitle")}
        >
          {t("screen")}
        </button>
      </div>

      {screenOpen && (
        <div className="glass rounded-xl p-3 border border-white/10 space-y-2">
          <p className="text-xs text-slate-400">
            {tDialogs("screenConfirmPattern", { name: startupName })}
          </p>
          <select
            value={confidence}
            onChange={(e) =>
              setConfidence(e.target.value as (typeof CONFIDENCES)[number])
            }
            className="w-full glass rounded-lg px-2 py-1.5 text-xs text-slate-200 outline-none border border-white/5 bg-transparent"
            aria-label={t("confidenceAria")}
          >
            {CONFIDENCES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <textarea
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            placeholder={t("rationalePlaceholder")}
            rows={2}
            className="w-full glass rounded-lg px-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 outline-none border border-white/5 focus:border-brand-500/50 bg-transparent"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => void runScreen("approve")}
              className="text-xs px-2 py-1 rounded-lg bg-green-500/20 text-green-300 border border-green-500/30 disabled:opacity-50"
            >
              {pending ? "…" : t("approve")}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => void runScreen("reject")}
              className="text-xs px-2 py-1 rounded-lg bg-red-500/20 text-red-300 border border-red-500/30 disabled:opacity-50"
            >
              {pending ? "…" : t("reject")}
            </button>
            <button
              type="button"
              onClick={() => setScreenOpen(false)}
              className="text-xs px-2 py-1 rounded-lg text-slate-400 hover:text-slate-200"
            >
              {tShared("actions.cancel")}
            </button>
          </div>
        </div>
      )}

      {message !== null && (
        <p className="text-xs text-red-400" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
