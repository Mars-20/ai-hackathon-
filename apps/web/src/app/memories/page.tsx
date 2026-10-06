// Memories console (Task 9, review #1): the server page reads straight from
// the DAL — no HTTP self-fetch. The old shape built its target from
// x-forwarded-host and forwarded session cookies to it. All Arabic copy
// comes from MEMORY_COPY — no inline Arabic strings in this directory.

import { redirect } from "next/navigation";
import Link from "next/link";
import { Brain } from "lucide-react";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { CompanionError, getCompanionProfile, listMemories } from "@/lib/companion/dal";
import { MEMORY_COPY } from "@/lib/companion/copy";
import MemoriesClient, { type MemoryItem } from "./memories-client";

// Paywall denials render the plans CTA instead of the console (review #11):
// previously every non-401 (including 402s) fell through to an empty queue.
const PAYWALL_CODES = new Set(["TRIAL_CONSUMED", "SUBSCRIPTION_REQUIRED", "ACCOUNT_PAUSED"]);

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div dir="rtl" className="min-h-dvh safe-top">
      <header className="glass border-b border-white/5 sticky top-0 z-40 safe-top">
        <div className="container-app h-14 flex items-center gap-4">
          <Link
            href="/dashboard"
            aria-label="Back to dashboard"
            className="glass glass-hover flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-slate-300 border border-white/5"
          >
            Dashboard
          </Link>
          <h1 className="font-bold text-slate-200 text-sm flex items-center gap-2">
            <Brain className="w-4 h-4 text-brand-400" />
            {MEMORY_COPY.page_title}
          </h1>
        </div>
      </header>
      <main className="pt-8 pb-16 px-6">
        <div className="container-app max-w-5xl">{children}</div>
      </main>
    </div>
  );
}

export default async function MemoriesPage() {
  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/login");
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
      <Shell>
        <MemoriesClient initialItems={items} initialEnabled={profile.memory_enabled} />
      </Shell>
    );
  } catch (e) {
    if (e instanceof CompanionError && PAYWALL_CODES.has(e.code)) {
      return (
        <Shell>
          <div className="glass rounded-xl p-8 text-center border border-white/5">
            <p className="text-slate-300 text-sm mb-4">Memory is part of a paid plan.</p>
            <Link
              href="/plans"
              className="inline-flex items-center px-4 py-2 rounded-lg text-sm font-semibold bg-brand-500 text-white hover:bg-brand-400"
            >
              View plans
            </Link>
          </div>
        </Shell>
      );
    }
    throw e;
  }
}
