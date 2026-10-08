"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { stripLocale, type AppLocale } from "@/lib/i18n-path";

export function resolveHtmlLocale(pathname: string | null): AppLocale {
  return stripLocale(pathname ?? "/").locale ?? "en";
}

export default function HtmlLocaleSync() {
  const pathname = usePathname();
  useEffect(() => {
    const l = resolveHtmlLocale(pathname);
    document.documentElement.lang = l;
    document.documentElement.dir = l === "ar" ? "rtl" : "ltr";
  }, [pathname]);
  return null;
}
