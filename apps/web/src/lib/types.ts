// ─────────────────────────────────────────────────────────────────────────────
// Core Types — Validation Copilot (Multi-User / Multi-Workspace)
// ─────────────────────────────────────────────────────────────────────────────

// ── Auth & Identity ──────────────────────────────────────────────────────────
export interface AuthUser {
  id: string;           // Supabase auth.users.id (UUID)
  email: string;
  full_name?: string;
  avatar_url?: string;
  created_at: string;
}

// ── Workspace (multi-tenant root entity) ─────────────────────────────────────
export type MemberRole = "owner" | "admin" | "member" | "viewer";
export type InviteStatus = "pending" | "accepted" | "declined" | "expired" | "revoked";

export interface Workspace {
  id: string;
  name: string;
  slug: string;          // URL-friendly identifier
  owner_id: string;      // AuthUser.id
  plan: "free" | "pro" | "team"; // billing tier
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMember {
  id: string;
  workspace_id: string;
  user_id: string;       // AuthUser.id
  role: MemberRole;
  invited_by?: string;   // AuthUser.id of inviter
  joined_at?: string;
  created_at: string;
}

export interface WorkspaceInvite {
  id: string;
  workspace_id: string;
  email: string;
  role: MemberRole;
  // Task 8 R1 hash-only: raw token is NEVER persisted for new rows
  // (DB `token` stays NULL). Legacy rows may still carry a raw value
  // until rotated/expired — never expose it.
  token?: string | null;
  // sha256 hex of the invite token (credential-equivalent, never
  // returned by the API). NULL only on legacy pre-0004 rows.
  token_hash?: string | null;
  status: InviteStatus;
  expires_at: string;
  invited_by: string;    // AuthUser.id
  created_at: string;
}

// Permission helper — what each role can do
export const ROLE_PERMISSIONS: Record<MemberRole, {
  canEdit: boolean;
  canInvite: boolean;
  canDelete: boolean;
  canApproveExperiments: boolean;
}> = {
  owner:  { canEdit: true,  canInvite: true,  canDelete: true,  canApproveExperiments: true  },
  admin:  { canEdit: true,  canInvite: true,  canDelete: false, canApproveExperiments: true  },
  member: { canEdit: true,  canInvite: false, canDelete: false, canApproveExperiments: false },
  viewer: { canEdit: false, canInvite: false, canDelete: false, canApproveExperiments: false },
};

// Track-aware: projects may define custom stage keys; the four legacy values
// below are the default ("general") track, not an exhaustive union.
export type Stage = string;
export const LEGACY_STAGES = ["idea", "prototype", "live", "scaling"] as const;
export type Category = "desirability" | "viability" | "feasibility";
export type RiskLevel = "critical" | "high" | "medium" | "low";
export type AssumptionStatus = "untested" | "testing" | "validated" | "invalidated";
export type EvidenceType = "secondary" | "primary";
export type SourceType = "web_search" | "interview" | "survey" | "preorder" | "usage_data";
export type EvidenceStrength = "opinion" | "intent" | "time_given" | "contact_shared" | "commitment";
export type ExperimentType = "interview" | "survey" | "landing_page" | "presale";
export type ExperimentStatus = "draft" | "approved" | "running" | "completed";
export type Verdict = "go" | "iterate" | "stop" | "test_more";
export type Confidence = "low" | "medium" | "high";
export type Direction = "outbound" | "inbound";
export type MessageStatus = "queued" | "sent" | "delivered" | "replied" | "bounced" | "failed";

// Autonomy levels per spec Section 10
export type AutonomyLevel = "L0" | "L1" | "L2" | "L3";

// ── Startup ────────────────────────────────────────────────────────────────
import type { StageStep } from "./progress/tracks";

export interface Startup {
  id: string;
  workspace_id: string;  // ← isolates data per workspace
  owner_id: string;      // AuthUser.id of creator
  name: string;
  one_liner: string;
  domain: string;
  target_customer?: string;
  stage: Stage;
  /** Stage track template key (NULL = general legacy). Requires migration 0016. */
  stage_track?: string | null;
  /** Custom order override (NULL = template order). Requires migration 0016. */
  stage_order?: StageStep[] | null;
  business_model?: string;
  created_at: string;
  updated_at: string;
}

// ── Assumption ───────────────────────────────────────────────────────────────
export interface Assumption {
  id: string;
  startup_id: string;
  statement: string;
  category: Category;
  risk_level: RiskLevel;
  status: AssumptionStatus;
  reasoning?: string;
  created_at: string;
}

// ── Evidence ─────────────────────────────────────────────────────────────────
export interface Evidence {
  id: string;
  startup_id: string;
  assumption_id?: string;
  evidence_type: EvidenceType;
  source_type?: SourceType;
  source_url?: string;
  claim: string;
  strength: EvidenceStrength;
  sample_size?: number;
  collected_at: string;
}

// ── Experiment ───────────────────────────────────────────────────────────────
export interface Experiment {
  id: string;
  startup_id: string;
  assumption_id?: string;
  type: ExperimentType;
  design: ExperimentDesign;
  status: ExperimentStatus;
  approved_by?: string;
  approved_at?: string;
  created_at: string;
}

export interface ExperimentDesign {
  title?: string;
  description?: string;
  questions?: SurveyQuestion[];
  script?: string;
  success_criteria?: string;
  target_sample_size?: number;
  estimated_cost?: string;
  time_to_run?: string;
}

export interface SurveyQuestion {
  id: string;
  text: string;
  type: "open" | "scale" | "yesno" | "multiple_choice";
  is_leading?: boolean;
  warning?: string;
  options?: string[];
}

// ── Decision Memo ─────────────────────────────────────────────────────────────
export interface Decision {
  id: string;
  startup_id: string;
  verdict: Verdict;
  confidence: Confidence;
  rationale: string;
  // Task 10 verifier gate (spec §4.4): unsupported claims flagged by the
  // verifier. Runtime/SSE only — not a decisions-table column.
  warnings?: string[];
  evidence_ids: string[];
  sample_size?: number;
  response_rate?: number;
  next_experiment?: string;
  created_at: string;
}

// ── Trace Event ───────────────────────────────────────────────────────────────
export type TraceActor = "router" | "planner" | "executor" | "verifier" | "companion" | `skill:${string}` | "tool";
export type TraceEventType = "tool_call" | "tool_result" | "verification" | "decision" | "error" | "skill_start" | "skill_end" | "companion_inject" | "companion_infer" | "companion_decide";

export interface TraceEvent {
  id: string;
  startup_id?: string;
  actor: TraceActor;
  event_type: TraceEventType;
  payload: Record<string, unknown>;
  cost_usd?: number;
  latency_ms?: number;
  created_at: string;
  // client-side only
  status?: "running" | "done" | "error";
}

// ── Agent I/O ─────────────────────────────────────────────────────────────────
export interface AgentInput {
  idea: string;
  startup_id?: string;
  workspace_id?: string; // scopes the session to a workspace
  user_id?: string;      // the user submitting the request
  uploaded_data?: string; // CSV or notes pasted
}

export interface AgentOutput {
  startup: Startup;
  assumptions: Assumption[];
  evidence: Evidence[];
  experiment?: Experiment;
  decision?: Decision;
  trace: TraceEvent[];
  error?: string;
}

// ── Tool Schemas ─────────────────────────────────────────────────────────────
export interface GroundedSearchInput {
  query: string;
  domain_hint?: string;
}

export interface GroundedSearchResult {
  claim: string;
  url: string;
  published_at?: string;
}

export interface GroundedSearchOutput {
  results: GroundedSearchResult[];
}

export interface StatsInput {
  operation: "sample_stats" | "sean_ellis_score" | "response_rate" | "confidence_interval";
  data: number[] | Record<string, unknown>;
}

export interface StatsOutput {
  result: number | Record<string, number>;
  interpretation?: string;
}

// ── Session State (client-side) ───────────────────────────────────────────────
export type SessionPhase =
  | "idle"
  | "intake"
  | "mapping"
  | "research"
  | "experiment"
  | "leads"
  | "evidence"
  | "verifying"
  | "memo"
  | "done"
  | "error";

export interface SessionState {
  phase: SessionPhase;
  // Multi-user context
  user?: AuthUser;
  workspace?: Workspace;
  memberRole?: MemberRole;
  // Validation session
  startup?: Startup;
  assumptions: Assumption[];
  evidence: Evidence[];
  experiment?: Experiment;
  decision?: Decision;
  trace: TraceEvent[];
  isLoading: boolean;
  error?: string;
  budget_used_usd: number;
  tool_calls_used: number;
}
