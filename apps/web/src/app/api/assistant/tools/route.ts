// POST tool actions (Project C: retry / confirm / undo). Thin wrapper.
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/server";
import {
  handleToolAction,
  resolveEntitlementFor,
  type AssistantHttpContext,
} from "@/lib/assistant/http";
import { getDailyQuota } from "@/lib/assistant/quota";
import { assistantClosedResponse, isAssistantOpen } from "@/lib/assistant/gate";

export async function POST(req: NextRequest) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: "Unauthorized", code: "UNAUTHENTICATED" },
      { status: 401 }
    );
  }
  // Closed rollout (spec §10/§11): auth first (401 above), gate second.
  if (!isAssistantOpen()) return assistantClosedResponse();
  const admin = createServiceRoleClient();
  let entitlement: AssistantHttpContext["entitlement"];
  try {
    entitlement = await resolveEntitlementFor(admin, user.id);
  } catch {
    return NextResponse.json(
      { error: "Entitlement check unavailable. Try again shortly.", retryAfter: 60 },
      { status: 429, headers: { "Retry-After": "60" } }
    );
  }
  const ctx: AssistantHttpContext = {
    userId: user.id,
    db: supabase,
    admin,
    entitlement,
    quotaMax: getDailyQuota(),
  };
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request", code: "INVALID" }, { status: 400 });
  }
  return handleToolAction(ctx, rawBody);
}
