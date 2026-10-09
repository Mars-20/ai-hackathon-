// Memories console (Task 9, review #1): the server page reads straight from
// the DAL — no HTTP self-fetch. The old shape built its target from
// x-forwarded-host and forwarded session cookies to it. All user-facing copy
// comes from the memories.* namespace (EN mirrors of the MEMORY_COPY ids in
// lib/companion/copy.ts, which stays the read-only AR reference; resolved
// here via getTranslations, in the client console via useTranslations).

import { redirect } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import { Brain } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { CompanionError, getCompanionProfile, listMemories } from "@/lib/companion/dal";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import { withLocale, type AppLocale } from "@/lib/i18n-path";
import MemoriesClient, { type MemoryItem } from "./memories-client";

// Paywall denials render the plans CTA instead of the console (review #11):
// previously every non-401 (including 402s) fell through to an empty queue.
const PAYWALL_CODES = new Set(["TRIAL_CONSUMED", "SUBSCRIPTION_REQUIRED", "ACCOUNT_PAUSED"]);

function Shell({ children, locale, title, backAria, backText }: { children: React.ReactNode; locale: AppLocale; title: string; backAria: string; backText: string }) {
  return (
    <div dir={locale === "ar" ? "rtl" : "ltr"} className="min-h-dvh safe-top">
      <header className="glass border-b border-white/5 sticky top-0 z-40 safe-top">
        <div className="container-app h-14 flex items-center gap-4">
          <Link
            href={withLocale("/dashboard", locale)}
            aria-label={backAria}
            className="glass glass-hover flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-slate-300 border border-white/5"
          >
            {backText}
          </Link>
          <h1 className="font-bold text-slate-200 text-sm flex items-center gap-2">
            <Brain className="w-4 h-4 text-brand-400" />
            {title}
          </h1>
          <div className="ms-auto">
            <Suspense>
              <LanguageSwitcher locale={locale} />
            </Suspense>
          </div>
        </div>
      </header>
      <main className="pt-8 pb-16 px-6">
        <div className="container-app max-w-5xl">{children}</div>
      </main>
    </div>
  );
}

export default async function MemoriesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const appLocale = locale as AppLocale;
  const tMem = await getTranslations("memories");
  const tNav = await getTranslations("nav");
  const tShared = await getTranslations("shared");
  const shellCopy = {
    title: tMem("page_title"),
    backAria: tShared("actions.backToDashboard"),
    backText: tNav("dashboard"),
  };
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect(withLocale("/login", appLocale));
  const userId = data.user.id;

  try {
    const [listed, profile] = await Promise.all([
      listMemories(userId, "all", 100),
      getCompanionProfile(userId),
    ]);
    const items: MemoryItem[] = listed.rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      value: r.value,
      status: r.status ?? null,
      confidence: r.confidence ?? null,
      source_ref: r.source_ref ?? null,
      created_at: r.created_at,
    }));
    return (
      <Shell locale={appLocale} {...shellCopy}>
        <MemoriesClient initialItems={items} initialEnabled={profile.memory_enabled} />
      </Shell>
    );
  } catch (e) {
    if (e instanceof CompanionError && PAYWALL_CODES.has(e.code)) {
      return (
        <Shell locale={appLocale} {...shellCopy}>
          <div className="glass rounded-xl p-8 text-center border border-white/5">
            <p className="text-slate-300 text-sm mb-4">{tMem("paywallTitle")}</p>
            <Link
              href={withLocale("/plans", appLocale)}
              className="inline-flex items-center px-4 py-2 rounded-lg text-sm font-semibold bg-brand-500 text-white hover:bg-brand-400"
            >
              {tMem("paywallCta")}
            </Link>
          </div>
        </Shell>
      );
    }
    throw e;
  }
}
