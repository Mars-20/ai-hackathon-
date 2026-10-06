import { NextRequest } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  COMPANION_RATE_LIMIT,
  COMPANION_RATE_WINDOW_MS,
  handleGetCompanionProfile,
  handleToggleCompanionProfile,
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

// Spec §8: POST toggles. GET reads the profile (Task 9 console needs it;
// same auth + mem: rate bucket as every other companion route).
export async function GET(req: NextRequest) {
  return handleGetCompanionProfile(req, await ctx());
}

export async function POST(req: NextRequest) {
  return handleToggleCompanionProfile(req, await ctx());
}
