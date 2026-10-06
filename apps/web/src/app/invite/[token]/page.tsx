"use client";

// ─────────────────────────────────────────────────────────────────────────────
// /invite/[token] — token invite accept/decline page (Task 6)
// - Accept/Decline via PATCH /api/workspace/invite (invite looked up by ID +
//   auth-email gate server-side; the URL token is passed as invite_id).
// - Pending gate: decided invites (400) are terminal — buttons disable.
// - Expired invites surface the 410 explicitly.
// - Single-use: after accept/decline the UI locks (no second submit).
// - The token is credential-equivalent: it is NEVER logged, never rendered,
//   and never echoed in error text.
// - Email delivery wiring (Resend, Task 6 pick) is out of scope in v1.
// ─────────────────────────────────────────────────────────────────────────────

import { use, useState } from "react";

type Phase = "idle" | "working" | "accepted" | "declined" | "expired" | "error";

export default function InviteTokenPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [phase, setPhase] = useState<Phase>("idle");
  const [detail, setDetail] = useState<string | null>(null);

  const terminal = phase === "accepted" || phase === "declined" || phase === "expired";

  async function act(action: "accept" | "decline") {
    if (phase === "working" || terminal) return;
    setPhase("working");
    setDetail(null);
    let res: Response;
    try {
      // No token in logs — fetch only.
      res = await fetch("/api/workspace/invite", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invite_id: token, action }),
      });
    } catch {
      setPhase("error");
      setDetail("Network error. Please try again.");
      return;
    }
    if (res.status === 410) {
      setPhase("expired");
      return;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      setPhase("error");
      // Server error text contains no token material (route strips it).
      setDetail(typeof body?.error === "string" ? body.error : "Request failed.");
      return;
    }
    setPhase(action === "accept" ? "accepted" : "declined");
  }

  return (
    <div className="min-h-dvh flex items-center justify-center px-4">
      <div className="w-full max-w-md glass rounded-3xl p-8 border border-white/10 text-center">
        <h1 className="font-black text-xl tracking-tight mb-2">Workspace invite</h1>
        {phase === "accepted" && (
          <p className="text-sm text-green-300" id="invite-result">Invite accepted — welcome aboard.</p>
        )}
        {phase === "declined" && (
          <p className="text-sm text-slate-300" id="invite-result">Invite declined.</p>
        )}
        {phase === "expired" && (
          <p className="text-sm text-amber-300" id="invite-result">
            This invite has expired (410). Ask a workspace admin to resend it.
          </p>
        )}
        {phase === "error" && (
          <p className="text-sm text-red-300" id="invite-result">{detail ?? "Request failed."}</p>
        )}
        {!terminal && (
          <>
            <p className="text-sm text-slate-400 mb-6">
              You have been invited to join a workspace. Accept or decline below.
              Each invite can be used once.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => act("accept")}
                disabled={phase === "working"}
                className="btn-glow text-white font-bold py-3 rounded-xl text-sm disabled:opacity-50"
                id="invite-accept-btn"
              >
                {phase === "working" ? "Working…" : "Accept"}
              </button>
              <button
                onClick={() => act("decline")}
                disabled={phase === "working"}
                className="glass glass-hover rounded-xl py-3 text-sm font-medium text-slate-300 border border-white/5 disabled:opacity-50"
                id="invite-decline-btn"
              >
                Decline
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
