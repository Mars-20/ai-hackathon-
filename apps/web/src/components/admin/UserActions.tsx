// ─────────────────────────────────────────────────────────────────────────────
// UserActions — the single client island on /admin/users. Everything else
// on the page is server-rendered; interactivity (suspend/unsuspend confirm
// dialog + reason field, role change) needs browser state, so it lives
// here. Calls only same-origin /api/admin/* routes — no keys or secrets
// touch the client. Server responses are authoritative (self-suspend 400,
// last-platform-admin 409 surface as messages).
// ─────────────────────────────────────────────────────────────────────────────
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface UserWorkspaceBrief {
  workspace_id: string;
  role: string;
}

interface UserActionsProps {
  userId: string;
  email: string;
  status: "active" | "suspended";
  workspaces: { id: string; name: string; slug: string }[];
}

const ROLES = ["owner", "admin", "member", "viewer"] as const;

function errorMessage(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record["error"] === "string") return record["error"];
  }
  return "Request failed";
}

export default function UserActions({
  userId,
  email,
  status,
  workspaces,
}: UserActionsProps) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [roleOpen, setRoleOpen] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("member");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function runSuspend(suspend: boolean) {
    setPending(true);
    setMessage(null);
    try {
      const res = await fetch(
        `/api/admin/users/${encodeURIComponent(userId)}/${suspend ? "suspend" : "unsuspend"}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            reason.trim().length > 0 ? { reason: reason.trim() } : {},
          ),
        },
      );
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setMessage(errorMessage(body));
        return;
      }
      setConfirmOpen(false);
      setReason("");
      router.refresh();
    } catch {
      setMessage("Network error — please retry");
    } finally {
      setPending(false);
    }
  }

  async function runRoleChange() {
    if (workspaceId.trim().length === 0) {
      setMessage("Workspace is required");
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      const res = await fetch(
        `/api/admin/users/${encodeURIComponent(userId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workspace_id: workspaceId.trim(),
            role,
            ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}),
          }),
        },
      );
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        setMessage(errorMessage(body));
        return;
      }
      setRoleOpen(false);
      setReason("");
      router.refresh();
    } catch {
      setMessage("Network error — please retry");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 min-w-44">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setConfirmOpen((open) => !open);
            setMessage(null);
          }}
          className={`text-xs px-2 py-1 rounded-lg border transition-colors ${
            status === "suspended"
              ? "border-green-500/30 text-green-400 hover:bg-green-500/10"
              : "border-red-500/30 text-red-400 hover:bg-red-500/10"
          }`}
        >
          {status === "suspended" ? "Unsuspend" : "Suspend"}
        </button>
        <button
          type="button"
          onClick={() => {
            setRoleOpen((open) => !open);
            setMessage(null);
          }}
          className="text-xs px-2 py-1 rounded-lg border border-white/10 text-slate-300 hover:bg-white/5 transition-colors"
        >
          Role
        </button>
      </div>

      {confirmOpen && (
        <div className="glass rounded-xl p-3 border border-white/10 space-y-2">
          <p className="text-xs text-slate-400">
            {status === "suspended" ? "Unsuspend" : "Suspend"} {email}?{" "}
            {status === "active" && "Takes full effect within ~1 hour."}
          </p>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (recorded in audit log)"
            rows={2}
            className="w-full glass rounded-lg px-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 outline-none border border-white/5 focus:border-brand-500/50 bg-transparent"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => void runSuspend(status !== "suspended")}
              className="text-xs px-2 py-1 rounded-lg bg-red-500/20 text-red-300 border border-red-500/30 disabled:opacity-50"
            >
              {pending ? "Working..." : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="text-xs px-2 py-1 rounded-lg text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {roleOpen && (
        <div className="glass rounded-xl p-3 border border-white/10 space-y-2">
          {workspaces.length > 0 ? (
            <select
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              className="w-full glass rounded-lg px-2 py-1.5 text-xs text-slate-200 outline-none border border-white/5 bg-transparent"
              aria-label="Workspace"
            >
              <option value="">Select workspace…</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name.length > 0 ? w.name : w.slug} ({w.id.slice(0, 8)}…)
                </option>
              ))}
            </select>
          ) : (
            <input
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
              placeholder="Workspace ID"
              className="w-full glass rounded-lg px-2 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 outline-none border border-white/5 focus:border-brand-500/50 bg-transparent"
            />
          )}
          <select
            value={role}
            onChange={(e) =>
              setRole(e.target.value as (typeof ROLES)[number])
            }
            className="w-full glass rounded-lg px-2 py-1.5 text-xs text-slate-200 outline-none border border-white/5 bg-transparent"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => void runRoleChange()}
              className="text-xs px-2 py-1 rounded-lg bg-brand-500/20 text-brand-300 border border-brand-500/30 disabled:opacity-50"
            >
              {pending ? "Working..." : "Apply"}
            </button>
            <button
              type="button"
              onClick={() => setRoleOpen(false)}
              className="text-xs px-2 py-1 rounded-lg text-slate-400 hover:text-slate-200"
            >
              Cancel
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
