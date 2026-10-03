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
  channel?: "email" | "whatsapp";
}

export interface CampaignResult {
  success: boolean;
  action: "create_lead" | "log_consent" | "queue_message" | "get_status";
  data?: unknown;
  error?: string;
}

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
      const p = payload as LeadPayload & { startup_id?: string };
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
      // Compliance check: L3 requires explicit consent before message queuing
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
      const p = payload as MessagePayload & { lead_has_consent?: boolean };
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
