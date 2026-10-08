"use client";

// Floating assistant widget (F16). Rendered on every page via RootLayout;
// self-hides for anonymous visitors (nav-hidden rule) and when the user
// disables it in prefs. While expanded the page body is inert (bef
// body-inert rule): background is non-interactive until the widget closes.

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { MessageCircle, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAssistantFloatPref } from "./useAssistantFloatPref";

const EmbeddedPanel = dynamic(() => import("@/app/assistant/AssistantPanel"), {
  ssr: false,
  loading: () => (
    <p className="text-slate-500 text-xs shimmer p-4">جارٍ تحميل المساعد…</p>
  ),
});

export default function AssistantFloatProvider() {
  const [loggedIn, setLoggedIn] = useState(false);
  const { open, setOpen, enabled, ready } = useAssistantFloatPref(loggedIn);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Session is re-evaluated on auth changes AND on every route change, not
  // just on mount: login does router.push (no reload), and each
  // createBrowserClient instance only emits auth events for its own
  // sign-in — a mount-only snapshot would hide the widget until the next
  // full refresh.
  const pathname = usePathname();
  useEffect(() => {
    let cancelled = false;
    const client = createClient();
    void client.auth
      .getSession()
      .then(({ data }) => {
        if (!cancelled) setLoggedIn(!!data.session?.user);
      })
      .catch(() => {});
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((_event, session) => {
      if (!cancelled) setLoggedIn(!!session?.user);
    });
    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [pathname]);

  // Page-inert while expanded (bef body-inert rule): every body child
  // except this widget becomes non-interactive. body.inert itself is
  // unusable here — the panel lives inside <body> and would freeze too.
  useEffect(() => {
    if (!open) return;
    const siblings = Array.from(document.body.children).filter(
      (el) => !(el as HTMLElement).dataset?.assistantFloat
    );
    const prev = siblings.map((el) => (el as HTMLElement).inert);
    siblings.forEach((el) => {
      (el as HTMLElement).inert = true;
    });
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      siblings.forEach((el, i) => {
        (el as HTMLElement).inert = prev[i];
      });
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  if (!ready || !loggedIn || !enabled) return null;

  return (
    <div dir="rtl" data-assistant-float>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="المساعد الذكي"
          className="assistant-float-panel glass border border-white/10 p-4"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-bold text-slate-200">المساعد الذكي</span>
            <button
              ref={closeRef}
              onClick={() => setOpen(false)}
              aria-label="إغلاق المساعد"
              className="text-slate-500 hover:text-slate-200"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <EmbeddedPanel embedded />
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          aria-label="فتح المساعد الذكي"
          title="المساعد الذكي"
          className="assistant-float-btn"
        >
          <MessageCircle className="w-5 h-5" />
        </button>
      )}
    </div>
  );
}
