// ─────────────────────────────────────────────────────────────────────────────
// PlatformAdminRevokeButton — platform-only revoke island for the ops page
// (DELETE /api/admin/ops/admins is platform-tier only; workspace-tier
// DELETEs get 403 with a denied audit trail; revoking the last platform
// admin gets 409). Rendered only for the platform tier. Revocation requires
// an explicit confirm dialog. Same-origin fetch only.
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

interface PlatformAdminRevokeButtonProps {
  userId: string;
  userEmail: string;
}

export default function PlatformAdminRevokeButton({
  userId,
  userEmail,
}: PlatformAdminRevokeButtonProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function runRevoke() {
    const label = userEmail.length > 0 ? userEmail : userId;
    if (
      !window.confirm(`Revoke platform admin for ${label}? This is audited.`)
    ) {
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/ops/admins", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setMessage(errorMessage(body));
        return;
      }
      router.refresh();
    } catch {
      setMessage("Network error — please retry");
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => void runRevoke()}
        title={`Revoke platform admin ${userEmail.length > 0 ? userEmail : userId}`}
        className="text-xs px-2 py-1 rounded-lg border border-red-500/30 text-red-300 hover:bg-red-500/10 transition-colors disabled:opacity-50"
      >
        {pending ? "…" : "Revoke"}
      </button>
      {message !== null && (
        <span className="text-xs text-slate-400" role="status">
          {message}
        </span>
      )}
    </span>
  );
}
