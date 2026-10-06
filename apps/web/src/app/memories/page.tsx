// Memories console (Task 9): server page fetches the queue via
// GET /api/companion/memory?status=all with the request cookies, then hands
// initial state to the interactive client console. All Arabic copy comes
// from MEMORY_COPY — no inline Arabic strings in this directory.

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Brain } from "lucide-react";
import { MEMORY_COPY } from "@/lib/companion/copy";
import MemoriesClient, { type MemoryItem } from "./memories-client";

async function fetchCompanionApi(path: string): Promise<{ status: number; body: unknown }> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const cookieHeader = (await cookies()).toString();
  const res = await fetch(`${proto}://${host}${path}`, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function toItems(body: unknown): MemoryItem[] {
  if (typeof body !== "object" || body === null) return [];
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (r): r is MemoryItem =>
      typeof r === "object" &&
      r !== null &&
      typeof (r as { id?: unknown }).id === "string" &&
      typeof (r as { value?: unknown }).value === "string" &&
      typeof (r as { created_at?: unknown }).created_at === "string" &&
      typeof (r as { kind?: unknown }).kind === "string",
  );
}

export default async function MemoriesPage() {
  const mem = await fetchCompanionApi("/api/companion/memory?status=all&limit=100");
  if (mem.status === 401) redirect("/login");
  const prof = await fetchCompanionApi("/api/companion/profile/toggle");
  const profile =
    typeof prof.body === "object" && prof.body !== null
      ? (prof.body as { memory_enabled?: unknown }).memory_enabled
      : undefined;

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
        <div className="container-app max-w-5xl">
          <MemoriesClient
            initialItems={toItems(mem.body)}
            initialEnabled={typeof profile === "boolean" ? profile : true}
          />
        </div>
      </main>
    </div>
  );
}
