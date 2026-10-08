import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales: ["ar", "en"],
  defaultLocale: "en",
  localeCookie: { name: "NEXT_LOCALE" },
  localePrefix: "always",
});
export type AppLocale = "ar" | "en";
