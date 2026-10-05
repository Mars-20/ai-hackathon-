"use client";

import { Suspense, useState, useEffect } from "react";
import { Brain, ArrowRight, Mail, Lock, User, Eye, EyeOff, Chrome } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ConsentCheckbox,
  DEFAULT_CONSENT_CHECKED,
  buildConsentRecord,
} from "@/components/consent-checkbox";

type AuthMode = "login" | "signup";

function AuthForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next") || "/dashboard";

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

  // Check if user is already logged in
  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) router.replace(nextPath);
    });
  }, [supabase.auth, router, nextPath]);

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
        setSuccessMsg("✅ Check your email for a confirmation link.");
      } else {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (signInError) throw signInError;
        router.push(nextPath);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Authentication failed";
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
    <div className="min-h-screen flex items-center justify-center px-4 relative">
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
            {mode === "login"
              ? "Welcome back. Your startups are waiting."
              : "Join thousands of founders validating smarter."}
          </p>
        </div>

        {/* Card */}
        <div className="glass rounded-3xl p-8 border border-white/10">
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
                {m === "login" ? "Sign In" : "Sign Up"}
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
              Continue with Google
            </button>
          </div>

          {/* Divider */}
          <div className="flex items-center gap-3 mb-6">
            <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.08)" }} />
            <span className="text-xs text-slate-500">or continue with email</span>
            <div className="flex-1 h-px" style={{ background: "rgba(255,255,255,0.08)" }} />
          </div>

          {/* Form */}
          <form onSubmit={handleEmailAuth} className="space-y-4">
            {mode === "signup" && (
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <input
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Full name"
                  required={mode === "signup"}
                  className="w-full glass rounded-xl pl-10 pr-4 py-3 text-sm text-slate-200 placeholder:text-slate-500 outline-none border border-white/5 focus:border-brand-500/50 transition-all"
                  id="auth-fullname-input"
                />
              </div>
            )}

            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email address"
                required
                className="w-full glass rounded-xl pl-10 pr-4 py-3 text-sm text-slate-200 placeholder:text-slate-500 outline-none border border-white/5 focus:border-brand-500/50 transition-all"
                id="auth-email-input"
              />
            </div>

            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                required
                minLength={8}
                className="w-full glass rounded-xl pl-10 pr-12 py-3 text-sm text-slate-200 placeholder:text-slate-500 outline-none border border-white/5 focus:border-brand-500/50 transition-all"
                id="auth-password-input"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
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
                  {mode === "login" ? "Sign In" : "Create Account"}
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          {mode === "login" && (
            <p className="text-center text-xs text-slate-500 mt-4">
              Forgot your password?{" "}
              <button
                onClick={async () => {
                  if (!email) { setError("Enter your email first"); return; }
                  await supabase.auth.resetPasswordForEmail(email, {
                    redirectTo: `${window.location.origin}/auth/reset-password`,
                  });
                  setSuccessMsg("Password reset email sent.");
                }}
                className="text-brand-400 hover:underline"
              >
                Reset it
              </button>
            </p>
          )}
        </div>

        <p className="text-center text-xs text-slate-600 mt-6">
          By continuing, you agree to our Terms of Service & Privacy Policy.
          <br />PDPL-compliant · Data never sold · Evidence stored securely.
        </p>
      </div>
    </div>
  );
}

export default function AuthPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center">Loading...</div>}>
      <AuthForm />
    </Suspense>
  );
}
