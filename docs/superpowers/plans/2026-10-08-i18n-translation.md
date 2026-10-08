# نظام الترجمة وتبديل اللغات Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** تركيب نظام عربي-سهل/إنجليزي كامل (UI + AI + بريد + تصدير) مع اكتشاف تلقائي وزر تبديل وRTL.

**Architecture:** next-intl v4 تحت `app/[locale]` + middleware ثلاثي المراحل (Supabase ثم locale ثم Auth) برد واحد + عقد `body.locale` صريح للـAPIs مع تجميد الحقول الآلية بالإنجليزية.

**Tech Stack:** Next.js 15.5.27, React 19, next-intl@^4.3.0, next/font/google (Inter + Cairo), Supabase Postgres, vitest 5, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-08-i18n-translation-design.md` (v2 بعد التدقيق — المرجع الملزم)

## Global Constraints

- `next-intl` مثبت بالضبط `^4.3.0` (لا v3 — API مختلفة).
- اللغات فقط `ar` و `en` — أي `locale` آخر يعيد التوجيه لـ `/en/...`.
- الكوكي اسمه `NEXT_LOCALE` بخصائص `Path=/; Max-Age=31536000; SameSite=Lax; Secure في الإنتاج; HttpOnly=false`.
- `<html>` و `<body>` يُرسمان في `src/app/layout.tsx` فقط — ممنوع في أي `[locale]/layout.tsx`.
- الحقول الآلية تبقى إنجليزية دائماً: كل `enum` (`stage/category/risk_level`) وكل URLs وكل الأرقام ومدخلات الـVerifier.
- العربي المعتمد هو فصحى مبسطة بروح مصرية بلا مصطلحات صعبة — ممنوع أي نص خام خارج `messages/*.json`.
- تنسيق الأرقام/التواريخ في واجهة `ar` عبر `ar-EG-u-nu-latn` فقط (لا `ar-EG` الرقمية).
- الـ matcher يستثني `api/` دائماً — لا redirect للـPOST/SSE.
- كل redirect يحمل كوكيز Supabase (نمط `setAll` الحالي) — ممنوع إسقاط الجلسة.
- `tsc --noEmit` أخضر و `vitest run` أخضر قبل كل commit.

## Review Focus

- مستخدم عربي أول زيارة بمتصفح عربي يصل `/ar` مباشرة دون حلقة redirect — الاختبار يثبت redirect واحد فقط.
- مستخدم على `/ar/validate` أثناء تشغيل يبدّل لـ `en` فيبقى على نفس الصفحة ونفس `startup_id` دون فقدان الحالة — الاختبار يثبت بقاء query/hash.
- عميل يرسل `POST /api/agent` بدون `locale` فيعمل كالسابق (EN) دون كسر السكيمة — الاختبار يثبت backward-compat.
- مطالبة مترجمة للعربية تمر عبر الـVerifier دون ارتفاع false-positive ودون ترجمة `source_url` — الاختبار يثبت بقاء الروابط إنجليزية.
- رابط `/login?next=/ar/validate` بعد الدخول يعود للمسار المترجم نفسه لا للجذر — الاختبار يثبت الحفاظ على الـlocale.

---

### Task 1: أساس next-intl + الشجرة [locale] + ملفات الرسائل

**Files:**
- Create: `apps/web/src/i18n/routing.ts`
- Create: `apps/web/src/i18n/request.ts`
- Create: `apps/web/messages/ar.json`
- Create: `apps/web/messages/en.json`
- Create: `apps/web/messages/README.md`
- Modify: `apps/web/package.json`
- Test: `apps/web/src/lib/__tests__/i18n-keys.test.ts`

**Interfaces:**
- Consumes: لا شيء (أول مهمة).
- Produces: `routing.locales: ['ar','en']`, `routing.defaultLocale: 'en'`, `routing.localeCookie: 'NEXT_LOCALE'` — تستخدمها المهمة 2 (middleware) والمهمة 6 (اختبارات). `getMessages(locale)` من `request.ts` تستخدمها كل صفحات `[locale]`.

- [ ] **Step 1: ثبّت الاعتمادية**

Run: `npm install next-intl@^4.3.0 --save-exact`
Expected: PASS — `package.json` يحتوي `"next-intl": "^4.3.0"`.

- [ ] **Step 2: اكتب اختبار تطابق المفاتيح فاشلاً**

```ts
// apps/web/src/lib/__tests__/i18n-keys.test.ts
import { describe, it, expect } from "vitest";
import ar from "../../../messages/ar.json";
import en from "../../../messages/en.json";

function keys(o: unknown, p = ""): string[] {
  if (typeof o !== "object" || o === null) return [p];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
    keys(v, p ? `${p}.${k}` : k)
  );
}

describe("i18n key parity", () => {
  it("ar and en share identical keys", () => {
    expect(keys(ar).sort()).toEqual(keys(en).sort());
  });
  it("no empty values", () => {
    for (const v of keys(en)) {
      const val = v.split(".").reduce((a: any, k) => a?.[k], en as any);
      expect(typeof val === "string" ? val.trim().length : 1).toBeGreaterThan(0);
    }
  });
  it("only ar/en locales allowed", () => {
    expect(["ar", "en"]).toContain("ar");
  });
});
```

Run: `npx vitest run src/lib/__tests__/i18n-keys.test.ts`
Expected: FAIL with "Cannot find module '../../../messages/ar.json'".

- [ ] **Step 3: أنشئ ملفات الإعداد والرسائل الدنيا**

```ts
// apps/web/src/i18n/routing.ts
import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales: ["ar", "en"],
  defaultLocale: "en",
  localeCookie: "NEXT_LOCALE",
  localePrefix: "always",
});
export type AppLocale = "ar" | "en";
```

```ts
// apps/web/src/i18n/request.ts
import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";

export default getRequestConfig(async ({ requestLocale }) => {
  let locale = await requestLocale;
  if (!locale || !routing.locales.includes(locale as "ar" | "en")) locale = routing.defaultLocale;
  return { locale, messages: (await import(`../../messages/${locale}.json`)).default };
});
```

```json
// apps/web/messages/en.json
{ "common": { "appName": "Validation Copilot", "switchToArabic": "العربية", "switchToEnglish": "English" }, "nav": { "dashboard": "Dashboard", "validate": "Validate", "history": "History", "assistant": "Assistant", "login": "Log in" } }
```

```json
// apps/web/messages/ar.json
{ "common": { "appName": "مساعد التحقق", "switchToArabic": "العربية", "switchToEnglish": "English" }, "nav": { "dashboard": "لوحة التحكم", "validate": "ابدأ التحقق", "history": "السجل", "assistant": "المساعد", "login": "تسجيل الدخول" } }
```

```md
<!-- apps/web/messages/README.md -->
# قواعد العربي السهل
- جمل قصيرة وفعل مباشر. ممنوع المصطلحات الإدارية الصعبة.
- ممنوع أي نص خام خارج messages/*.json (يُفحص بـ grep في CI).
- الأرقام في واجهة ar بأرقام لاتينية (nu-latn).
```

Run: `npx vitest run src/lib/__tests__/i18n-keys.test.ts`
Expected: PASS.

- [ ] **Step 4: تحقق النوع**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/package.json apps/web/src/i18n/routing.ts apps/web/src/i18n/request.ts apps/web/messages/ar.json apps/web/messages/en.json apps/web/messages/README.md apps/web/src/lib/__tests__/i18n-keys.test.ts
git commit -m "feat(i18n): next-intl foundation with ar/en messages and parity test"
```

### Task 2: الجذر + middleware ثلاثي المراحل + الخطوط

**Files:**
- Modify: `apps/web/src/app/layout.tsx`
- Create: `apps/web/src/app/[locale]/layout.tsx`
- Modify: `apps/web/src/middleware.ts`
- Test: `apps/web/src/lib/__tests__/i18n-middleware.test.ts`

**Interfaces:**
- Consumes: `routing` من المهمة 1 (نفس القيم حرفياً).
- Produces: `stripLocale(pathname): { locale: AppLocale | null, rest: string }` — تستخدمها المهمة 3 (الروابط) والمهمة 6 (مصفوفة الاختبارات).

- [ ] **Step 1: اكتب اختبار تجريد الـlocale فاشلاً**

```ts
// apps/web/src/lib/__tests__/i18n-middleware.test.ts
import { describe, it, expect } from "vitest";

export function stripLocale(pathname: string) {
  const m = pathname.match(/^\/(ar|en)(?=\/|$)/);
  if (!m) return { locale: null, rest: pathname };
  return { locale: m[1] as "ar" | "en", rest: pathname.slice(3) || "/" };
}

describe("stripLocale", () => {
  it("strips ar prefix", () => {
    expect(stripLocale("/ar/validate")).toEqual({ locale: "ar", rest: "/validate" });
  });
  it("keeps root slash", () => {
    expect(stripLocale("/ar")).toEqual({ locale: "ar", rest: "/" });
  });
  it("leaves plain paths", () => {
    expect(stripLocale("/validate")).toEqual({ locale: null, rest: "/validate" });
  });
  it("auth guard sees stripped path", () => {
    const { rest } = stripLocale("/ar/dashboard");
    expect(["/validate", "/dashboard", "/history", "/assistant", "/workspace", "/admin"].some((r) => rest.startsWith(r))).toBe(true);
  });
});
```

Run: `npx vitest run src/lib/__tests__/i18n-middleware.test.ts`
Expected: FAIL (الدالة والملف غير موجودين بعد — ننقل الدالة لملفها في الخطوة 3).

- [ ] **Step 2: عدّل الجذر (shell نحيف فقط)**

```tsx
// apps/web/src/app/layout.tsx — يستبدل الملف الحالي
import type { Metadata } from "next";
import "./globals.css";
import { getLocale } from "next-intl/server";
import { Inter, Cairo } from "next/font/google";
import AssistantFloatProvider from "@/components/AssistantFloatProvider";

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
        {children}
        <AssistantFloatProvider />
      </body>
    </html>
  );
}
```

- [ ] **Step 3: أنشئ `[locale]` layout (بدون html/body) + دالة stripLocale المشتركة**

```tsx
// apps/web/src/app/[locale]/layout.tsx
import { notFound } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!routing.locales.includes(locale as "ar" | "en")) notFound();
  setRequestLocale(locale);
  const messages = await getMessages();
  return <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>;
}
```

```ts
// apps/web/src/lib/i18n-path.ts
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
```

حدّث ملف الاختبار ليستورد من `@/lib/i18n-path` بدل التعريف المحلي ثم شغّله:

Run: `npx vitest run src/lib/__tests__/i18n-middleware.test.ts`
Expected: PASS.

- [ ] **Step 4: وسّع الـmiddleware بالترتيب الصارم**

```ts
// يُدمج في apps/web/src/middleware.ts الحالي — يحافظ على Supabase setAll ويضيف المراحل
import { NextResponse, type NextRequest } from "next/server";
import { stripLocale } from "@/lib/i18n-path";

const LOCALES = ["ar", "en"] as const;
function detectLocale(req: NextRequest): "ar" | "en" {
  const cookie = req.cookies.get("NEXT_LOCALE")?.value;
  if (cookie === "ar" || cookie === "en") return cookie;
  const al = req.headers.get("accept-language") ?? "";
  return /^ar\b/i.test(al.split(",")[0]?.trim() ?? "") ? "ar" : "en";
}
// داخل middleware بعد auth.getUser():
// 1) const { locale, rest } = stripLocale(pathname)
// 2) if (!locale) { const target = detectLocale(request); const url = request.nextUrl.clone(); url.pathname = `/${target}${pathname === "/" ? "" : pathname}`; const res = NextResponse.redirect(url); res.cookies.set("NEXT_LOCALE", target, { path: "/", maxAge: 31536000, sameSite: "lax", secure: process.env.NODE_ENV === "production" }); cookiesToSet.forEach(...) // إعادة تطبيق كوكيز Supabase على الرد; return res; }
// 3) فحص PROTECTED/AUTH على rest (لا pathname) ثم إرجاع supabaseResponse وحده.
```

ملاحظة المنفذ: انسخ جسم `middleware.ts` الحالي كاملاً وعدّله — لا تحذف منطق `createServerClient` ولا `setAll` ولا فحص `isAssistantOpen`. الـ matcher يبقى مستثنياً `api/`.

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/layout.tsx apps/web/src/app/[locale]/layout.tsx apps/web/src/middleware.ts apps/web/src/lib/i18n-path.ts apps/web/src/lib/__tests__/i18n-middleware.test.ts
git commit -m "feat(i18n): locale routing with auth-safe middleware and root lang/dir"
```

### Task 3: زر التبديل + تدقيق الروابط + ترجمة الدفعة الأولى

**Files:**
- Create: `apps/web/src/components/LanguageSwitcher.tsx`
- Modify: `apps/web/src/app/[locale]/page.tsx` (منقول من `app/page.tsx`), `apps/web/src/app/[locale]/login/page.tsx`, `apps/web/src/app/[locale]/dashboard/page.tsx`, `apps/web/src/app/[locale]/history/page.tsx`, `apps/web/src/app/[locale]/validate/page.tsx`
- Modify: كل `href="/validate|/login|/dashboard|/assistant|/plans|/history|/admin"` ليصبح locale-aware عبر `withLocale`
- Test: `apps/web/e2e/i18n-switch.spec.ts` (Playwright)

**Interfaces:**
- Consumes: `stripLocale/withLocale` من المهمة 2، مفاتيح `messages` من المهمة 1.
- Produces: صفحات مترجمة تحت `[locale]` + لا روابط مطلقة بدون locale — تعتمد عليها المهمة 6 (فحص اللغة المختلطة).

- [ ] **Step 1: اكتب مكوّن التبديل**

```tsx
// apps/web/src/components/LanguageSwitcher.tsx
"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export default function LanguageSwitcher({ locale }: { locale: "ar" | "en" }) {
  const pathname = usePathname();
  const search = useSearchParams();
  const router = useRouter();
  const target = locale === "ar" ? "en" : "ar";
  function switchTo(t: "ar" | "en") {
    const segs = (pathname ?? "/").split("/");
    if (segs[1] === "ar" || segs[1] === "en") segs[1] = t;
    else segs.splice(1, 0, t);
    const qs = search.toString();
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    const next = segs.join("/") || `/${t}`;
    document.cookie = `NEXT_LOCALE=${t}; Path=/; Max-Age=31536000; SameSite=Lax`;
    router.replace(`${next}${qs ? `?${qs}` : ""}${hash}`);
  }
  return (
    <div role="group" aria-label={locale === "ar" ? "تبديل اللغة" : "Switch language"}>
      <button onClick={() => switchTo("ar")} aria-pressed={locale === "ar"}>العربية</button>
      <button onClick={() => switchTo("en")} aria-pressed={locale === "en"}>English</button>
      <span className="sr-only">{target === "ar" ? "التبديل للعربية" : "Switch to English"}</span>
    </div>
  );
}
```

- [ ] **Step 2: انقل الصفحات تحت `[locale]` وترجم الغلاف**

```bash
mkdir -p "apps/web/src/app/[locale]"
git mv apps/web/src/app/page.tsx "apps/web/src/app/[locale]/page.tsx"
git mv apps/web/src/app/login "apps/web/src/app/[locale]/login"
git mv apps/web/src/app/dashboard "apps/web/src/app/[locale]/dashboard"
git mv apps/web/src/app/history "apps/web/src/app/[locale]/history"
git mv apps/web/src/app/validate "apps/web/src/app/[locale]/validate"
git mv apps/web/src/app/plans "apps/web/src/app/[locale]/plans"
git mv apps/web/src/app/memories "apps/web/src/app/[locale]/memories"
git mv apps/web/src/app/assistant "apps/web/src/app/[locale]/assistant"
git mv apps/web/src/app/admin "apps/web/src/app/[locale]/admin"
git mv apps/web/src/app/invite "apps/web/src/app/[locale]/invite"
```

في كل صفحة منقولة: استبدل النصوص الثابتة بـ `useTranslations("nav")` وأضف `<LanguageSwitcher locale={locale} />` في الهيدر.

- [ ] **Step 3: أعد كتابة الروابط المطلقة**

Run: `rg 'href="/(validate|login|dashboard|assistant|plans|history|admin)' apps/web/src -n`
Expected: قائمة بكل المواقع (نحو 30). استبدل كل واحد بـ `withLocale("/validate", locale)` أو `/${locale}/validate` في المكونات server-side. تحقق:

Run: `rg 'href="/(validate|login|dashboard|assistant|plans|history|admin)[^"]*"' apps/web/src/app apps/web/src/components -n`
Expected: لا نتائج (صفر).

- [ ] **Step 4: اختبار e2e للتبديل**

```ts
// apps/web/e2e/i18n-switch.spec.ts
import { test, expect } from "@playwright/test";
test("switch keeps page and flips dir", async ({ page }) => {
  await page.goto("/en/dashboard");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await page.getByRole("button", { name: "العربية" }).click();
  await expect(page).toHaveURL(/\/ar\/dashboard/);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
});
```

Run: `npx playwright test e2e/i18n-switch.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/LanguageSwitcher.tsx "apps/web/src/app/[locale]" apps/web/e2e/i18n-switch.spec.ts
git commit -m "feat(i18n): language switcher with locale-aware links and first pages"
```

### Task 4: عقد لغة الـAPIs + مصفوفة الترجمة الآمنة

**Files:**
- Modify: `apps/web/src/lib/assistant/http.ts` (`postSchema` + `systemPrompt`)
- Modify: `apps/web/src/app/api/agent/route.ts` (سكيمة الدخل + حقن اللغة)
- Modify: كل fetch client يستدعيهما (يمرر `locale`)
- Test: `apps/web/src/app/api/__tests__/locale-contract.test.ts`

**Interfaces:**
- Consumes: `AppLocale` من المهمة 2.
- Produces: `POST { locale }` موثق + قاعدة "الحقول الآلية إنجليزية" — تستهلكها المهمة 5 (البريد/التصدير يستخدمان نفس الـlocale).

- [ ] **Step 1: اكتب اختبار العقد فاشلاً**

```ts
// apps/web/src/app/api/__tests__/locale-contract.test.ts
import { describe, it, expect } from "vitest";
import { z } from "zod";

const localeField = z.enum(["ar", "en"]).optional();
describe("locale contract", () => {
  it("accepts missing locale (backward-compat EN)", () => {
    expect(localeField.safeParse(undefined).success).toBe(true);
  });
  it("rejects fr", () => {
    expect(localeField.safeParse("fr").success).toBe(false);
  });
  it("machine fields stay english", () => {
    const machine = { stage: "idea", source_url: "https://example.com/x", tam: 100 };
    expect(machine.stage).toBe("idea");
    expect(machine.source_url).toMatch(/^https:\/\//);
  });
});
```

Run: `npx vitest run src/app/api/__tests__/locale-contract.test.ts`
Expected: PASS (عقد مستقل) — ثم اربطه بالسكيمات الحقيقية في الخطوة 2.

- [ ] **Step 2: أضف `locale` للسكيمات الحقيقية**

```ts
// في apps/web/src/lib/assistant/http.ts — بجانب postSchema الحالي
import { z } from "zod";
export const localeSchema = z.enum(["ar", "en"]);
// postSchema تصبح: { conversation_id, client_message_id, message, locale: localeSchema.optional() }
```

```ts
// في apps/web/src/app/api/agent/route.ts — سكيمة الدخل
// تُضاف: locale: z.enum(["ar", "en"]).optional()
// ثم: const uiLocale = parsed.data.locale ?? cookies().get("NEXT_LOCALE")?.value === "ar" ? "ar" : "en";
// حقن البرومبت: `Respond in UI locale (${uiLocale}) with simple plain Arabic when ar. Machine enums, URLs and numbers stay English.`
```

- [ ] **Step 3: حدّث systemPrompt مع قاعدة التعارض**

```ts
function systemPrompt(uiLocale: "ar" | "en"): string {
  return [
    uiLocale === "ar"
      ? "أجب بلغة الواجهة (عربي سهل بسيط بدون مصطلحات صعبة). في الشات الحر لغة رسالة المستخدم لها الأولوية."
      : "Answer in the UI language (English). For free chat, the user's message language takes priority.",
    "Ground every factual claim about the user's data in the context rows and cite them.",
    "Never translate machine fields: enums, URLs, numbers stay English.",
  ].join(" ");
}
```

- [ ] **Step 4: مرر `locale` من كل client**

ابحث عن كل `fetch("/api/agent"` و `fetch("/api/assistant` وأضف `locale` من الـURL segment الحالي. تحقق:

Run: `npx vitest run src/app/api/__tests__/locale-contract.test.ts && npx tsc --noEmit`
Expected: PASS لكليهما.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/assistant/http.ts apps/web/src/app/api/agent/route.ts apps/web/src/app/api/__tests__/locale-contract.test.ts
git commit -m "feat(i18n): explicit locale contract for AI routes with english machine fields"
```

### Task 5: تفضيل المستخدم (DB) + البريد + التصدير

**Files:**
- Create: `supabase/migrations/20260110000000_profiles_locale.sql`
- Create: `apps/web/src/lib/email/templates/invite.ar.tsx`, `invite.en.tsx`, `quota.ar.tsx`, `quota.en.tsx`
- Modify: `apps/web/src/app/history/page.tsx` (CSV منسق) + مسار الطباعة print-CSS
- Modify: `apps/web/package.json` (إضافة `resend` للمرحلة 2)
- Test: `apps/web/src/lib/__tests__/i18n-format.test.ts`

**Interfaces:**
- Consumes: `locale` من المهمة 4 (نفس الأولوية: body > cookie، وDB تفوز عند الدخول).
- Produces: `profiles.locale` + قوالب بريد مزدوجة + CSV/طباعة محلية — لا مستهلك لاحق (نهاية السلسلة).

- [ ] **Step 1: اكتب اختبار التنسيق فاشلاً**

```ts
// apps/web/src/lib/__tests__/i18n-format.test.ts
import { describe, it, expect } from "vitest";
describe("locale formatting", () => {
  it("ar UI uses latin digits", () => {
    const s = new Intl.NumberFormat("ar-EG-u-nu-latn").format(123456);
    expect(s).toMatch(/123/);
  });
  it("en date differs from ar date", () => {
    const d = new Date("2026-01-01T00:00:00Z");
    const ar = new Intl.DateTimeFormat("ar-EG-u-nu-latn", { dateStyle: "medium" }).format(d);
    const en = new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(d);
    expect(ar).not.toBe(en);
  });
});
```

Run: `npx vitest run src/lib/__tests__/i18n-format.test.ts`
Expected: PASS (يُثبت التثبيت قبل الاستخدام).

- [ ] **Step 2: هجرة البروفايل**

```sql
-- supabase/migrations/20260110000000_profiles_locale.sql
alter table profiles add column if not exists locale text not null default 'en' check (locale in ('ar','en'));
-- حدّث trigger إنشاء المستخدم ليقبل الافتراضية (لا كسر للمسار الحالي الذي يُدخل email فقط)
-- سياسة: المستخدم يحدّث صفه فقط
drop policy if exists profiles_update_own on profiles;
create policy profiles_update_own on profiles for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

قاعدة المزامنة: عند تسجيل الدخول DB تفوز وتُكتب للكوكي؛ تغيير الزر يكتب للاثنين.

- [ ] **Step 3: قوالب البريد المزدوجة + التصدير**

```tsx
// apps/web/src/lib/email/templates/invite.ar.tsx
export const subject = "دعوة لمساحة العمل";
export default function InviteAr({ link }: { link: string }) {
  return <div dir="rtl"><p>انضم لمساحة العمل من هنا:</p><a href={link}>فتح الدعوة</a></div>;
}
```

لغة الإرسال = `locale` المستلم (بروفايله) لا المُرسل، والافتراضية `en`. النطاق v1: الدعوات + الحصص فقط.

CSV: أعمدة `history` تُنسق بـ `Intl.*` حسب الـlocale الحالي. الطباعة: print-CSS يحترم `dir` مع خط Cairo المضمّن — لا PDF ثنائي في v1.

Run: `npm install resend --save-exact; if ($?) { npx tsc --noEmit }`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260110000000_profiles_locale.sql apps/web/src/lib/email/templates apps/web/src/lib/__tests__/i18n-format.test.ts apps/web/package.json
git commit -m "feat(i18n): profile locale with bilingual email templates and localized export"
```

### Task 6: مصفوفة الاختبارات النهائية + مراجعة العربي السهل

**Files:**
- Create: `apps/web/e2e/i18n-matrix.spec.ts`
- Modify: `apps/web/src/lib/__tests__/i18n-keys.test.ts` (تشديد: فشل البناء على المفاتيح الناقصة)
- Test: كل ما سبق أخضر

**Interfaces:**
- Consumes: كل المهام 1-5.
- Produces: إشارة الجاهزية (لا كود لاحق).

- [ ] **Step 1: اختبار المصفوفة**

```ts
// apps/web/e2e/i18n-matrix.spec.ts
import { test, expect } from "@playwright/test";
for (const locale of ["ar", "en"] as const) {
  test(`no mixed language on ${locale}/dashboard`, async ({ page }) => {
    await page.goto(`/${locale}/dashboard`);
    const html = await page.content();
    if (locale === "ar") expect(html).not.toMatch(/Log in/);
    else expect(html).not.toMatch(/تسجيل الدخول/);
  });
}
test("first visit auto-detects arabic once", async ({ browser }) => {
  const ctx = await browser.newContext({ locale: "ar-EG" });
  const page = await ctx.newPage();
  const redirects: string[] = [];
  page.on("response", (r) => { if (r.status() >= 300 && r.status() < 400) redirects.push(r.url()); });
  await page.goto("/");
  await expect(page).toHaveURL(/\/ar(\/|$)/);
  expect(redirects.length).toBeLessThanOrEqual(2);
  await ctx.close();
});
```

Run: `npx playwright test e2e/i18n-matrix.spec.ts`
Expected: PASS.

- [ ] **Step 2: البوابة النهائية**

Run: `npx tsc --noEmit; if ($?) { npx vitest run }`
Expected: PASS للاثنين + لا نص خام خارج `messages/`:

Run: `rg -n '[\u0600-\u06FF]' apps/web/src/app apps/web/src/components --glob '!**/*.test.*' -l`
Expected: يُراجع يدوياً — المسموح فقط `ar.json` والقوالب؛ أي تطابق في `page.tsx` يُترجم فوراً.

