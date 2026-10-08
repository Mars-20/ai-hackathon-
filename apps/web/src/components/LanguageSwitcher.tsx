"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export default function LanguageSwitcher({ locale }: { locale: "ar" | "en" }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const target = locale === "ar" ? "en" : "ar";
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
    <div role="group" aria-label={locale === "ar" ? "تبديل اللغة" : "Switch language"}>
      <button onClick={() => switchTo("ar")} aria-pressed={locale === "ar"}>العربية</button>
      <button onClick={() => switchTo("en")} aria-pressed={locale === "en"}>English</button>
      <span className="sr-only">{target === "ar" ? "التبديل للعربية" : "Switch to English"}</span>
    </div>
  );
}
