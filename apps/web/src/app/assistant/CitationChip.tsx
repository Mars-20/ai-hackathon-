"use client";

// Numbered citation chip ([S#]/[E#]/[W#]/[M#]). Plain <button> — no links,
// no innerHTML. Click scrolls to the action-cards region of the same
// assistant message, falling back to a no-op when absent.

export default function CitationChip({ label }: { label: string }) {
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
      title={`مصدر ${label} — اضغط للانتقال إلى البطاقات`}
      aria-label={`مصدر ${label}`}
    >
      [{label}]
    </button>
  );
}
