// ─────────────────────────────────────────────────────────────────────────────
// PlatformAdminGrantForm — platform-only grant island for the ops page
// (POST /api/admin/ops/admins is platform-tier only; workspace-tier POSTs
// get 403 with a denied audit trail). Rendered only for the platform tier.
// Same-origin fetch only; no keys or secrets touch the client. Denials
// surface as messages; success refreshes the server-rendered list.
// ─────────────────────────────────────────────────────────────────────────────
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record["error"] === "string") return record["error"];
  }
  return fallback;
}

export default function PlatformAdminGrantForm() {
  const router = useRouter();
  const t = useTranslations("admin.grantForm");
  const tErr = useTranslations("admin.errors");
  const [userId, setUserId] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function runGrant() {
    const trimmed = userId.trim();
    if (trimmed.length === 0) {
      setMessage(t("userIdRequired"));
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/ops/admins", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          user_id: trimmed,
          ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}),
        }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setMessage(errorMessage(body, tErr("requestFailed")));
        return;
      }
      setUserId("");
      setReason("");
      setMessage(t("done"));
      router.refresh();
    } catch {
      setMessage(tErr("networkError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-3 items-end mb-4">
      <label className="text-xs text-slate-400 space-y-1">
        {t("userIdLabel")}
        <input
          type="text"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder={t("userIdPlaceholder")}
          className="block glass rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 outline-none border border-white/5 focus:border-brand-500/50 bg-transparent w-64"
        />
      </label>
      <label className="text-xs text-slate-400 space-y-1">
        {t("reasonLabel")}
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t("reasonPlaceholder")}
          className="block glass rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 outline-none border border-white/5 focus:border-brand-500/50 bg-transparent w-64"
        />
      </label>
      <button
        type="button"
        disabled={pending}
        onClick={() => void runGrant()}
        className="text-sm px-4 py-2 rounded-xl bg-brand-500/20 text-brand-300 border border-brand-500/30 disabled:opacity-50"
      >
        {pending ? t("granting") : t("grant")}
      </button>
      {message !== null && (
        <span className="text-xs text-slate-400" role="status">
          {message}
        </span>
      )}
    </div>
  );
}
