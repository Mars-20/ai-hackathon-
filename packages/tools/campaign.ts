/**
 * campaign tool (Section 7, Section 10, Section 11)
 * Enforces consent gates and idempotency when interacting with leads and messages.
 *
 * Pure in-memory behaviour is preserved when no Supabase client is passed.
 * Pass a Supabase client as the LAST optional param to persist to
 * leads/messages (RLS enforced server-side via (select auth.uid()) policies).
 */

export interface LeadPayload {
  startup_id: string;
  email: string;
  name?: string;
  company?: string;
  channel?: "email" | "linkedin";
  consent_given?: boolean;
  consent_timestamp?: string;
  consent_text?: string;
  source?: "founder_list" | "signup_form" | "community";
}

export interface MessagePayload {
  campaign_id: string;
  lead_id: string;
  template_type: string;
  body_text: string;
  sender_address: string;
  idempotency_key?: string;
  experiment_id?: string;
  // Email-only until PDPL marketing license (WhatsApp deferred to P2).
  channel?: "email";
}

export interface CampaignResult {
  success: boolean;
  action: "create_lead" | "log_consent" | "queue_message" | "get_status";
  data?: unknown;
  error?: string;
}

/** Daily outbound cap per workspace (Task 5). Per-workspace scoping needs a
 *  messages.workspace_id column (follow-up migration); until then the cap is
 *  enforced globally per day over messages.created_at (sent_at is NULL until
 *  dispatch, so created_at is the reliable "queued today" signal). */
export const DAILY_SEND_CAP = 100;

/** Minimal Supabase surface used here; keeps packages/tools dependency-free. */
export interface SupabaseLike {
  from(table: string): any;
}

function validateConsentForPersist(payload: Record<string, unknown>): {
  ok: true;
  consent_timestamp: string;
  consent_text: string;
} | {
  ok: false;
  error: string;
} {
  const consent_given = (payload as { consent_given?: boolean }).consent_given;
  const consent_timestamp = (payload as { consent_timestamp?: string }).consent_timestamp;
  const consent_text = (payload as { consent_text?: string }).consent_text;
  if (consent_given !== true || !consent_timestamp || !consent_text) {
    return {
      ok: false,
      error:
        "Consent required: consent_given must be true with consent_timestamp and consent_text (Section 11 PDPL audit).",
    };
  }
  return { ok: true, consent_timestamp, consent_text };
}

