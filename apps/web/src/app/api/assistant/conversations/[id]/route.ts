// PATCH rename / DELETE thread. Thin wrappers.
import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase/server";
import {
  handleDeleteConversation,
  handleRenameConversation,
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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const resolved = await ctxFor();
  if ("response" in resolved) return resolved.response;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  return handleRenameConversation(resolved.ctx, id, body);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const resolved = await ctxFor();
  if ("response" in resolved) return resolved.response;
  return handleDeleteConversation(resolved.ctx, id);
}
