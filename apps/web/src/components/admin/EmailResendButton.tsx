// ─────────────────────────────────────────────────────────────────────────────
// EmailResendButton — platform-only invite-resend island for the ops page
// (POST /api/admin/ops/email is platform-tier only; workspace-tier POSTs
// get 403 with a denied audit trail). Rendered only for the platform tier.
// Same-origin fetch only; invite tokens never touch the client (the API
// never selects them).
// ─────────────────────────────────────────────────────────────────────────────
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

interface EmailResendButtonProps {
  inviteId: string;
  inviteEmail: string;
}

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record["error"] === "string") return record["error"];
  }
  return fallback;
}

export default function EmailResendButton({
  inviteId,
  inviteEmail,
}: EmailResendButtonProps) {
  const router = useRouter();
  const t = useTranslations("admin.emailResend");
  const tErr = useTranslations("admin.errors");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function runResend() {
    setPending(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/ops/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invite_id: inviteId }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setMessage(errorMessage(body, tErr("requestFailed")));
        return;
      }
      setMessage(t("done"));
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
        onClick={() => void runResend()}
        title={t("resendTitlePattern", { email: inviteEmail })}
        className="text-xs px-2 py-1 rounded-lg border border-white/10 text-slate-300 hover:bg-white/5 transition-colors disabled:opacity-50"
      >
        {pending ? "…" : t("resend")}
      </button>
      {message !== null && (
        <span className="text-xs text-slate-400" role="status">
          {message}
        </span>
      )}
    </span>
  );
}