/** Deterministic fallback key: djb2 hex over lead|channel|template|body. */
export function deterministicMessageKey(
  p: Pick<MessagePayload, "lead_id" | "channel" | "template_type">,
  bodyText: string
): string {
  const seed = [p.lead_id ?? "", p.channel ?? "", p.template_type ?? "", bodyText ?? ""].join("|");
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) + hash + seed.charCodeAt(i)) | 0;
  }
  return `retry-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export async function executeCampaignAction(
  action: "create_lead" | "log_consent" | "queue_message" | "get_status",
  payload: Record<string, unknown>,
  supabase?: SupabaseLike
): Promise<CampaignResult> {
  switch (action) {
    case "create_lead": {
      const { email, consent_given } = payload as { email?: string; consent_given?: boolean };
      if (!email || !email.includes("@")) {
        return { success: false, action, error: "Valid email is required" };
      }
      const base = {
        id: crypto.randomUUID(),
        email,
        consent_given: Boolean(consent_given),
        status: "pending",
        created_at: new Date().toISOString(),
      };
      if (!supabase) {
        return { success: true, action, data: base };
      }
      // DB wiring: strict PDPL consent gate before insert.
      const consentCheck = validateConsentForPersist(payload);
      if (!consentCheck.ok) {
        return { success: false, action, error: consentCheck.error };
      }
      const { consent_timestamp, consent_text } = consentCheck;
      const p = payload as unknown as LeadPayload & { startup_id?: string };
      if (!p.startup_id) {
        return { success: false, action, error: "startup_id is required for persistence" };
      }
      const row = {
        startup_id: p.startup_id,
        email,
        source: p.source ?? "founder_list",
        consent_given: true,
        consent_timestamp,
        consent_text,
        unsubscribed: false,
      };
      const { data, error } = await supabase.from("leads").insert(row).select().single();
      if (error) {
        return { success: false, action, error: error.message ?? "Failed to persist lead" };
      }
      return { success: true, action, data };
    }

    case "log_consent": {
      const { lead_id, consent_status } = payload as { lead_id?: string; consent_status?: boolean };
      if (!lead_id) {
        return { success: false, action, error: "lead_id is required" };
      }
      const base = {
        lead_id,
        consent_status: Boolean(consent_status),
        logged_at: new Date().toISOString(),
      };
      if (!supabase) {
        return { success: true, action, data: base };
      }
      const consent_text = (payload as { consent_text?: string }).consent_text;
      if (consent_status !== true || !consent_text) {
        return {
          success: false,
          action,
          error:
            "Consent required: consent_status must be true with consent_text and timestamp to log consent.",
        };
      }
      const { data, error } = await supabase
        .from("leads")
        .update({
          consent_given: true,
          consent_timestamp: new Date().toISOString(),
          consent_text,
        })
        .eq("id", lead_id)
        .select()
        .single();
      if (error) {
        return { success: false, action, error: error.message ?? "Failed to log consent" };
      }
      return { success: true, action, data };
    }

    case "queue_message": {
      // Compliance check: L3 requires explicit consent before message queuing.
      // NOTE (Task 5): the lead_has_consent flag is only a pre-check for the
      // demo/in-memory path below. On the DB path consent is ALWAYS
      // re-verified from leads (never trust the flag). L3 experiment
      // approval-status is enforced below (Task 6) on the DB path.
      const { lead_has_consent, body_text } = payload as { lead_has_consent?: boolean; body_text?: string };
      if (!lead_has_consent) {
        return {
          success: false,
          action,
          error: "Compliance Violation: Cannot queue message without verified explicit consent (Section 11).",
        };
      }
      // Compliance: explicit opt-out/unsubscribe mechanism required (EN case-insensitive + AR).
      // Parens intentional: fail only when body missing OR mechanism absent.
      const UNSUBSCRIBE_PATTERN = /opt-out|unsubscribe|إلغاء الاشتراك|الغاء الاشتراك/i;
      if (!body_text || !UNSUBSCRIBE_PATTERN.test(body_text)) {
        return {
          success: false,
          action,
          error: "Compliance Violation: Outbound copy must contain an unsubscribe/opt-out mechanism.",
        };
      }
      const p = payload as unknown as MessagePayload & { lead_has_consent?: boolean };
      // Channel lock (Task 5): email only until WhatsApp/LinkedIn license approved.
      if (p.channel !== undefined && p.channel !== "email") {
        return {
          success: false,
          action,
          error: "Compliance Violation: channel restricted to email until license approved (Section 10).",
        };
      }
      // Idempotency policy: caller-supplied key wins (true retry dedup).
      // Fallback is deterministic hash(lead|channel|template|body) so a retry
      // without a caller key still dedups instead of minting a fresh UUID.
      const idempotency_key: string =
        p.idempotency_key ?? deterministicMessageKey(p, body_text);
      const base = {
        id: crypto.randomUUID(),
        status: "queued",
        queued_at: new Date().toISOString(),
        idempotency_key,
      };
      if (!supabase) {
        // Demo-only path: no DB to re-verify against; gates above still apply.
        return { success: true, action, data: base };
      }
      // idempotency_key unique guard: return existing row instead of double-queue.
      const { data: existing } = await supabase
        .from("messages")
        .select("id, status, idempotency_key, created_at")
        .eq("idempotency_key", idempotency_key)
        .maybeSingle();
      if (existing) {
        return { success: true, action, data: { ...existing, deduped: true } };
      }
      if (!p.lead_id) {
        return { success: false, action, error: "lead_id is required for persistence" };
      }
      // DB re-verification (Task 5): never trust the lead_has_consent flag.
      // Block when the lead row is missing, unsubscribed, or lacks PDPL consent.
      const { data: lead, error: leadError } = await supabase
        .from("leads")
        .select("id, unsubscribed, consent_given, consent_timestamp, consent_text")
        .eq("id", p.lead_id)
        .maybeSingle();
      if (leadError || !lead) {
        return { success: false, action, error: "Lead not found: cannot queue without a verified lead (Section 11)." };
      }
      if (lead.unsubscribed === true) {
        return { success: false, action, error: "Lead has unsubscribed: queue blocked (Section 11 opt-out)." };
      }
      if (lead.consent_given !== true || !lead.consent_timestamp || !lead.consent_text) {
        return {
          success: false,
          action,
          error: "Compliance Violation: consent must be re-verified from leads (Section 11 PDPL audit).",
        };
      }
      // L3 approval gate (Task 6): when an experiment_id is given, the
      // experiments row must be approved AND stamped (approved_by/at
      // non-null). Fail closed: missing row, non-approved status, or a
      // missing stamp blocks the queue. The API layer surfaces this as 403.
      // No experiment_id → no L3 scope (Task 5 behaviour preserved).
      if (p.experiment_id) {
        const { data: experiment, error: experimentError } = await supabase
          .from("experiments")
          .select("id, status, approved_by, approved_at")
          .eq("id", p.experiment_id)
          .maybeSingle();
        const exp = experiment as {
          status?: unknown;
          approved_by?: unknown;
          approved_at?: unknown;
        } | null;
        if (
          experimentError ||
          !exp ||
          exp.status !== "approved" ||
          !exp.approved_by ||
          !exp.approved_at
        ) {
          return {
            success: false,
            action,
            error:
              "L3 approval required (403): experiment must have status='approved' with approved_by/at before queueing (Section 10).",
          };
        }
      }
      // Daily send cap (Task 5): block the (CAP+1)-th message queued today.
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const { data: sentToday, error: capError } = await supabase
        .from("messages")
        .select("id")
        .gte("created_at", dayStart.toISOString());
      if (!capError && (sentToday ?? []).length >= DAILY_SEND_CAP) {
        return {
          success: false,
          action,
          error: `Daily send cap reached (${DAILY_SEND_CAP}/day): queue blocked until tomorrow.`,
        };
      }
      const { data, error } = await supabase
        .from("messages")
        .insert({
          lead_id: p.lead_id,
          experiment_id: p.experiment_id ?? null,
          direction: "outbound",
          channel: p.channel ?? "email",
          template_id: p.template_type ?? null,
          body: body_text,
          status: "queued",
          idempotency_key,
        })
        .select()
        .single();
      if (error) {
        // Unique violation race: fetch the winner and return it (idempotent).
        if (String(error.message ?? "").toLowerCase().includes("duplicate")) {
          const { data: winner } = await supabase
            .from("messages")
            .select("id, status, idempotency_key, created_at")
            .eq("idempotency_key", idempotency_key)
            .maybeSingle();
          if (winner) return { success: true, action, data: { ...winner, deduped: true } };
        }
        return { success: false, action, error: error.message ?? "Failed to queue message" };
      }
      return { success: true, action, data };
    }

    case "get_status": {
      return {
        success: true,
        action,
        data: {
          status: "active",
          checked_at: new Date().toISOString(),
        },
      };
    }

    default:
      return { success: false, action, error: `Unknown campaign action: ${action}` };
  }
}
