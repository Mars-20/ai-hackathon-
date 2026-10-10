// Client-safe shared types for the assistant UI (no server imports).
// Shapes mirror the real wire contract in lib/assistant/http.ts:
// POST { message, conversation_id?, client_message_id }; SSE token/tool/
// done/error; list { conversations[], meta, quota }; prefs { float_enabled }.

export interface AssistantThread {
  id: string;
  title: string | null;
  created_at: string;
}

export interface AssistantListItem {
  id: string;
  title: string | null;
  updated_at: string;
  message_count: number;
}

export type AssistantRole = "user" | "assistant" | "tool";

export interface AssistantMessageRow {
  id: string;
  role: AssistantRole;
  content: string;
  tool_name: string | null;
  tool_args: Record<string, unknown> | null;
  citations: Array<{ kind: string; id: string; label: string }> | null;
  created_at: string;
}

/** Action card built from an SSE `tool` event or a persisted tool row. */
export interface ToolCard {
  tool: string;
  result_summary: string;
  url?: string;
  error?: boolean;
  /** Persisted tool-row id — present when the card supports retry/undo/confirm. */
  messageId?: string;
  /** Destructive proposal awaiting user confirmation. */
  needsConfirm?: boolean;
  /** Additive action reverted via undo. */
  undone?: boolean;
}

export interface AssistantQuota {
  used: number;
  quota: number;
}

export interface AssistantPrefs {
  float_enabled: boolean;
}

export interface SseTokenEvent {
  type: "token";
  text: string;
}

export interface SseToolEvent {
  type: "tool";
  tool: string;
  args: Record<string, unknown>;
  result_summary: string;
  url?: string;
  error?: boolean;
  /** Persisted tool-row id for retry/undo/confirm actions. */
  message_id?: string;
  /** Destructive proposal: render Confirm, do not treat as executed. */
  needs_confirm?: boolean;
}

export interface SseDoneEvent {
  type: "done";
  conversation_id: string;
  citations: Array<{ kind: string; id: string; label: string }>;
  deduped: boolean;
}

export interface SseErrorEvent {
  type: "error";
  code?: string;
  message?: string;
  retryAfter?: number;
}

export type SseAssistantEvent =
  | SseTokenEvent
  | SseToolEvent
  | SseDoneEvent
  | SseErrorEvent;
