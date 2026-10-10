// Client-safe action-card shaping (no server imports): proposal/undone
// markers live here so both the server (which writes them into persisted
// tool rows) and ActionCards (which renders them) share one definition.

/** Prefix marking a tool row as an unconfirmed destructive proposal. */
export const PROPOSED_ACTION_PREFIX = "PROPOSED_ACTION: ";

/** Suffix marking a tool row as reverted via undo. */
export const UNDONE_SUFFIX = " (undone)";

export interface ShapedToolCard {
  tool: string;
  result_summary: string;
  url?: string;
  error?: boolean;
  messageId?: string;
  needsConfirm?: boolean;
  undone?: boolean;
}

export function isProposalContent(content: string): boolean {
  return content.startsWith(PROPOSED_ACTION_PREFIX);
}

export function isUndoneContent(content: string): boolean {
  return content.endsWith(UNDONE_SUFFIX);
}

export function shapeToolCard(
  tool: string,
  content: string,
  opts?: { url?: string; error?: boolean; messageId?: string }
): ShapedToolCard {
  const needsConfirm = isProposalContent(content);
  const undone = !needsConfirm && isUndoneContent(content);
  const result_summary = needsConfirm
    ? content.slice(PROPOSED_ACTION_PREFIX.length)
    : content;
  return {
    tool,
    result_summary,
    ...(opts?.url ? { url: opts.url } : {}),
    ...(opts?.error ? { error: true } : {}),
    ...(opts?.messageId ? { messageId: opts.messageId } : {}),
    ...(needsConfirm ? { needsConfirm: true as const } : {}),
    ...(undone ? { undone: true as const } : {}),
  };
}
