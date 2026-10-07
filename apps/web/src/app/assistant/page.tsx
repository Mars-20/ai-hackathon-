import Link from "next/link";
import { ArrowLeft, Brain } from "lucide-react";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import AssistantView from "./AssistantView";
import "./assistant.css";

// Server page: auth is enforced by middleware; SSR fetches the first 20
// threads so the client never waits on an empty shell (D9 payload cap).

export const metadata = {
  title: "المساعد | Validation Copilot",
};

export default async function AssistantPage() {
  let initialThreads: Array<{ id: string; title: string | null; created_at: string }> = [];
  try {
    const supabase = await createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { data } = (await supabase
        .from("assistant_conversations")
        .select("id,title,updated_at")
        .eq("user_id", user.id)
        .order("updated_at", { ascending: false })
        .limit(20)) as unknown as {
        data: Array<{ id: string; title: string | null; updated_at: string }> | null;
      };
      initialThreads = (data ?? []).map((t) => ({
        id: t.id,
        title: t.title,
        created_at: t.updated_at,
      }));
    }
  } catch {
    // client revalidates on mount; SSR degrades to an empty list
  }

  return (
    <div dir="rtl" className="min-h-dvh flex flex-col">
      <header className="glass border-b border-white/5 sticky top-0 z-40 safe-top">
        <div className="container-app h-14 flex items-center gap-4">
          <Link href="/dashboard" className="flex items-center gap-2 text-slate-400 hover:text-slate-200 transition-colors">
            <ArrowLeft className="w-4 h-4 rtl:rotate-180" />
            <Brain className="w-5 h-5 text-brand-400" />
            <span className="font-bold text-sm">
              المساعد <span className="gradient-text">الذكي</span>
            </span>
          </Link>
        </div>
      </header>
      <main className="container-app flex-1 py-6">
        <AssistantView initialThreads={initialThreads} />
      </main>
    </div>
  );
}
