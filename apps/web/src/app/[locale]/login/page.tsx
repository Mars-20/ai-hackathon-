"use client";

import { Suspense, useState, useEffect } from "react";
import { Brain, ArrowRight, Mail, Lock, User, Eye, EyeOff, Chrome } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import { withLocale, type AppLocale } from "@/lib/i18n-path";
import {
  ConsentCheckbox,
  DEFAULT_CONSENT_CHECKED,
  buildConsentRecord,
} from "@/components/consent-checkbox";

type AuthMode = "login" | "signup";

// Task 5: account locale sync — DB wins at login. If profiles.locale is set
// it is written back to the NEXT_LOCALE cookie and navigation uses it;
// otherwise the current (cookie-derived) locale is saved to the profile.
// Fail-open: auth navigation never waits on / fails from persistence (the
// RLS update policy lands with the Task 5 migration; until then the write
// is a silent no-op).
function readDbLocale(row: unknown): AppLocale | null {
  const raw = (row as { locale?: unknown } | null)?.locale;
  return raw === "ar" || raw === "en" ? raw : null;
}

function nextForLocale(base: string, eff: AppLocale): string {
  const m = base.match(/^\/(ar|en)(?=\/|$)/);
  if (m) return `/${eff}${base.slice(3) || "/"}`;
  return withLocale(base, eff);
}

function AuthForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const locale = useLocale() as AppLocale;
  const tAuth = useTranslations("auth");
  const nextPath = searchParams.get("next") || withLocale("/dashboard", locale);

  const [mode, setMode] = useState<AuthMode>("login");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  // Research-contact consent (Task 6): unchecked by default, explicit opt-in.
  const [consentGiven, setConsentGiven] = useState<boolean>(DEFAULT_CONSENT_CHECKED);

  const supabase = createClient();

  async function syncAccountLocale(current: AppLocale): Promise<AppLocale> {
    try {
      const { data: { user: u } } = await supabase.auth.getUser();
      if (!u) return current;
      const { data: row } = await supabase
        .from("profiles")
        .select("locale")
        .eq("user_id", u.id)
        .single();
      const dbLocale = readDbLocale(row);
      if (dbLocale) {
        document.cookie = `NEXT_LOCALE=${dbLocale}; Path=/; Max-Age=31536000; SameSite=Lax`;
        return dbLocale;
      }
      void supabase.from("profiles").update({ locale: current }).eq("user_id", u.id);
      return current;
    } catch {
      return current;
    }
  }

  // Check if user is already logged in
  useEffect(() => {
    let cancelled = false;
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user || cancelled) return;
      // OAuth logins sync in the auth callback route; this covers the
      // already-logged-in visit (DB locale wins over the URL prefix).
      void syncAccountLocale(locale).then((eff) => {
        if (!cancelled) router.replace(nextForLocale(nextPath, eff));
      });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase.auth, router, nextPath, locale]);

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setSuccessMsg(null);

    try {
      if (mode === "signup") {
        const consent = buildConsentRecord(consentGiven);
        const { error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              full_name: fullName,
              // Stored only when the user opts in (unchecked default).
              ...(consent
                ? {
                    consent_given: consent.consent_given,
                    consent_text: consent.consent_text,
                    consent_timestamp: consent.consent_timestamp,
                  }
                : {}),
            },
          },
        });
        if (signUpError) throw signUpError;
        setSuccessMsg(tAuth("checkEmail"));
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (signInError) throw signInError;
        const eff = await syncAccountLocale(locale);
        router.push(nextForLocale(nextPath, eff));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : tAuth("authFailed");
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleOAuth = async (provider: "google") => {
    setIsLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${nextPath}`,
      },
    });
    if (error) {
      setError(error.message);
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-dvh flex items-center justify-center px-4 relative">
      {/* Background glow */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 rounded-full"
          style={{ background: "radial-gradient(circle, rgba(92,124,250,0.15) 0%, transparent 70%)" }} />
      </div>

      <div className="w-full max-w-md relative">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-4">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 flex items-center justify-center">
              <Brain className="w-5 h-5 text-white" />
            </div>
            <span className="font-black text-xl tracking-tight">
              Validation <span className="gradient-text">Copilot</span>
            </span>
          </div>
          <p className="text-slate-400 text-sm">
            {mode === "login" ? tAuth("taglineA") : tAuth("taglineB")}
          </p>
          <div className="mt-4 flex justify-center">
            <Suspense>
              <LanguageSwitcher locale={locale} />
            </Suspense>
          </div>
        </div>

        {/* Card */}
        <div className="glass rounded-3xl p-6 sm:p-8 border border-white/10">
          {/* Mode toggle */}
          <div className="flex rounded-xl p-1 mb-6" style={{ background: "rgba(255,255,255,0.05)" }}>
            {(["login", "signup"] as AuthMode[]).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setError(null); setSuccessMsg(null); }}
                className="flex-1 py-2 rounded-lg text-sm font-semibold transition-all duration-200"
                style={{
                  background: mode === m ? "rgba(92,124,250,0.3)" : "transparent",
                  color: mode === m ? "#c4b5fd" : "#64748b",
                }}
              >
                {m === "login" ? tAuth("signInTab") : tAuth("signUpTab")}
              </button>
            ))}
          </div>

          {/* OAuth — Google only (GitHub unsupported/removed) */}
          <div className="mb-6">
            <button
              onClick={() => handleOAuth("google")}
              disabled={isLoading}
              className="w-full glass glass-hover rounded-xl py-2.5 flex items-center justify-center gap-2 text-sm font-medium text-slate-300 transition-all border border-white/5"
              id="oauth-google-btn"
            >
              <Chrome className="w-4 h-4" />
              {tAuth("google")}
            </button>
          </div>

          {/* Divider */}
          <div className="flex items-center gap-3 mb-6">
            <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.08)" }} />
            <span className="text-xs text-slate-500">{tAuth("emailDivider")}</span>
            <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.08)" }} />
          </div>

          {/* Form */}
          <form onSubmit={handleEmailAuth} className="space-y-4">
            {mode === "signup" && (
              <div className="relative">
                <User className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <input
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder={tAuth("fullNamePlaceholder")}
                  aria-label={tAuth("fullNameLabel")}
                  required={mode === "signup"}
                  className="w-full glass rounded-xl ps-10 pe-4 py-3 text-sm text-slate-200 placeholder:text-slate-500 outline-none border border-white/5 focus:border-brand-500/50 transition-all"
                  id="auth-fullname-input"
                />
              </div>
            )}

            <div className="relative">
              <Mail className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={tAuth("emailPlaceholder")}
                aria-label={tAuth("emailLabel")}
                required
                className="w-full glass rounded-xl ps-10 pe-4 py-3 text-sm text-slate-200 placeholder:text-slate-500 outline-none border border-white/5 focus:border-brand-500/50 transition-all"
                id="auth-email-input"
              />
            </div>

            <div className="relative">
              <Lock className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={tAuth("passwordPlaceholder")}
                aria-label={tAuth("passwordLabel")}
                required
                minLength={8}
                className="w-full glass rounded-xl ps-10 pe-12 py-3 text-sm text-slate-200 placeholder:text-slate-500 outline-none border border-white/5 focus:border-brand-500/50 transition-all"
                id="auth-password-input"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute end-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            {/* Research-contact consent (Task 6): signup-only, unchecked default */}
            {mode === "signup" && (
              <ConsentCheckbox checked={consentGiven} onChange={setConsentGiven} />
            )}

            {/* Error / Success messages */}
            {error && (
              <div className="rounded-xl p-3 text-xs text-red-300 border border-red-500/20"
                style={{ background: "rgba(239,68,68,0.1)" }}>
                ❌ {error}
              </div>
            )}
            {successMsg && (
              <div className="rounded-xl p-3 text-xs text-green-300 border border-green-500/20"
                style={{ background: "rgba(34,197,94,0.1)" }}>
                {successMsg}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full btn-glow text-white font-bold py-3.5 rounded-xl text-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              id="auth-submit-btn"
            >
              {isLoading ? (
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <>
                  {mode === "login" ? tAuth("submitSignIn") : tAuth("submitSignUp")}
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          {mode === "login" && (
            <p className="text-center text-xs text-slate-500 mt-4">
              {tAuth("forgotPrefix")}{" "}
              <button
                onClick={async () => {
                  if (!email) { setError(tAuth("enterEmailFirst")); return; }
                  await supabase.auth.resetPasswordForEmail(email, {
                    redirectTo: `${window.location.origin}/auth/reset-password`,
                  });
                  setSuccessMsg(tAuth("resetSent"));
                }}
                className="text-brand-400 hover:underline"
              >
                {tAuth("forgotLink")}
              </button>
            </p>
          )}
        </div>

        <p className="text-center text-xs text-slate-600 mt-6">
          {tAuth("terms")}
          <br />{tAuth("pdplLine")}
        </p>
      </div>
    </div>
  );
}

export default function AuthPage() {
  const tAuth = useTranslations("auth");
  return (
    <Suspense fallback={<div className="min-h-dvh flex items-center justify-center">{tAuth("loading")}</div>}>
      <AuthForm />
    </Suspense>
  );
}