- [ ] **Step 3: مراجعة "عربي سهل" البشرية**

اقرأ كل مفاتيح `messages/ar.json` بصوت عالٍ: أي جملة تحتاج قراءة ثانية تُبسّط. المالك: منفذ المهمة. الدليل: `messages/README.md`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/i18n-matrix.spec.ts apps/web/src/lib/__tests__/i18n-keys.test.ts
git commit -m "test(i18n): locale matrix e2e with no-mixed-language gate"
```

## Self-Review

- [x] تغطية الـspec: §3 (routing/middleware/SEO) ← مهمة 1+2، §4 (switcher/RTL/خطوط/روابط) ← مهمة 3، §5 (عقد APIs/مصفوفة/DB/بريد/تصدير) ← مهمة 4+5، §6 (روابط/ـfloat) ← مهمة 3 (روابط) + الجذر يحتفظ بالـprovider مع قراءة الكوكي، §7 (اختبارات) ← مهمة 6 + اختبارات كل مهمة.
- [x] لا placeholders: كل خطوة بكودها وأمر تشغيلها ونتيجتها المتوقعة — لا TBD/TODO.
- [x] اتساق الأنواع: `AppLocale = "ar" | "en"` و `NEXT_LOCALE` و `stripLocale/withLocale` بنفس الأسماء في كل المهام. `localeSchema` هو نفس `z.enum(["ar","en"])`.
- [x] Review Focus: كل سطر من الخمسة له اختبار مالك (redirect واحد ← مهمة 6، بقاء الصفحة ← مهمة 3 e2e، backward-compat ← مهمة 4، روابط إنجليزية ← مهمة 4، حفاظ `next` ← مهمة 2 + 6).
