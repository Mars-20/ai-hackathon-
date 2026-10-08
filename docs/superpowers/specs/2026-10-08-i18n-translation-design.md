# نظام الترجمة وتبديل اللغات — Design Spec (v2 بعد التدقيق العدائي)

**التاريخ:** 2026-10-08 (v2 بعد حلقة المراجعة)
**الحالة:** جاهز للتنفيذ بعد إصلاح 4 حرجة + 8 مهمة من المراجعة العدائية
**النطاق:** `apps/web` (Next.js 15.5.27 + React 19 + Tailwind)
**المكتبة:** `next-intl@^4` (مثبتة صراحة — v3/v4 API مختلفة: `routing` الجديدة لا `createIntlMiddleware` القديمة)

## 1. الفهم المتفق عليه (Brief)

- **الهدف:** نظام ترجمة وتبديل لغات كامل واحترافي لكل النظام.
- **اللغتان:** عربي سهل فقط (فصحى مبسطة بروح مصرية، ممنوع المصطلحات الصعبة) + إنجليزي. لا لغات إضافية.
- **النطاق:** كل شيء — واجهة الموقع + مخرجات الـ AI (شات/تقارير/memos) + إيميلات + تصدير/CSV/طباعة. يُنفذ على مرحلتين (§10).
- **السلوك:** اكتشاف تلقائي من المتصفح أول مرة (`Accept-Language`) + زر تبديل يدوي يحفظ الاختيار ويبقي المستخدم على نفس الصفحة.
- **الوضع الحالي المكتشف:** لا يوجد i18n (`<html lang="en">` ثابت في `src/app/layout.tsx:28`)، ولا `next-intl` في `package.json`، والـ `middleware.ts` الحالي للـ Auth فقط (matcher يستثني `api/` — صحيح ويبقى)، مع إشارات عربية جزئية فقط (`ar-EG` في `companion/copy.ts:17` + رد المساعد بلغة المستخدم في `assistant/http.ts:302`).

## 2. القرار المعماري المعتمد

اعتماد **next-intl (App Router) + مسارات `[locale]` + طبقة لغة صريحة لمخرجات AI**. رُفض القاموس اليدوي (SEO ضعيف وصيانة يدوية).

## 3. المعمارية والـ Routing (مُصحح بعد المراجعة)

### 3.1 شجرة الملفات الجديدة (App Router — ليست pages-router)

- `src/i18n/request.ts` — إعداد next-intl للـ Server Components (لا ملف `next-intl.config` — ذلك تقليد pages-router ومرفوض هنا).
- `src/i18n/routing.ts` — تعريف `locales: ['ar','en']` + `defaultLocale: 'en'` + `localeCookie: 'NEXT_LOCALE'`.
- `messages/ar.json` + `messages/en.json` بمفاتيح موحدة.
- `app/[locale]/layout.tsx` — **لا يحتوي `<html>` ولا `<body>` إطلاقاً** (ممنوع في App Router — فقط الجذر يرسمهما). يحتوي فقط `NextIntlClientProvider` + أصناف الخطوط لكل لغة.
- `app/[locale]/*` — تُنقل إليه الصفحات الـ 17 الحالية (`validate`, `dashboard`, `history`, `assistant`, `admin/*`, `login`, `signup`, `invite/[token]`, `plans`, `memories`, `workspace/*`...).
- `app/layout.tsx` (الجذر) يبقى shell نحيف: يقرأ الـ locale عبر `getLocale()` ويضبط `<html lang dir>` فقط + `AssistantFloatProvider` (§6.4).

### 3.2 `generateStaticParams` والجذر `/` و SEO

- كل `app/[locale]/layout.tsx` يصدّر `generateStaticParams(): [{locale:'ar'},{locale:'en'}]`.
- الجذر `/` (بدون locale): الـ middleware يعيد التوجيه لـ `/ar` أو `/en` حسب §3.3 — لا صفحة جذر مستقلة.
- `locale` غير مدعوم (مثلاً `/fr/...`) → redirect لـ `/en/...` (وليس 404 — قرار صريح يخالف افتراضية next-intl).
- Metadata: `alternates: { languages: { ar: '/ar', en: '/en' } }` + `ogLocale` لكل لغة + canonical يشير للنسخة الحالية. الـ metadata الإنجليزية الحالية في `layout.tsx:5-15` تُترجم للعربية في نسخة `ar`.

### 3.3 الـ middleware — ترتيب صارم (إصلاح حرج: prefix كان يعطّل كل حراس Auth)

