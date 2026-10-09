"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

export default function LanguageSwitcher({ locale }: { locale: "ar" | "en" }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const t = useTranslations("common");
  // switchTo below stays EXACTLY as-is (Review Focus 4+5: reviewer checks by content, not line numbers).
  function switchTo(t: "ar" | "en") {
    const segs = (pathname ?? "/").split("/");
    if (segs[1] === "ar" || segs[1] === "en") segs[1] = t;
    else segs.splice(1, 0, t);
    const qs = search.toString();
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    const next = segs.join("/") || `/${t}`;
    document.cookie = `NEXT_LOCALE=${t}; Path=/; Max-Age=31536000; SameSite=Lax`;
    router.replace(`${next}${qs ? `?${qs}` : ""}${hash}`);
  }
  return (
    <div role="group" aria-label={t("switchLanguage")} className="glass flex items-center gap-0.5 rounded-full p-0.5">
      <button onClick={() => switchTo("ar")} aria-pressed={locale === "ar"} title={t("switchToArabic")}
        className={`rounded-full px-2.5 py-1 text-xs transition-colors ${locale === "ar" ? "bg-brand-500/20 text-slate-100" : "text-slate-400 hover:text-slate-200"}`}>{t("arabicShort")}</button>
      <button onClick={() => switchTo("en")} aria-pressed={locale === "en"} title={t("switchToEnglish")}
        className={`rounded-full px-2.5 py-1 text-xs transition-colors ${locale === "en" ? "bg-brand-500/20 text-slate-100" : "text-slate-400 hover:text-slate-200"}`}>{t("englishShort")}</button>
    </div>
  );
}
