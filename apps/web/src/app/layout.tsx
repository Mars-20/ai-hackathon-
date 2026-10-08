import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";
import { getLocale } from "next-intl/server";
import { Inter, Cairo } from "next/font/google";
import AssistantFloatProvider from "@/components/AssistantFloatProvider";
import HtmlLocaleSync from "@/components/HtmlLocaleSync";

const inter = Inter({ subsets: ["latin"], variable: "--font-en" });
const cairo = Cairo({ subsets: ["arabic", "latin"], variable: "--font-ar" });

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale();
  const isAr = locale === "ar";
  return {
    title: isAr ? "مساعد التحقق — تحقق من فكرتك قبل ما تبني" : "Validation Copilot — AI-Powered Startup Validation",
    description: isAr ? "تحقق من فكرة مشروعك بأدلة حقيقية قبل ما تصرف وقت وفلوس." : "Stop building the wrong thing. Validate your startup idea with AI-powered evidence.",
    alternates: { languages: { ar: "/ar", en: "/en" } },
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const isAr = locale === "ar";
  return (
    <html lang={locale} dir={isAr ? "rtl" : "ltr"} className={isAr ? cairo.variable : inter.variable} suppressHydrationWarning>
      <body className="min-h-dvh relative z-10">
        <Suspense fallback={null}>
          <HtmlLocaleSync />
        </Suspense>
        {children}
        <AssistantFloatProvider />
      </body>
    </html>
  );
}
