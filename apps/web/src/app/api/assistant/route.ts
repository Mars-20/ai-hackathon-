// POST /api/assistant — chat turn (SSE). Thin wrapper: auth + context,
// all logic lives in lib/assistant/http.ts.
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/server";
import {
  handleAssistantPost,
  resolveEntitlementFor,
  type AssistantHttpContext,
} from "@/lib/assistant/http";
import { getDailyQuota } from "@/lib/assistant/quota";

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
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  return handleAssistantPost(ctx, body);
}
