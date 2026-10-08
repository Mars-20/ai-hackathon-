import { Suspense } from "react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import { withLocale, type AppLocale } from "@/lib/i18n-path";
import RequestForm from "./request-form";

export const metadata = {
  title: "Plans — Validation Copilot",
  description: "خطط الاشتراك: ابدأ مجانًا ثم ترقَّ عندما تكون جاهزًا.",
};

// Prices/quotas come from public env (Task 7 brief); missing values fall
// back to "—" and quota lines render only when the env var is set.
const PRO_PRICE = process.env.NEXT_PUBLIC_PLAN_PRO_PRICE ?? "—";
const TEAM_PRICE = process.env.NEXT_PUBLIC_PLAN_TEAM_PRICE ?? "—";
const FREE_QUOTA = process.env.NEXT_PUBLIC_PLAN_FREE_QUOTA;
const PRO_QUOTA = process.env.NEXT_PUBLIC_PLAN_PRO_QUOTA;
const TEAM_QUOTA = process.env.NEXT_PUBLIC_PLAN_TEAM_QUOTA;

export default async function PlansPage({
  searchParams,
  params,
}: {
  searchParams: Promise<{ reason?: string }>;
  params: Promise<{ locale: string }>;
}) {
  const { reason } = await searchParams;
  const { locale } = await params;
  const appLocale = locale as AppLocale;
  const t = await getTranslations("nav");
  const showQuotaBanner = reason === "assistant_quota";
  return (
    <div dir="rtl" className="min-h-dvh flex flex-col">
      <header className="glass border-b border-white/5">
        <div className="px-4 sm:px-6 h-14 flex items-center justify-between max-w-5xl mx-auto w-full">
          <Link href={withLocale("/dashboard", appLocale)} className="font-bold text-sm">
            Validation <span className="gradient-text">Copilot</span>
          </Link>
          <div className="flex items-center gap-3">
            <Suspense>
              <LanguageSwitcher locale={appLocale} />
            </Suspense>
            <Link
              href={withLocale("/login", appLocale)}
              className="text-xs text-slate-400 hover:text-slate-200 transition-colors"
            >
              {t("login")}
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-5xl mx-auto px-4 sm:px-6 py-10">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-black text-slate-100 mb-2">خطط الاشتراك</h1>
          <p className="text-sm text-slate-400">
            ابدأ بمشروعك المجاني — وعندما تنتهي التجربة، اختر الخطة المناسبة لفريقك.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {/* Free */}
          <div className="glass rounded-2xl p-6 border border-white/5 flex flex-col">
            <h2 className="font-bold text-slate-100 mb-1">المجانية</h2>
            <p className="text-xs text-slate-400 mb-4">مشروع واحد — للمستخدمين الجدد</p>
            <div className="text-3xl font-black text-slate-100 mb-4">
              مجانًا
            </div>
            {FREE_QUOTA && (
              <p className="text-xs text-slate-500 mb-4">{FREE_QUOTA}</p>
            )}
            <Link
              href={withLocale("/login", appLocale)}
              className="mt-auto glass glass-hover text-center text-sm font-semibold px-4 py-2.5 rounded-xl text-slate-200 border border-white/5"
            >
              {t("login")}
            </Link>
          </div>

          {/* Pro */}
          <div className="glass rounded-2xl p-6 border border-brand-500/30 flex flex-col">
            <h2 className="font-bold text-slate-100 mb-1">Pro</h2>
            <p className="text-xs text-slate-400 mb-4">للمؤسسين الأفراد والفرق الصغيرة</p>
            <div className="text-3xl font-black text-brand-400 mb-4">
              {PRO_PRICE}
            </div>
            {PRO_QUOTA && (
              <p className="text-xs text-slate-500 mb-4">{PRO_QUOTA}</p>
            )}
            <a
              href="#request-form"
              className="mt-auto btn-glow text-center text-white text-sm font-bold px-4 py-2.5 rounded-xl"
            >
              اشترك في Pro
            </a>
          </div>

          {/* Team */}
          <div className="glass rounded-2xl p-6 border border-white/5 flex flex-col">
            <h2 className="font-bold text-slate-100 mb-1">Team</h2>
            <p className="text-xs text-slate-400 mb-4">لفرق العمل والمؤسسات</p>
            <div className="text-3xl font-black text-slate-100 mb-4">
              {TEAM_PRICE}
            </div>
            {TEAM_QUOTA && (
              <p className="text-xs text-slate-500 mb-4">{TEAM_QUOTA}</p>
            )}
            <a
              href="#request-form"
              className="mt-auto glass glass-hover text-center text-sm font-semibold px-4 py-2.5 rounded-xl text-slate-200 border border-white/5"
            >
              اشترك في Team
            </a>
          </div>
        </div>

        {showQuotaBanner && (
          <div
            role="alert"
            className="glass rounded-2xl p-4 mb-6 border border-amber-400/30 text-center"
          >
            <p className="text-sm font-bold text-amber-200">
              انتهت حصتك اليومية من رسائل المساعد
            </p>
            <p className="text-xs text-slate-400 mt-1">
              تعود الحصة تلقائيًا عند منتصف الليل (UTC) — أو راسلنا بالأسفل
              لترقية خطتك إلى حصة أعلى.
            </p>
          </div>
        )}

        <div id="request-form" className="mt-10 scroll-mt-20">
          <RequestForm />
        </div>
      </main>
    </div>
  );
}
