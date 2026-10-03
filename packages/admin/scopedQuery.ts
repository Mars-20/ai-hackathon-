// ─────────────────────────────────────────────────────────────────────────────
// packages/admin/scopedQuery.ts — workspace-tier read scoping contract
// (spec §2/C2): workspaceIds REQUIRED, throws 403 when empty, ALWAYS
// appends `.in('workspace_id', workspaceIds)`; unscoped calls are rejected.
//
// The scoping predicate is applied AFTER build() but BEFORE execution —
// PostgREST builders are lazy, so this is still a single DB round-trip with
// the predicate pushed into the query (never post-fetch JS filtering).
//
// Runtime-import-free by design (see errors.ts note): the 403/500 errors
// thrown here are STRUCTURALLY AdminError (name/status/code/message) and
// normalize identically through toEnvelope().
// ─────────────────────────────────────────────────────────────────────────────
import type { AdminError } from "./errors";

export const SCOPED_FORBIDDEN_CODE = "WORKSPACE_FORBIDDEN";
export const SCOPED_QUERY_FAILED_CODE = "QUERY_FAILED";

function structuralAdminError(status: number, code: string, message: string): AdminError {
  const err = new Error(message);
  err.name = "AdminError";
  const withProps = err as Error & { status: number; code: string };
  withProps.status = status;
  withProps.code = code;
  return withProps as AdminError;
}

export interface ScopedClient<TBase> {
  from(table: string): TBase;
}

export interface ScopedBuilt<TResult> {
  in(column: string, values: string[]): PromiseLike<{ data: TResult; error: unknown }>;
}

export async function scopedQuery<TBase, TResult>(
  client: ScopedClient<TBase>,
  table: string,
  workspaceIds: string[],
  build: (base: TBase) => ScopedBuilt<TResult>,
): Promise<TResult> {
  if (!workspaceIds || workspaceIds.length === 0) {
    throw structuralAdminError(
      403,
      SCOPED_FORBIDDEN_CODE,
      "No workspace scope — access denied",
    );
  }
  const scoped = build(client.from(table)).in("workspace_id", workspaceIds);
  const { data, error } = await scoped;
  if (error) {
    throw structuralAdminError(500, SCOPED_QUERY_FAILED_CODE, "Scoped query failed");
  }
  return data;
}
