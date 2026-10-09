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
import { useTranslations } from "next-intl";

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record["error"] === "string") return record["error"];
  }
  return fallback;
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
  const t = useTranslations("admin.revokeButton");
  const tDialogs = useTranslations("admin.dialogs");
  const tErr = useTranslations("admin.errors");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function runRevoke() {
    const label = userEmail.length > 0 ? userEmail : userId;
    if (
      !window.confirm(tDialogs("revokeConfirmPattern", { label }))
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

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => void runRevoke()}
        title={t("revokeTitlePattern", { label: userEmail.length > 0 ? userEmail : userId })}
        className="text-xs px-2 py-1 rounded-lg border border-red-500/30 text-red-300 hover:bg-red-500/10 transition-colors disabled:opacity-50"
      >
        {pending ? "…" : t("revoke")}
      </button>
      {message !== null && (
        <span className="text-xs text-slate-400" role="status">
          {message}
        </span>
      )}
    </span>
  );
}
