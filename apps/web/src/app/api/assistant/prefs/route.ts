// GET+PUT /api/assistant/prefs — floating-widget preference. Thin wrapper.
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/server";
import {
  handleGetPrefs,
  handlePutPrefs,
  resolveEntitlementFor,
  type AssistantHttpContext,
} from "@/lib/assistant/http";
import { getDailyQuota } from "@/lib/assistant/quota";

async function ctxFor(): Promise<
  { ctx: AssistantHttpContext } | { response: NextResponse }
> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      response: NextResponse.json(
        { error: "Unauthorized", code: "UNAUTHENTICATED" },
        { status: 401 }
      ),
    };
  }
  const admin = createServiceRoleClient();
  let entitlement: AssistantHttpContext["entitlement"];
  try {
    entitlement = await resolveEntitlementFor(admin, user.id);
  } catch {
    return {
      response: NextResponse.json(
        { error: "Entitlement check unavailable. Try again shortly.", retryAfter: 60 },
        { status: 429, headers: { "Retry-After": "60" } }
      ),
    };
  }
  return {
    ctx: { userId: user.id, db: supabase, admin, entitlement, quotaMax: getDailyQuota() },
  };
}

export async function GET() {
  const resolved = await ctxFor();
  if ("response" in resolved) return resolved.response;
  return handleGetPrefs(resolved.ctx);
}

export async function PUT(req: NextRequest) {
  const resolved = await ctxFor();
  if ("response" in resolved) return resolved.response;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  return handlePutPrefs(resolved.ctx, body);
}
