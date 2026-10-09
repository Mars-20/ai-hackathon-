"use client";

// Floating assistant widget (F16). Rendered on every page via RootLayout;
// self-hides for anonymous visitors (nav-hidden rule) and when the user
// disables it in prefs. While expanded the page body is inert (bef
// body-inert rule): background is non-interactive until the widget closes.

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { NextIntlClientProvider, useLocale, useTranslations } from "next-intl";
import { MessageCircle, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { stripLocale } from "@/lib/i18n-path";
import arMessages from "../../messages/ar.json";
import enMessages from "../../messages/en.json";
import { useAssistantFloatPref } from "./useAssistantFloatPref";

const EmbeddedPanel = dynamic(() => import("@/app/[locale]/assistant/AssistantPanel"), {
  ssr: false,
  loading: () => <FloatLoading />,
});

function FloatLoading() {
  const tAsst = useTranslations("assistant");
  return <p className="text-slate-500 text-xs shimmer p-4">{tAsst("view.loading")}</p>;
}

export default function AssistantFloatProvider() {
  const [loggedIn, setLoggedIn] = useState(false);
  const { open, setOpen, enabled, ready } = useAssistantFloatPref(loggedIn);

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

  if (!ready || !loggedIn || !enabled) return null;

  // This widget renders via RootLayout — OUTSIDE the [locale]
  // NextIntlClientProvider — so it brings its own assistant+shared messages,
  // resolved from the pathname (same stripLocale discipline as
  // AssistantPanel). AssistantPanel consumes both namespaces (assistant.* +
  // shared.misc.conversation fallback); a missing namespace throws
  // MISSING_MESSAGE at useTranslations, so both must be provided here.
  // CitationChip keeps plain useTranslations.
  const floatLocale = stripLocale(pathname ?? "/").locale ?? "en";
  return (
    <NextIntlClientProvider
      locale={floatLocale}
      messages={
        floatLocale === "ar"
          ? { assistant: arMessages.assistant, shared: arMessages.shared }
          : { assistant: enMessages.assistant, shared: enMessages.shared }
      }
    >
      <FloatWidget open={open} setOpen={setOpen} />
    </NextIntlClientProvider>
  );
}

function FloatWidget({ open, setOpen }: { open: boolean; setOpen: (next: boolean) => void }) {
  const tAsst = useTranslations("assistant");
  const locale = useLocale();
  const closeRef = useRef<HTMLButtonElement>(null);

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

  return (
    <div dir={locale === "ar" ? "rtl" : "ltr"} data-assistant-float>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={tAsst("page.headerTitle")}
          className="assistant-float-panel glass border border-white/10 p-4"
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-bold text-slate-200">{tAsst("page.headerTitle")}</span>
            <button
              ref={closeRef}
              onClick={() => setOpen(false)}
              aria-label={tAsst("hints.closeAria")}
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
          aria-label={tAsst("page.headerTitle")}
          title={tAsst("page.headerTitle")}
          className="assistant-float-btn"
        >
          <MessageCircle className="w-5 h-5" />
        </button>
      )}
    </div>
  );
}
