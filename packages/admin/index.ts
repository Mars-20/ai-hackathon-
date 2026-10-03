// ─────────────────────────────────────────────────────────────────────────────
// packages/admin/index.ts — public surface of the reusable admin foundation.
// Transport/auth plumbing ONLY — no Copilot domain concepts (spec §2/I6).
// Extensionless relative imports: consumed by bundlers/Next.js + tsc.
// (Node --experimental-strip-types consumers import leaf files directly.)
// ─────────────────────────────────────────────────────────────────────────────
export { AdminError, isAdminErrorLike, toEnvelope } from "./errors";
export type { AdminEnvelope } from "./errors";
export { escapePostgrest } from "./escape";
export {
  ADMIN_DEFAULT_LIMIT,
  ADMIN_DEFAULT_PAGE,
  ADMIN_MAX_LIMIT,
  ADMIN_MIN_QUERY_LENGTH,
  getPagination,
  parseSearchQuery,
} from "./pagination";
export type { Pagination, PaginationInput } from "./pagination";
export { audit } from "./audit";
export type { AuditClient, AuditEntry } from "./audit";
export { SCOPED_FORBIDDEN_CODE, SCOPED_QUERY_FAILED_CODE, scopedQuery } from "./scopedQuery";
export type { ScopedBuilt, ScopedClient } from "./scopedQuery";
export { isMembershipRow, requireAdmin } from "./requireAdmin";
export type {
  AdminTier,
  AdminUser,
  MembershipRow,
  RequireAdminDeps,
  RequireAdminResult,
} from "./requireAdmin";
