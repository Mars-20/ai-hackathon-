// ─────────────────────────────────────────────────────────────────────────────
// packages/admin/escape.ts — CANONICAL PostgREST escaper.
// Escapes `.or()` filter specials + LIKE wildcards (minimal, best-effort).
// Both pre-existing copies (history, search routes) were migrated to this
// single implementation; behavior is byte-identical to the originals.
// ─────────────────────────────────────────────────────────────────────────────

export function escapePostgrest(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_")
    .replace(/,/g, "\\,")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\*/g, "\\*")
    .replace(/"/g, '\\"')
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}
