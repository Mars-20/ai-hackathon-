"use client";

// Numbered citation chip ([S#]/[E#]/[W#]/[M#]). Plain <button> — no links,
// no innerHTML. Click scrolls to the action-cards region of the same
// assistant message, falling back to a no-op when absent.

import { useTranslations } from "next-intl";

export default function CitationChip({ label }: { label: string }) {
  const tAsst = useTranslations("assistant");
  const jump = (e: React.MouseEvent<HTMLButtonElement>) => {
    const msg = (e.currentTarget as HTMLElement).closest("[data-assistant-message]");
    const cards = msg?.querySelector(".assistant-cards");
    cards?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  return (
    <button
      type="button"
      onClick={jump}
      className="cite-link"
      title={tAsst("citation.titlePattern", { label })}
      aria-label={tAsst("citation.ariaPattern", { label })}
    >
      [{label}]
    </button>
  );
}
