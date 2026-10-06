// Companion prompt composition (Task 8): concatenation ONLY — values are
// already wrapped in <untrusted> at compileContext time, so never re-wrap
// or re-escape here. Empty ctx returns the base byte-identical.

const COMPANION_DELIM_TOP = "\n\n[COMPANION MEMORY — user-approved context]\n";
const COMPANION_DELIM_BOTTOM = "\n[END COMPANION MEMORY]\n";

export function composePrompt(base: string, companionCtx: string): string {
  if (!companionCtx) return base;
  return base + COMPANION_DELIM_TOP + companionCtx + COMPANION_DELIM_BOTTOM;
}
