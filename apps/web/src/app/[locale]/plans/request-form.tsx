"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { withLocale, type AppLocale } from "@/lib/i18n-path";

type Entitlement = {
  status?: string;
  plan?: string | null;
  trial_startup_id?: string | null;
  frozen_startup_ids?: string[];
};

type Plan = "pro" | "team";

export default function RequestForm() {
  const locale = useLocale() as AppLocale;
  const tReq = useTranslations("plans.requestForm");
  const [ent, setEnt] = useState<Entitlement | null>(null);
  const [entChecked, setEntChecked] = useState(false);
  const [plan, setPlan] = useState<Plan>("pro");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [company, setCompany] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<{
    full_name?: string;
    phone?: string;
    form?: string;
  }>({});
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  // Fresh entitlement read on every mount (no cross-navigation caching):
  // subscribed users see their current plan instead of the request form.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/entitlements/me", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as Entitlement;
        if (!cancelled) setEnt(body);
      } catch {
        /* offline / anon — fall through to the marketing view */
      } finally {
        if (!cancelled) setEntChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const nextErrors: typeof errors = {};
    if (fullName.trim().length < 2) nextErrors.full_name = tReq("nameError");
    if (phone.trim().length < 6) nextErrors.phone = tReq("phoneError");
    setErrors(nextErrors);
    if (nextErrors.full_name || nextErrors.phone) return;

    setSubmitting(true);
    try {
      const payload: Record<string, string> = {
        plan,
        full_name: fullName.trim(),
        phone: phone.trim(),
      };
      if (company.trim()) payload.company = company.trim();
      if (notes.trim()) payload.notes = notes.trim();
      const res = await fetch("/api/subscription-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.status === 201) {
        setDone(true);
        setErrors({});
        return;
      }
      if (res.status === 409) {
        setErrors({ form: tReq("duplicateMessage") });
        return;
      }
      if (res.status === 401) {
        setErrors({ form: tReq("requiredLogin") });
        return;
      }
      setErrors({ form: tReq("genericError") });
    } catch {
      setErrors({ form: tReq("genericError") });
    } finally {
      setSubmitting(false);
    }
  }

  if (!entChecked) {
    return (
      <div className="glass rounded-2xl p-6 border border-white/5 text-center">
        <p className="text-sm text-slate-500">{tReq("loading")}</p>
      </div>
    );
  }

  if (ent?.status === "subscribed") {
    return (
      <div
        dir={locale === "ar" ? "rtl" : "ltr"}
        className="glass rounded-2xl p-6 border border-green-500/20 text-center"
      >
        <p className="text-sm font-semibold text-slate-200">
          {tReq("subscribedLine", { plan: ent.plan === "team" ? "Team" : "Pro" })}
        </p>
        <Link
          href={withLocale("/dashboard", locale)}
          className="inline-block mt-3 text-xs text-brand-400 hover:text-brand-300"
        >
          {tReq("backToDashboard")}
        </Link>
      </div>
    );
  }

  if (done) {
    return (
      <div
        dir={locale === "ar" ? "rtl" : "ltr"}
        role="status"
        className="glass rounded-2xl p-6 border border-green-500/20 text-center"
      >
        <p className="text-sm font-semibold text-green-400">{tReq("successMessage")}</p>
      </div>
    );
  }

  return (
    <div dir={locale === "ar" ? "rtl" : "ltr"} className="glass rounded-2xl p-6 border border-white/5">
      <h2 className="font-bold text-slate-100 mb-1">{tReq("title")}</h2>
      <p className="text-xs text-slate-400 mb-5">
        {tReq("sub")}
      </p>

      {/* Plan picker */}
      <div className="grid grid-cols-2 gap-2 mb-5" role="group" aria-label={tReq("planPickerAria")}>
        {(["pro", "team"] as Plan[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPlan(p)}
            aria-pressed={plan === p}
            className={`py-2.5 rounded-xl text-sm font-bold border transition-all ${
              plan === p
                ? "bg-brand-500/20 text-brand-300 border-brand-500/40"
                : "border-white/5 text-slate-500 hover:bg-white/5"
            }`}
          >
            {p === "pro" ? "Pro" : "Team"}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <label htmlFor="req-full-name" className="text-xs font-semibold text-slate-400 mb-1.5 block">
            {tReq("nameLabel")}
          </label>
          <input
            id="req-full-name"
            type="text"
            autoComplete="name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-slate-200 placeholder:text-slate-500 outline-none focus:border-brand-500/50 transition-colors"
            placeholder={tReq("namePlaceholder")}
          />
          {errors.full_name && (
            <p className="text-xs text-red-400 mt-1">{errors.full_name}</p>
          )}
        </div>

        <div>
          <label htmlFor="req-phone" className="text-xs font-semibold text-slate-400 mb-1.5 block">
            {tReq("phoneLabel")}
          </label>
          <input
            id="req-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-slate-200 placeholder:text-slate-500 outline-none focus:border-brand-500/50 transition-colors"
            placeholder={tReq("phonePlaceholder")}
          />
          {errors.phone && (
            <p className="text-xs text-red-400 mt-1">{errors.phone}</p>
          )}
        </div>

        <div>
          <label htmlFor="req-company" className="text-xs font-semibold text-slate-400 mb-1.5 block">
            {tReq("companyLabel")} <span className="text-slate-600">{tReq("optionalSuffix")}</span>
          </label>
          <input
            id="req-company"
            type="text"
            autoComplete="organization"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-slate-200 placeholder:text-slate-500 outline-none focus:border-brand-500/50 transition-colors"
            placeholder={tReq("companyPlaceholder")}
          />
        </div>

        <div>
          <label htmlFor="req-notes" className="text-xs font-semibold text-slate-400 mb-1.5 block">
            {tReq("notesLabel")} <span className="text-slate-600">{tReq("optionalSuffix")}</span>
          </label>
          <textarea
            id="req-notes"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-slate-200 placeholder:text-slate-500 outline-none focus:border-brand-500/50 resize-none transition-colors"
            placeholder={tReq("notesPlaceholder")}
          />
        </div>

        {errors.form && (
          <p role="alert" className="text-xs text-red-400 p-3 glass rounded-xl border border-red-500/20">
            {errors.form}
            {errors.form === tReq("requiredLogin") && (
              <>
                {" — "}
                <Link href={withLocale("/login", locale)} className="underline text-brand-400">
                  {tReq("loginCta")}
                </Link>
              </>
            )}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full btn-glow text-white font-bold py-3 rounded-xl text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? tReq("submitting") : tReq("submit")}
        </button>
      </form>
    </div>
  );
}
