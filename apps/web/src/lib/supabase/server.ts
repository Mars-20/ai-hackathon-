// ─────────────────────────────────────────────────────────────────────────────
// Supabase Client — Server (Server Components, Route Handlers, Middleware)
// ─────────────────────────────────────────────────────────────────────────────
import "server-only";
import { cache } from "react";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";

export async function createServerSupabaseClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // setAll called from Server Component — cookies are read-only there.
            // Middleware will handle session refresh.
          }
        },
      },
    }
  );
}

// Service role client — for admin operations only (server-side only!)
export function createServiceRoleClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

// Per-request memoized clients: the gate plus every DAL read in one request
// share a single user client and a single service client (React cache()
// scope = one request in the App Router). Clients hold no sockets — this
// only avoids redundant construction/cookie reads, never changes behavior.
export const getRequestUserClient = cache(() => createServerSupabaseClient());
export const getRequestServiceClient = cache(() => createServiceRoleClient());
