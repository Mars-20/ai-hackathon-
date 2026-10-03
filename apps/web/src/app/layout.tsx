import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Validation Copilot — AI-Powered Startup Validation",
  description:
    "Stop building the wrong thing. Validate your startup idea with AI-powered assumption mapping, grounded market research, and real evidence collection — before you spend months and money.",
  keywords: ["startup validation", "AI copilot", "product-market fit", "assumption mapping", "founder tools"],
  openGraph: {
    title: "Validation Copilot",
    description: "AI agent that validates startup ideas with real evidence, not opinions.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen relative z-10">
        {children}
      </body>
    </html>
  );
}
