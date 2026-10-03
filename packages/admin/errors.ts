// ─────────────────────────────────────────────────────────────────────────────
// packages/admin/errors.ts — AdminError + error envelope for /api/admin/* ONLY.
// Existing routes keep their `{ error }` shape; only admin routes use
// `{ error, code }` (spec §2/M4).
//
// NOTE (resolution-compat): packages/admin modules never import each other
// at RUNTIME (extensionless relative imports break node --experimental-
// strip-types; `.ts`-suffixed ones break tsc TS5097). They share AdminError
// STRUCTURALLY (name/status/code/message) via `import type`, and
// toEnvelope()/isAdminErrorLike() normalize structurally — which is also
// the correct contract across serialization boundaries (prototypes do not
// survive JSON round-trips, but status/code do).
// ─────────────────────────────────────────────────────────────────────────────

export class AdminError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AdminError";
    this.status = status;
    this.code = code;
  }
}

/** Structural guard — accepts AdminError AND structurally-identical errors. */
export function isAdminErrorLike(err: unknown): err is AdminError {
  if (typeof err !== "object" || err === null) return false;
  const record = err as Record<string, unknown>;
  return typeof record["status"] === "number" && typeof record["code"] === "string";
}

export interface AdminEnvelope {
  status: number;
  body: { error: string; code: string };
}

/** Normalize any thrown value into an HTTP status + `{ error, code }` body. */
export function toEnvelope(err: unknown): AdminEnvelope {
  if (isAdminErrorLike(err)) {
    const message: unknown = (err as { message?: unknown }).message;
    return {
      status: err.status,
      body: {
        error: typeof message === "string" && message.length > 0 ? message : "Request failed",
        code: err.code,
      },
    };
  }
  const message = err instanceof Error ? err.message : "Internal error";
  return { status: 500, body: { error: message, code: "INTERNAL" } };
}
