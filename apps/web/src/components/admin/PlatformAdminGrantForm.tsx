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

function errorMessage(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record["error"] === "string") return record["error"];
  }
  return "Request failed";
}

export default function PlatformAdminGrantForm() {
  const router = useRouter();
  const [userId, setUserId] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function runGrant() {
    const trimmed = userId.trim();
    if (trimmed.length === 0) {
      setMessage("Enter a user ID to grant");
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
        setMessage(errorMessage(body));
        return;
      }
      setUserId("");
      setReason("");
      setMessage("Grant recorded");
      router.refresh();
    } catch {
      setMessage("Network error — please retry");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-3 items-end mb-4">
      <label className="text-xs text-slate-400 space-y-1">
        User ID to grant
        <input
          type="text"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder="Exact user UUID"
          className="block glass rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 outline-none border border-white/5 focus:border-brand-500/50 bg-transparent w-64"
        />
      </label>
      <label className="text-xs text-slate-400 space-y-1">
        Reason (audit log)
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Optional reason"
          className="block glass rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 outline-none border border-white/5 focus:border-brand-500/50 bg-transparent w-64"
        />
      </label>
      <button
        type="button"
        disabled={pending}
        onClick={() => void runGrant()}
        className="text-sm px-4 py-2 rounded-xl bg-brand-500/20 text-brand-300 border border-brand-500/30 disabled:opacity-50"
      >
        {pending ? "Granting…" : "Grant platform admin"}
      </button>
      {message !== null && (
        <span className="text-xs text-slate-400" role="status">
          {message}
        </span>
      )}
    </div>
  );
}
