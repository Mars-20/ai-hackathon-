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

const REFRESH_SECONDS = 60;

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function AnalyticsAutoRefresh() {
  const router = useRouter();
  const [lastUpdated, setLastUpdated] = useState(() => new Date());
  const [paused, setPaused] = useState(
    () => typeof document !== "undefined" && document.hidden,
  );
  const [tick, setTick] = useState(0);

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
      Auto-refresh {paused ? "paused (tab hidden)" : "every 60s"} · last
      updated {formatTime(lastUpdated)}
    </p>
  );
}
