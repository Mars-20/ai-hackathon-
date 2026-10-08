// ─────────────────────────────────────────────────────────────────────────────
// OAuth Callback Handler — /auth/callback
// Exchanges the OAuth code for a Supabase session + creates workspace on first login
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

type AccountLocale = "ar" | "en";

function asAccountLocale(value: unknown): AccountLocale | null {
  return value === "ar" || value === "en" ? value : null;
}

// Task 5: (re-)prefix the post-login destination with the effective locale.
// Handles both unprefixed ("/dashboard") and already-prefixed ("/en/...") input.
function withEffectivePrefix(next: string, eff: AccountLocale): string {
  const m = next.match(/^\/(ar|en)(?=\/|$)/);
  if (m) return `/${eff}${next.slice(3) || "/"}`;
  const clean = next.startsWith("/") ? next : `/${next}`;
  return `/${eff}${clean === "/" ? "" : clean}`;
}

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
        // Task 5: DB wins at login — profiles.locale (if set) is written
        // back to the NEXT_LOCALE cookie and the redirect target is
        // (re-)prefixed with it; otherwise the cookie-derived locale is
        // saved to the profile. Fail-open: persistence never blocks login
        // (the RLS update policy lands with the Task 5 migration; until
        // then the write is a silent no-op).
        const cookieLocale = asAccountLocale(request.cookies.get("NEXT_LOCALE")?.value) ?? "en";
        const { data: profileRow } = await supabase
          .from("profiles")
          .select("locale")
          .eq("user_id", user.id)
          .single();
        const dbLocale = asAccountLocale(
          (profileRow as { locale?: unknown } | null)?.locale,
        );
        const effective = dbLocale ?? cookieLocale;
        if (!dbLocale) {
          await supabase.from("profiles").update({ locale: cookieLocale }).eq("user_id", user.id);
        }

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

        // Task 5 locale-aware redirect (DB locale wins over the `next` prefix).
        const dest = withEffectivePrefix(next, effective);
        const res = NextResponse.redirect(`${origin}${dest}`);
        res.cookies.set("NEXT_LOCALE", effective, {
          path: "/",
          maxAge: 31536000,
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
        });
        return res;
      }

      // Exchange succeeded but no user resolved — legacy behavior.
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Error fallback
  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
}
