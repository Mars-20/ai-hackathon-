import { NextRequest } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  COMPANION_RATE_LIMIT,
  COMPANION_RATE_WINDOW_MS,
  handleCreateCompanionMemory,
  handleListCompanionMemories,
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
    checkRate: (key: string) =>
      checkRateLimit({ key, limit: COMPANION_RATE_LIMIT, windowMs: COMPANION_RATE_WINDOW_MS }),
  };
}

// Note: the mem: prefix lives in companionRateKey(); the wire below passes
// the full bucket key through to the shared sliding-window gate.
export async function GET(req: NextRequest) {
  return handleListCompanionMemories(req, await ctx());
}

export async function POST(req: NextRequest) {
  return handleCreateCompanionMemory(req, await ctx());
}
