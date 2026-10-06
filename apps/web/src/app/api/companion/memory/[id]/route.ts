import { NextRequest } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  COMPANION_RATE_LIMIT,
  COMPANION_RATE_WINDOW_MS,
  handleDecideCompanionMemory,
  handleDeleteCompanionMemory,
  type CompanionHttpContext,
} from "@/lib/companion/http";

async function ctx(): Promise<CompanionHttpContext> {
  const { createServerSupabaseClient } = await import("@/lib/supabase/server");
  return {
    getUser: async () => {
      const supabase = await createServerSupabaseClient();
      const { data } = await supabase.auth.getUser();
      return data.user ? { id: data.user.id } : null;
    },
    // mem: bucket key via companionRateKey inside the handlers.
    checkRate: (key: string) =>
      checkRateLimit({ key, limit: COMPANION_RATE_LIMIT, windowMs: COMPANION_RATE_WINDOW_MS }),
  };
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleDecideCompanionMemory(req, id, await ctx());
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleDeleteCompanionMemory(req, id, await ctx());
}
