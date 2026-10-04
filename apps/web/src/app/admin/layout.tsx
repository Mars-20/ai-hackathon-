// ─────────────────────────────────────────────────────────────────────────────
// /admin layout — server-rendered nav shell (spec §2). The redirect for
// non-admins is UX only; requireAdmin() inside each /api/admin/* route is
// the authoritative gate. Tier comes from the cached DAL gate
// getCachedAdminContext() (React-cache()d requireAdminFromSupabase) —
// zero self-HTTP from layout code. Ops (audit/settings/grants) is
// platform-only per the §7 matrix and hidden from the workspace tier; the
// remaining links stay visible because workspace admin/owner tiers hold
// read or scoped write rights there. All Task 7 pages are live.
// ─────────────────────────────────────────────────────────────────────────────
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getCachedAdminContext } from "@/lib/admin-dal";

interface NavItem {
  href: string;
  label: string;
  platformOnly: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/admin", label: "Overview", platformOnly: false },
  { href: "/admin/users", label: "Users", platformOnly: false },
  { href: "/admin/workspaces", label: "Workspaces", platformOnly: false },
  { href: "/admin/content", label: "Content", platformOnly: false },
  { href: "/admin/analytics", label: "Analytics", platformOnly: false },
  { href: "/admin/ops", label: "Ops", platformOnly: true },
];

async function resolveTier(): Promise<"platform" | "workspace"> {
  try {
    const ctx = await getCachedAdminContext();
    return ctx.tier === "platform" ? "platform" : "workspace";
  } catch {
    redirect("/login");
  }
}

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const tier = await resolveTier();

  const items = NAV_ITEMS.filter(
    (item) => !item.platformOnly || tier === "platform",
  );

  return (
    <div className="min-h-screen">
      <header className="fixed top-0 left-0 right-0 z-50 glass border-b border-white/5">
        <div className="container-app flex items-center justify-between h-14">
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="font-bold text-sm tracking-tight">
              Validation <span className="gradient-text">Copilot</span>
            </Link>
            <span className="text-slate-600 text-sm hidden sm:block">/</span>
            <span className="text-slate-400 text-sm font-medium">Admin</span>
          </div>
          <span className="text-xs px-2 py-0.5 rounded-full border border-white/10 text-slate-400">
            {tier === "platform" ? "Platform admin" : "Workspace admin"}
          </span>
        </div>
      </header>

      <div className="pt-14 flex">
        <nav
          aria-label="Admin sections"
          className="w-48 shrink-0 min-h-[calc(100vh-3.5rem)] border-r border-white/5 p-4 space-y-1"
        >
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block px-3 py-2 rounded-xl text-sm text-slate-300 hover:bg-white/5 hover:text-brand-400 transition-colors"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <main className="flex-1 min-w-0 px-6 py-8">
          <div className="max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
