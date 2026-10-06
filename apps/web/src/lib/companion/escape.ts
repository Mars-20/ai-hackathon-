// Exact replica of agent route.ts:111-122 semantics (single owner of prompt
// wrapping; prompt.ts must NOT re-wrap). Per-field cap so one huge field
// cannot crowd out the rest of the prompt.

export const UNTRUSTED_FIELD_CHARS = 500;

export function truncateField(s: string, max: number = UNTRUSTED_FIELD_CHARS): string {
  return s.length <= max ? s : s.slice(0, max - 3) + "...";
}

// Wrap user-controlled content so the model can tell instructions apart from
// untrusted data. Tags are the boundary: inner text is kept raw (no inner
// escaping), same posture as the agent route.
export function toUntrusted(s: string): string {
  return `<untrusted>${truncateField(s)}</untrusted>`;
}
