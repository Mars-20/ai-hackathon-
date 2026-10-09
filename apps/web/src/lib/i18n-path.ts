export type AppLocale = "ar" | "en";
export function stripLocale(pathname: string): { locale: AppLocale | null; rest: string } {
  const m = pathname.match(/^\/(ar|en)(?=\/|$)/);
  if (!m) return { locale: null, rest: pathname };
  return { locale: m[1] as AppLocale, rest: pathname.slice(3) || "/" };
}
export function withLocale(path: string, locale: AppLocale): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return `/${locale}${clean === "/" ? "" : clean}`;
}
// Functional routes that must never get a locale prefix (OAuth callback,
// auth handlers, ...). Locale-redirecting them 404s since no /ar|/en
// variants exist — the OAuth code would never be exchanged.
export function isLocaleExemptPath(pathname: string): boolean {
  return pathname === "/auth" || pathname.startsWith("/auth/");
}
