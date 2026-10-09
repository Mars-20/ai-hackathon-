// ─────────────────────────────────────────────────────────────────────────────
// Middleware — Auth Session Refresh + Route Protection + Locale Routing
// Runs on every request to keep Supabase session cookies fresh
// Protected routes: /validate, /dashboard, /history, /assistant, /workspace/*, /admin/*
// Locale routing: every page path carries an /ar|/en prefix (detect + redirect)
// ─────────────────────────────────────────────────────────────────────────────

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isAssistantOpen } from "@/lib/assistant/gate";
import { stripLocale, isLocaleExemptPath } from "@/lib/i18n-path";

// Routes that require authentication (matched against the locale-stripped path)
const PROTECTED_ROUTES = ["/validate", "/dashboard", "/history", "/assistant", "/workspace", "/admin"];
// Routes only for unauthenticated users (redirect logged-in users away)
const AUTH_ROUTES = ["/login", "/signup"];

const LOCALES = ["ar", "en"] as const;
type Locale = (typeof LOCALES)[number];
function detectLocale(req: NextRequest): Locale {
  const cookie = req.cookies.get("NEXT_LOCALE")?.value;
  if (cookie === "ar" || cookie === "en") return cookie;
  const al = req.headers.get("accept-language") ?? "";
  return /^ar\b/i.test(al.split(",")[0]?.trim() ?? "") ? "ar" : "en";
}

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Refresh session — IMPORTANT: do not add any logic between createServerClient
  // and supabase.auth.getUser() as it can cause session issues
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // Functional auth routes (OAuth callback, ...) are not localizable pages.
  // Serve them as-is: locale-prefix redirecting would 404 (/en/auth/callback
  // does not exist) and the OAuth code would never be exchanged. Session
  // refresh above still applies.
  if (isLocaleExemptPath(pathname)) {
    return supabaseResponse;
  }

  // Redirects start cookie-free, so re-apply the refreshed Supabase session
  // cookies onto every redirect — otherwise each redirect drops the refresh.
  const redirectWithSession = (url: URL) => {
    const res = NextResponse.redirect(url);
    for (const cookie of supabaseResponse.cookies.getAll()) {
      res.cookies.set(cookie);
    }
    return res;
  };

  // 1) Locale-prefix redirect: paths without /ar|/en get one — cookie
  // (NEXT_LOCALE literal; routing.localeCookie is an object under
  // next-intl 4.14.9, never a plain string) wins, then Accept-Language.
  const { locale, rest } = stripLocale(pathname);
  if (!locale) {
    const target = detectLocale(request);
    const url = request.nextUrl.clone();
    url.pathname = `/${target}${pathname === "/" ? "" : pathname}`;
    const res = redirectWithSession(url);
    res.cookies.set("NEXT_LOCALE", target, {
      path: "/",
      maxAge: 31536000,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
    return res;
  }

  // 2) Auth guards match the stripped `rest` path — including the /assistant
  // rollout gate (matching `pathname` would silently disable it under /ar|/en).
  // Redirect targets keep the locale prefix to avoid a second redirect hop.
  if (!isAssistantOpen() && rest.startsWith("/assistant") && user) {
    const dashboardUrl = request.nextUrl.clone();
    dashboardUrl.pathname = `/${locale}/dashboard`;
    dashboardUrl.search = "";
    return redirectWithSession(dashboardUrl);
  }

  // Redirect unauthenticated users away from protected routes
  const isProtected = PROTECTED_ROUTES.some((r) => rest.startsWith(r));
  if (isProtected && !user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = `/${locale}/login`;
    loginUrl.searchParams.set("next", pathname); // preserve intended destination (with locale)
    return redirectWithSession(loginUrl);
  }

  // Redirect authenticated users away from auth routes
  const isAuthRoute = AUTH_ROUTES.some((r) => rest.startsWith(r));
  if (isAuthRoute && user) {
    const dashboardUrl = request.nextUrl.clone();
    dashboardUrl.pathname = `/${locale}/dashboard`;
    return redirectWithSession(dashboardUrl);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - favicon.ico, sitemap.xml, robots.txt
     * - api routes (handled separately)
     */
    "/((?!_next/static|_next/image|favicon.ico|api/).*)",
  ],
};
