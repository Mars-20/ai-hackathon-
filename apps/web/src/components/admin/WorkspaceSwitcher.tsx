// ─────────────────────────────────────────────────────────────────────────────
// WorkspaceSwitcher — client island for navigating between workspaces
// (spec §7: workspace-tier callers see only their own workspaces; the list
// is scoped server-side by GET /api/admin/workspaces, so the options here
// can never leak cross-workspace rows). A <select> needs browser state,
// hence a client component; the options themselves arrive as props from
// the server page (no client-side Supabase reads, no secrets).
// ─────────────────────────────────────────────────────────────────────────────
"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { stripLocale, withLocale } from "@/lib/i18n-path";

export interface SwitcherWorkspace {
  id: string;
  name: string;
  slug: string;
}

interface WorkspaceSwitcherProps {
  workspaces: SwitcherWorkspace[];
  currentId: string | null;
}

export default function WorkspaceSwitcher({
  workspaces,
  currentId,
}: WorkspaceSwitcherProps) {
  const router = useRouter();
  const t = useTranslations("admin.workspaceSwitcher");
  // i18n Task 3: locale from pathname (this island renders under [locale]
  // pages; stripLocale falls back to "en" for unprefixed paths).
  const pathname = usePathname();
  const wsLocale = stripLocale(pathname ?? "/").locale ?? "en";

  if (workspaces.length === 0) return null;

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-slate-500 text-xs font-medium uppercase tracking-wider">
        {t("label")}
      </span>
      <select
        value={currentId ?? ""}
        onChange={(e) => {
          const id = e.target.value;
          if (id.length > 0) router.push(withLocale(`/admin/workspaces/${encodeURIComponent(id)}`, wsLocale));
        }}
        className="glass rounded-xl px-3 py-2 text-sm text-slate-200 outline-none border border-white/5 bg-transparent max-w-64"
        aria-label={t("switchAria")}
      >
        {currentId === null && <option value="">{t("selectPlaceholder")}</option>}
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name.length > 0 ? w.name : w.slug}
          </option>
        ))}
      </select>
    </label>
  );
}
