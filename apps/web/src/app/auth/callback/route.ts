// ─────────────────────────────────────────────────────────────────────────────
// OAuth Callback Handler — /auth/callback
// Exchanges the OAuth code for a Supabase session + creates workspace on first login
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") || "/dashboard";

  if (code) {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      // Get the newly authenticated user
      const { data: { user } } = await supabase.auth.getUser();

      if (user) {
        // Check if user already has a workspace
        const { data: existingMembership } = await supabase
          .from("workspace_members")
          .select("workspace_id")
          .eq("user_id", user.id)
          .limit(1)
          .single();

        // First-time user — auto-create a personal workspace
        if (!existingMembership) {
          const slug = user.email?.split("@")[0]?.toLowerCase().replace(/[^a-z0-9]/g, "-") || user.id.slice(0, 8);
          const { data: workspace } = await supabase
            .from("workspaces")
            .insert({
              name: `${user.user_metadata?.full_name || user.email?.split("@")[0]}'s Workspace`,
              slug: `${slug}-${Date.now()}`,
              owner_id: user.id,
              plan: "free",
            })
            .select()
            .single();

          if (workspace) {
            await supabase.from("workspace_members").insert({
              workspace_id: workspace.id,
              user_id: user.id,
              role: "owner",
              joined_at: new Date().toISOString(),
            });
          }
        }
      }

      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Error fallback
  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
}