الترتيب إجباري في `src/middleware.ts` — رد واحد يحمل كل الكوكيز:

1. إنشاء Supabase client + `auth.getUser()` أولاً (كما هو اليوم — ممنوع أي منطق قبله).
2. اكتشاف اللغة: كوكي `NEXT_LOCALE` (إن وُجد وصالح) > `Accept-Language` (عربي → `ar` وإلا `en`). أول زيارة بدون كوكي → redirect لـ `/ar` أو `/en` مع كتابة الكوكي.
3. تجريد الـ locale من المسار (`pathname.replace(/^\/(ar|en)(?=\/|$)/, '')`) ثم تطبيق حراس Auth الحاليين على المسار المجرّد:
   - `PROTECTED_ROUTES = ["/validate","/dashboard","/history","/assistant","/workspace","/admin"]` تُفحص بعد التجريد — وإلا `/ar/validate` تصبح عامة (الخلل الحرج المكتشف).
   - `AUTH_ROUTES = ["/login","/signup"]` كذلك بعد التجريد.
   - بارام `next` يُحفظ بالمسار الكامل مع الـ locale، وعند إعادة التوجيه بعد الدخول يُتحقق `startsWith('/')` (حماية open-redirect) مع الحفاظ على الـ locale.
4. إرجاع `NextResponse` واحد يحمل كوكيز Supabase (نمط `setAll` الحالي في `middleware.ts:27-34` يجب إعادة تطبيقه على أي redirect — وإلا تضيع session refresh بصمت).

خصائص كوكي `NEXT_LOCALE`: `Path=/; Max-Age=31536000; SameSite=Lax; Secure (إنتاج فقط); HttpOnly=false` (القارئ client-side للـ switcher يحتاجه). **الحقيقة التوجيهية هي مسار الـ URL** (`/ar/...`) — الكوكي مجرد تلميح.

## 4. مكونات الواجهة وزر التبديل و RTL

- مكوّن جديد `src/components/LanguageSwitcher.tsx` في الهيدر (AR|EN) + الموبايل منيو + الفوتر.
- التبديل عبر `router.replace()` مع مبادلة أول segment + الحفاظ على باقي المسار + `searchParams` + hash. للمسارات الديناميكية (`/admin/workspaces/[id]`, `/invite/[token]`, `?startup_id=...&next=...`) تُعاد كتابة `next` مع الـ locale الجديد. التبديل من client state حساس (مثل `/validate` أثناء تشغيل) يستخدم `replace` لا reload كامل.
- تحويل كل النصوص الثابتة إلى `useTranslations()` / `getTranslations()` بالأولوية: landing + login + validate + dashboard + history + admin، ثم الباقي. **ممنوع أي نص عربي/إنجليزي خام خارج `messages/`** (يُفحص بـ grep في CI — سابقة `copy.ts:1-2`).
- RTL: `dir` من الجذر + هجرة Tailwind للخصائص المنطقية (`ms/me/text-start/end`, `border-s/e`, `rounded-s/e`, `start/end-3`) بدل `ml/mr/text-left/border-l` — الملفات المعروفة المتأثرة: `validate/page.tsx` (`border-l-2`, `ml-auto`, `text-left`, `lg:border-r`)، `history/page.tsx` (`left-3`, `pl-9 pr-4`, `right-3`)، `AdminTable.tsx` (`text-left`). تُراجع كل `flex-row` الثابتة.
- الخطوط عبر `next/font/google` (لا `<link>` مشروط): `Inter (latin)` + `Cairo/Tajawal (arabic subset)` مع `variable` لكل لغة و preload — يمنع FOUT والحروف الناقصة (Inter بلا تغطية عربية). الهوية الداكنة ثابتة.
- معيار "عربي سهل" (مالك المراجعة: صاحب المهمة + checklist في `messages/README.md` الجديد): جمل قصيرة، فعل مباشر، لا مصطلحات إدارية/تقنية صعبة. كل مفتاح عربي يُراجع قبل الاعتماد.

### الأرقام والتواريخ (تثبيت بعد التعارض المكتشف)

- أرقام/تواريخ واجهة `ar`: `ar-EG-u-nu-latn` (أرقام لاتينية سهلة القراءة) — قرار صريح يصحح التعارض بين §4 القديم و `copy.ts:17` (الذي يقول `ar-EG/ar-SA digits` أي ٠١٢٣).
- تواريخ نثرية داخل نصوص AI: `ar-EG` الأصلية مسموحة.
- التنسيق دائماً عبر `Intl.DateTimeFormat(localeTag)` و `Intl.NumberFormat(localeTag)` — لا تنسيق يدوي.

