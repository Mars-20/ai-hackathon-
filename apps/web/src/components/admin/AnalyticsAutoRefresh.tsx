// ─────────────────────────────────────────────────────────────────────────────
// AnalyticsAutoRefresh — client island for the analytics page: re-runs the
// server-rendered graphs every 60s via router.refresh() (so charts stay
// server-computed; no client data fetching, no secrets). Refresh pauses
// while the tab is hidden (document.hidden / visibilitychange) and resumes
// on return. Countdown + last-updated label included.
// ─────────────────────────────────────────────────────────────────────────────
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { AppLocale } from "@/lib/i18n-path";

const REFRESH_SECONDS = 60;

function formatTime(date: Date, locale: AppLocale): string {
  return date.toLocaleTimeString(locale === "ar" ? "ar-EG-u-nu-latn" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function AnalyticsAutoRefresh() {
  const router = useRouter();
  const locale = useLocale() as AppLocale;
  const t = useTranslations("admin.autoRefresh");
  // Mount-guarded clock: rendering `new Date()` (or `document.hidden`)
  // during SSR/hydration emits server-clock HTML that the client almost
  // always mismatches (React #418 hydration error on every load). Render a
  // deterministic placeholder until mounted, then start the real clock.
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [paused, setPaused] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setLastUpdated(new Date());
    setPaused(document.hidden);
  }, []);

  useEffect(() => {
    function onVisibility() {
      setPaused(document.hidden);
      if (!document.hidden) setTick((t) => t + 1);
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (paused) return;
    const id = window.setTimeout(() => {
      router.refresh();
      setLastUpdated(new Date());
      setTick((t) => t + 1);
    }, REFRESH_SECONDS * 1000);
    return () => window.clearTimeout(id);
  }, [paused, router, tick]);

  return (
    <p className="text-xs text-slate-500" aria-live="polite">
      {t("prefix")} {paused ? t("pausedNote") : t("intervalNote")} ·{" "}
      {t("updatedNote")} {lastUpdated === null ? "—" : formatTime(lastUpdated, locale)}
    </p>
  );
}
