"use client";

import Link from "next/link";
import { FlaskConical, ArrowRight, Brain, BookmarkPlus, AlertTriangle } from "lucide-react";
import type { ToolCard } from "@/lib/assistant/types";

// Action cards (§8) built from SSE `tool` events / persisted tool rows:
// run_validation + open_project carry a real /validate deep link; the
// experiment + memory tools render as status tiles (no fabricated URLs).

const ICONS: Record<string, typeof Brain> = {
  save_memory: BookmarkPlus,
  create_experiment: FlaskConical,
  update_experiment: FlaskConical,
  run_validation: Brain,
  open_project: Brain,
};

export function toolCardFromRow(
  toolName: string | null,
  content: string
): ToolCard | null {
  if (!toolName) return null;
  return { tool: toolName, result_summary: content };
}

export default function ActionCards({ cards }: { cards: ToolCard[] }) {
  if (cards.length === 0) return null;
  return (
    <div className="assistant-cards flex flex-col gap-2 mt-2">
      {cards.map((card, i) => {
        const Icon = ICONS[card.tool] ?? Brain;
        const inner = (
          <>
            {card.error ? (
              <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0" />
            ) : (
              <Icon className="w-4 h-4 text-brand-400 shrink-0" />
            )}
            <span className="flex-1 min-w-0 text-xs text-slate-300">
              {card.result_summary}
            </span>
            {card.url && <ArrowRight className="w-3.5 h-3.5 text-slate-500 rtl:rotate-180 shrink-0" />}
          </>
        );
        const cls =
          "rounded-xl px-3 py-2.5 flex items-center gap-2.5 border " +
          (card.error
            ? "glass border-yellow-500/20"
            : "glass glass-hover border-white/5");
        return card.url ? (
          <Link key={`${card.tool}-${i}`} href={card.url} className={cls}>
            {inner}
          </Link>
        ) : (
          <div key={`${card.tool}-${i}`} className={cls}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}
