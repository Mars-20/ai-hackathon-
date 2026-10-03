// ─────────────────────────────────────────────────────────────────────────────
// Supabase Client — Browser (Client Components)
// Uses @supabase/ssr for cookie-based session management in Next.js App Router
// ─────────────────────────────────────────────────────────────────────────────

import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