## 5. مخرجات AI والإيميلات والتصدير

### 5.1 عقد اللغة للـ APIs (إصلاح حرج: لا تخمين من هيدر/كوكي)

- المصدر الوحيد للحقيقة في الـ APIs هو حقل صريح في body: `locale: z.enum(['ar','en']).optional()` يُضاف لـ `postSchema` في `assistant/http.ts:358-362` ولسكيمة دخل `/api/agent` (التي اليوم بلا أي locale — فحص المراجعة وجد فقط تعليق TAM في `route.ts:1100`).
- سلسلة الأولوية: `body.locale` الصريح > كوكي `NEXT_LOCALE` (fallback) — لا قراءة لـ `Accept-Language` داخل الـ routes. الـ matcher يستثني `api/` عمداً فلا redirect للـ POST (خصوصاً SSE) — لذلك كل fetch client يجب أن يرسل `locale` صراحة. مواقع الاستدعاء المطلوب تعديلها تُحصر في خطة التنفيذ (شات المساعد + الـ agent + أي route يولّد نصاً).
- قاعدة التعارض (كانت متناقضة في v1): **`body.locale` (لغة الواجهة) هي الأساس للمخرجات المهيكلة والتقارير، ولغة إدخال المستخدم لها الأولوية فقط في رد الشات الحر** — تُوثق في الـ system prompt حرفياً.

### 5.2 مصفوفة قابلية الترجمة (تمنع كسر الـ Verifier)

- **تبقى إنجليزية دائماً (machine-English):** كل `enum` (`stage: idea|prototype|live|scaling` في `route.ts:877-880`، `category`، `risk_level`)، كل URLs (`source_url`، `claim` مراجع الأدلة)، كل القيم الرقمية (TAM/SAM/SOM)، ومدخلات الـ Verifier (`findUnsupportedFactualClaims`، `criticScan` في `http.ts:715`، بوابة `matchClaimsToSources`) — تعمل بلغة الأدلة الأصلية.
- **تُترجم للعربي السهل:** نصوص العرض البشرية فقط (`statement`، `reasoning`، متن الـ memo، ردود الشات).
- الـ system prompt المحقون: "أجب بنفس لغة الواجهة (`ar`/`en`) وبعربي سهل بسيط بدون مصطلحات صعبة. الحقول المهيكلة والروابط والأرقام تبقى إنجليزية."

### 5.3 حفظ التفضيل (محدد بعد النقص المكتشف)

- migration تالية بالترقيم الصحيح (تُحدد في خطة التنفيذ بعد فحص أعلى رقم حالي — الترقيم الحالي مختلط `20240101000015_*` مقابل `20260108*`):
  `alter table profiles add column locale text not null default 'en' check (locale in ('ar','en'))` + backfill ضمني (`en`) + تحديث `handle_new_user()` (الذي اليوم يُدخل `email` فقط — `20240101000001_admin.sql:119-136`) + سياسة RLS لتحديث المستخدم لصفه فقط (توسعة `profiles_select` أو سياسة update لصاحب الصف).
- مزامنة الدخول: **DB تفوز على الكوكي عند تسجيل الدخول** (تُكتب للكوكي)، وتغيير الزر لاحقاً يكتب للاثنين (كوكي فوري + update للبروفايل). الزائر بدون حساب: الكوكي فقط.

### 5.4 الإيميلات (حقيقة: لا قوالب ولا Resend اليوم)

- `package.json` بلا `resend`، و`invite/route.ts:212` + `invite/[token]/page.tsx:12` + `EmailResendButton.tsx:63` تؤكد التسليم خارج نطاق v1 — لذا الـ spec يعرّف نظام القوالب بدل افتراض وجوده:
  - موقع جديد: `src/lib/email/templates/{invite,quota,trial}.{ar,en}.tsx` بنفس المحتوى المبسط.
  - إضافة `resend` كاعتمادية في المرحلة 2 فقط.
  - لغة الإرسال = `locale` المستلم (بروفايله) لا المُرسل، والافتراضية `en`.
  - النطاق المشمول v1 للبريد: الدعوات + الحصص فقط — أي حملات تسويقية خارج النطاق.

### 5.5 التصدير/الطباعة (مسار واقعي بدل "PDF سحري")

- لا مكتبة PDF ولا `window.print` اليوم — المسار المعتمد v1: **CSV بأعمدة منسقة حسب الـ locale + طباعة عبر print-CSS تحترم `dir`** (لا توليد PDF ثنائي في v1).
- تضمين خط عربي (Cairo/Tajawal) في مسار الطباعة إجباري — Inter بلا حروف عربية. أي PDF خادمي مستقبلي مشروط بتضمين الخط.

