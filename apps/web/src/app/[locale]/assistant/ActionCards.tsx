"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { FlaskConical, ArrowRight, Brain, BookmarkPlus, AlertTriangle, RotateCcw, Check, Undo2 } from "lucide-react";
import { stripLocale, withLocale } from "@/lib/i18n-path";
import { UNDONE_SUFFIX, shapeToolCard } from "@/lib/assistant/cards";
import type { ToolCard } from "@/lib/assistant/types";

// Action cards (§8) built from SSE `tool` events / persisted tool rows:
// run_validation + open_project carry a real /validate deep link; the
// experiment + memory tools render as status tiles (no fabricated URLs).
//
// Project C: cards are interactive. Failed cards offer Retry, destructive
// proposal cards offer Confirm, and additive memory/experiment cards offer
// Undo — all via POST /api/assistant/tools. The server re-validates
// ownership + args on every call; the panel applies the returned card via
// onCardUpdate so live + persisted views stay in sync.

const ICONS: Record<string, typeof Brain> = {
  save_memory: BookmarkPlus,
  create_experiment: FlaskConical,
  update_experiment: FlaskConical,
  run_validation: Brain,
  open_project: Brain,
};

const UNDOABLE = new Set(["save_memory", "create_experiment"]);

type CardAction = "retry" | "confirm" | "undo";

export function toolCardFromRow(
  toolName: string | null,
  content: string,
  messageId?: string
): ToolCard | null {
  if (!toolName) return null;
  // shapeToolCard is client-safe (marker constants only); it strips the
  // PROPOSED_ACTION:/undone markers into needsConfirm/undone flags.
  const shaped = shapeToolCard(toolName, content, messageId ? { messageId } : undefined);
  return {
    tool: shaped.tool,
    result_summary: shaped.result_summary,
    ...(shaped.url ? { url: shaped.url } : {}),
    ...(shaped.error ? { error: true } : {}),
    ...(shaped.messageId ? { messageId: shaped.messageId } : {}),
    ...(shaped.needsConfirm ? { needsConfirm: true as const } : {}),
    ...(shaped.undone ? { undone: true as const } : {}),
  };
}

interface ServerCard {
  tool: string;
  result_summary: string;
  url?: string;
  error?: boolean;
  needs_confirm?: boolean;
  message_id: string;
}

function toToolCard(raw: ServerCard): ToolCard {
  return {
    tool: raw.tool,
    result_summary: raw.result_summary,
    ...(raw.url ? { url: raw.url } : {}),
    ...(raw.error ? { error: true } : {}),
    ...(raw.needs_confirm ? { needsConfirm: true as const } : {}),
    messageId: raw.message_id,
  };
}

export default function ActionCards({
  cards,
  onCardUpdate,
}: {
  cards: ToolCard[];
  onCardUpdate?: (index: number, card: ToolCard) => void;
}) {
  // Same dual-context constraint as AssistantPanel (page + root float
  // widget): locale comes from the pathname, never useLocale().
  // Hooks before the empty early-return (rules-of-hooks).
  const pathname = usePathname();
  const cardLocale = stripLocale(pathname ?? "/").locale ?? "en";
  const tActions = useTranslations("assistant");
  const [busyIdx, setBusyIdx] = useState<number | null>(null);
  const [failedIdx, setFailedIdx] = useState<{ i: number; msg: string } | null>(null);
  if (cards.length === 0) return null;

  async function runAction(i: number, card: ToolCard, action: CardAction) {
    if (!card.messageId || busyIdx !== null) return;
    setBusyIdx(i);
    setFailedIdx(null);
    try {
      const res = await fetch("/api/assistant/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, message_id: card.messageId }),
      });
      const body = (await res.json().catch(() => null)) as
        | { card: ServerCard }
        | { undone: boolean; tool: string }
        | { error: string; code: string }
        | null;
      if (!res.ok || !body) {
        const code =
          body && "code" in body && typeof body.code === "string" ? body.code : `HTTP_${res.status}`;
        throw new Error(code);
      }
      if ("undone" in body && body.undone) {
        onCardUpdate?.(i, {
          ...card,
          result_summary: `${card.result_summary}${UNDONE_SUFFIX}`,
          undone: true,
        });
      } else if ("card" in body) {
        onCardUpdate?.(i, toToolCard(body.card));
      } else {
        throw new Error("BAD_RESPONSE");
      }
    } catch (e) {
      setFailedIdx({ i, msg: e instanceof Error ? e.message : "FAILED" });
    } finally {
      setBusyIdx(null);
    }
  }

  return (
    <div className="assistant-cards flex flex-col gap-2 mt-2">
      {cards.map((card, i) => {
        const Icon = ICONS[card.tool] ?? Brain;
        const busy = busyIdx === i;
        const showRetry = card.error && !card.undone && card.messageId;
        const showConfirm = card.needsConfirm && card.messageId;
        const showUndo =
          !card.error && !card.needsConfirm && !card.undone && card.messageId && UNDOABLE.has(card.tool);
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
            {showRetry && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void runAction(i, card, "retry")}
                className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-yellow-500/30 px-2 py-1 text-[11px] text-yellow-300 hover:bg-yellow-500/10 disabled:opacity-50"
              >
                <RotateCcw className="w-3 h-3" />
                {busy ? "…" : tActions("actions.retry")}
              </button>
            )}
            {showConfirm && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void runAction(i, card, "confirm")}
                className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-brand-500/40 px-2 py-1 text-[11px] text-brand-300 hover:bg-brand-500/10 disabled:opacity-50"
              >
                <Check className="w-3 h-3" />
                {busy ? "…" : tActions("actions.confirm")}
              </button>
            )}
            {showUndo && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void runAction(i, card, "undo")}
                className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-[11px] text-slate-400 hover:bg-white/5 disabled:opacity-50"
              >
                <Undo2 className="w-3 h-3" />
                {busy ? "…" : tActions("actions.undo")}
              </button>
            )}
            {card.url && <ArrowRight className="w-3.5 h-3.5 text-slate-500 rtl:rotate-180 shrink-0" />}
          </>
        );
        const cls =
          "rounded-xl px-3 py-2.5 flex items-center gap-2.5 border " +
          (card.error
            ? "glass border-yellow-500/20"
            : "glass glass-hover border-white/5");
        const fail = failedIdx && failedIdx.i === i ? failedIdx.msg : null;
        const node = card.url && !showConfirm ? (
          <Link key={`${card.tool}-${i}`} href={card.url.startsWith("/") ? withLocale(card.url, cardLocale) : card.url} className={cls}>
            {inner}
          </Link>
        ) : (
          <div key={`${card.tool}-${i}`} className={cls}>
            {inner}
          </div>
        );
        return (
          <div key={`card-${i}`}>
            {node}
            {fail && (
              <p className="text-[11px] text-yellow-400/80 mt-1 px-1">
                {tActions("actions.actionFailed", { code: fail })}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
