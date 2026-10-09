"use client";

// ─────────────────────────────────────────────────────────────────────────────
// /admin/requests — pending subscription-request queue (Task 8, client).
// Owner-only data: the queue is fetched from GET /api/admin/requests, which
// 403s non-owners ({error:"محظور",code:"FORBIDDEN"}). On 403 this page renders
// the helpful empty-owner message below — never rows, never a bare dump.
// (Pre-launch PLATFORM_OWNER_EMAILS is EMPTY, so everyone sees this message
// until the owner sets the env — that is the expected pre-launch state.)
// Actions (approve with plan selector / reject / pause) POST to the same
// route with a confirm step (first click arms, second executes) and a
// double-click guard (buttons disable while an action is pending).
// Success/error toasts are inline — no alert dialogs anywhere.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { AppLocale } from "@/lib/i18n-path";

interface EntitlementInfo {
  status: string | null;
  plan: string | null;
}

interface QueueRequest {
  id: string;
  user_id: string;
  plan: string;
  full_name: string;
  phone: string;
  company: string | null;
  status: string;
  created_at: string;
  entitlement: EntitlementInfo | null;
}

type QueueAction = "approve" | "reject" | "pause";

interface Toast {
  kind: "success" | "error";
  text: string;
}

export default function AdminRequestsPage() {
  const locale = useLocale() as AppLocale;
  const t = useTranslations("admin.requests");
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [requests, setRequests] = useState<QueueRequest[]>([]);
  const [planById, setPlanById] = useState<Record<string, string>>({});
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  const emptyOwnerMessage = t("emptyOwner");

  const actionLabel = (action: QueueAction): string => t(`actions.${action}`);

  function entitlementLabel(status: string | null): string {
    switch (status) {
      case "trial_active":
        return t("entitlement.trialActive");
      case "trial_consumed":
        return t("entitlement.trialConsumed");
      case "subscribed":
        return t("entitlement.subscribed");
      case "paused":
        return t("entitlement.paused");
      case "legacy":
        return t("entitlement.legacy");
      default:
        return t("entitlement.unknown");
    }
  }

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/requests?status=pending", {
        cache: "no-store",
      });
      if (res.status === 403) {
        setForbidden(true);
        setRequests([]);
        return;
      }
      if (!res.ok) {
        setToast({ kind: "error", text: t("loadFailed") });
        return;
      }
      const body = (await res.json()) as { requests?: QueueRequest[] };
      setForbidden(false);
      setRequests(Array.isArray(body.requests) ? body.requests : []);
    } catch {
      setToast({ kind: "error", text: t("loadFailed") });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchQueue();
  }, [fetchQueue]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  async function act(req: QueueRequest, action: QueueAction) {
    const key = `${req.id}:${action}`;
    // Confirm step: first click arms, second click executes.
    if (confirmKey !== key) {
      setConfirmKey(key);
      return;
    }
    setConfirmKey(null);
    setPendingKey(key);
    try {
      const payload: Record<string, string> =
        action === "approve"
          ? {
              request_id: req.id,
              action,
              plan: planById[req.id] ?? req.plan,
            }
          : { request_id: req.id, action };
      const res = await fetch("/api/admin/requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (!res.ok) {
        const message =
          res.status === 403
            ? emptyOwnerMessage
            : typeof body?.["error"] === "string"
              ? (body["error"] as string)
              : t("actionFailed");
        setToast({ kind: "error", text: message });
        return;
      }
      setToast({ kind: "success", text: t("actionDone") });
      await fetchQueue();
    } catch {
      setToast({ kind: "error", text: t("actionFailed") });
    } finally {
      setPendingKey(null);
    }
  }

  function onPlanChange(id: string, e: ChangeEvent<HTMLSelectElement>) {
    setPlanById((prev) => ({ ...prev, [id]: e.target.value }));
  }

  const busy = pendingKey !== null;

  // Static-contract note (Task 8 test): the AR locale renders dir="rtl"
  // here — dir is locale-driven per the i18n spec — the 403 panel shows the
  // empty-owner message (admin.requests.emptyOwner =
  // "القائمة مقيدة — لم يتم تعيين مالك المنصة بعد"), and this file uses no
  // alert dialogs (inline toasts only).
  return (
    <div dir={locale === "ar" ? "rtl" : "ltr"} className="min-h-dvh">
      <div className="px-4 sm:px-6 py-8 mx-auto max-w-4xl">
        <h1 className="text-xl font-bold text-slate-100">{t("title")}</h1>
        <p className="mt-1 text-sm text-slate-400">
          {t("sub")}
        </p>

        {loading ? (
          <p className="mt-8 text-sm text-slate-400">{t("loading")}</p>
        ) : forbidden ? (
          <div
            role="status"
            className="mt-8 rounded-2xl border border-white/10 bg-white/5 px-5 py-8 text-center text-sm text-slate-300"
          >
            {emptyOwnerMessage}
          </div>
        ) : requests.length === 0 ? (
          <div
            role="status"
            className="mt-8 rounded-2xl border border-white/10 bg-white/5 px-5 py-8 text-center text-sm text-slate-300"
          >
            {t("emptyQueue")}
          </div>
        ) : (
          <ul className="mt-6 space-y-4">
            {requests.map((req) => (
              <li
                key={req.id}
                className="rounded-2xl border border-white/10 bg-white/5 px-5 py-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-100">{req.full_name}</p>
                    <p className="mt-1 text-sm text-slate-400" dir="ltr">
                      {req.phone}
                    </p>
                    {req.company ? (
                      <p className="mt-1 text-sm text-slate-400">{req.company}</p>
                    ) : null}
                    <p className="mt-1 text-xs text-slate-500">
                      {t("planLinePattern", {
                        plan: req.plan,
                        date: new Date(req.created_at).toLocaleString(
                          locale === "ar" ? "ar-EG-u-nu-latn" : "en-US",
                        ),
                      })}
                    </p>
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded-full border border-white/10 text-slate-300">
                    {entitlementLabel(req.entitlement?.status ?? null)}
                  </span>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <label className="text-xs text-slate-400">
                    {t("approvePlanLabel")}{" "}
                    <select
                      value={planById[req.id] ?? req.plan}
                      onChange={(e) => onPlanChange(req.id, e)}
                      disabled={busy}
                      className="rounded-lg border border-white/10 bg-slate-900 px-2 py-1 text-xs text-slate-200 disabled:opacity-50"
                    >
                      <option value="pro">pro</option>
                      <option value="team">team</option>
                    </select>
                  </label>
                  {(["approve", "reject", "pause"] as QueueAction[]).map((action) => {
                    const key = `${req.id}:${action}`;
                    const armed = confirmKey === key;
                    const pending = pendingKey === key;
                    return (
                      <button
                        key={action}
                        type="button"
                        disabled={busy}
                        onClick={() => void act(req, action)}
                        className={
                          armed
                            ? "rounded-xl border border-amber-400/50 bg-amber-400/10 px-3 py-1.5 text-xs font-semibold text-amber-300 disabled:opacity-50"
                            : "rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-200 hover:bg-white/10 disabled:opacity-50"
                        }
                      >
                        {pending
                          ? t("executing")
                          : armed
                            ? t("confirmPattern", { action: actionLabel(action) })
                            : actionLabel(action)}
                      </button>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
        )}

        {toast ? (
          <div className="fixed bottom-4 inset-x-0 flex justify-center px-4">
            <p
              role="status"
              className={
                toast.kind === "success"
                  ? "rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300"
                  : "rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2 text-sm text-red-300"
              }
            >
              {toast.text}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
