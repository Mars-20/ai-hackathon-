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