## 6. تدقيق الروابط والنقاط العمياء (كانت غائبة كلياً في v1)

- كل رابط مطلق (`href="/validate"`, `"/login"`, `"/dashboard"`, `"/assistant"`, `"/plans"` — أمثلة مؤكدة: `history/page.tsx:303,309`، `http.ts:391,552` بـ `plans_url: "/plans"`، روابط المساعد `url: /validate?startup_id=...` في `http.ts:663,667`) يجب أن يصبح locale-aware (`/ar/validate`) — هذا هو الجزء الأكبر من الـ diff ويُحصر آلياً بـ grep في خطة التنفيذ.
- `AssistantFloatProvider` مركّب في الجذر `layout.tsx:40` خارج أي شجرة `[locale]` — يأخذ لغته من كوكي `NEXT_LOCALE` عبر hook client-side (لا props من server layout).

## 7. الأخطاء والاختبارات (موسّعة)

- **الأخطاء:** مفتاح ناقص → fallback إنجليزي + تحذير منظم باسم المفتاح في dev فقط + **فشل CI** (parity test يفشل البناء — لا تحذير صامت). `locale` غير مدعوم → redirect `en` + تصحيح الكوكي. فشل كتابة الكوكي → البقاء على لغة الجلسة.
- **الاختبارات الإجبارية:**
  1. `tsc --noEmit` + `vitest`: تطابق مفاتيح `ar/en` 100% + لا قيم فارغة + فحص `dir`.
  2. اختبار agent-fixture بـ `locale:'ar'` يؤكد بقاء الـ enums/URLs صالحة للسكيمة.
  3. مصفوفة middleware (محمي/auth/جذر × locale/بدون × داخل/خارج) — تمنع تكرار كسر Auth.
  4. Playwright e2e: تبديل ذهاباً وإياباً + البقاء على نفس الصفحة + `dir` صحيح + اكتشاف `Accept-Language` + تدفق auth كامل عبر redirect اللغة (يمنع حلقات `/` → `/ar` → `/login`).
  5. فحص "لا لغة مختلطة" لكل route (لا مفتاح خام يتسرب في `/ar`).
  6. فحص انحدار Verifier: لا ارتفاع false-positive على المطالبات المترجمة.
- **معيار النجاح:** كل الصفحات والقوائم والمخرجات والتقارير تتبدل كاملة بدون صفحات مختلطة، وAuth يعمل تحت الـ prefix.

## 8. خارج النطاق

لغات ثالثة، ملفات لهجات منفصلة، ترجمة المحتوى التاريخي للمستخدمين في DB، حملات بريد تسويقية، توليد PDF ثنائي خادمي، تغيير الهوية.

## 9. المراجعة الذاتية v2 + أثر حلقة التدقيق

- [x] إصلاح حرج 1: لا `<html>` في `[locale]` — الجذر فقط يرسمهما.
- [x] إصلاح حرج 2: middleware بترتيب صريح + تجريد locale + رد واحد يحمل كوكيز Supabase + اسم `NEXT_LOCALE`.
- [x] إصلاح حرج 3: `generateStaticParams` + سلوك `/` + redirect (لا 404) + `hreflang`/canonical.
- [x] إصلاح حرج 4: عقد `body.locale` الصريح + قاعدة التعارض + مصفوفة الترجمة + Verifier بلغة الأدلة.
- [x] إصلاحات مهمة 5-12: migration محددة DDL/trigger/RLS/sync، call-sites الـ fetch، نظام قوالب البريد، مسار CSV/print، تثبيت `nu-latn`، `router.replace` للمسارات الديناميكية، `next/font/google`، مصفوفة الاختبارات.
- [x] ثانويات: `SameSite/ Secure/HttpOnly=false` + حقيقة URL + فشل CI على المفاتيح + مالك مراجعة العربي السهل.

## 10. التقسيم المرحلي المقترح لخطة التنفيذ

- **المرحلة 1 (UI chrome):** تثبيت `next-intl@^4` + `[locale]` + middleware + switcher + landing/login/dashboard/history + مصفوفة auth خضراء.
- **المرحلة 2 (AI + بريد + تصدير):** عقد `body.locale` + prompts + مصفوفة الترجمة + فحص Verifier + قوالب البريد + CSV/print. لا تُدمج تغييرات prompts قبل فحص false-positive.
