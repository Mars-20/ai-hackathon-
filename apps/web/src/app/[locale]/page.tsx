"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import { withLocale, type AppLocale } from "@/lib/i18n-path";
import {
  ArrowRight,
  Brain,
  CheckCircle2,
  FlaskConical,
  Globe,
  LineChart,
  Search,
  Shield,
  Sparkles,
  Target,
  TrendingUp,
  Users,
  Zap,
} from "lucide-react";

const STEP_META = [
  {
    icon: <Brain className="w-5 h-5" />,
    color: "#5c7cfa",
  },
  {
    icon: <Target className="w-5 h-5" />,
    color: "#7950f2",
  },
  {
    icon: <Search className="w-5 h-5" />,
    color: "#9775fa",
  },
  {
    icon: <FlaskConical className="w-5 h-5" />,
    color: "#74c0fc",
  },
  {
    icon: <Users className="w-5 h-5" />,
    color: "#63e6be",
  },
  {
    icon: <LineChart className="w-5 h-5" />,
    color: "#ffd43b",
  },
];

const FEATURE_META = [
  {
    icon: <Shield className="w-6 h-6" />,
    color: "#5c7cfa",
  },
  {
    icon: <TrendingUp className="w-6 h-6" />,
    color: "#7950f2",
  },
  {
    icon: <CheckCircle2 className="w-6 h-6" />,
    color: "#40c057",
  },
  {
    icon: <Globe className="w-6 h-6" />,
    color: "#74c0fc",
  },
  {
    icon: <Zap className="w-6 h-6" />,
    color: "#ffd43b",
  },
  {
    icon: <Sparkles className="w-6 h-6" />,
    color: "#ff6b6b",
  },
];

const VERDICT_META = [
  { color: "badge-go", icon: "🚀" },
  { color: "badge-iterate", icon: "🔄" },
  { color: "badge-stop", icon: "🛑" },
  { color: "badge-test", icon: "🔬" },
];

const LADDER_META = [
  { strength: 10, color: "#ff6b6b" },
  { strength: 30, color: "#ffa94d" },
  { strength: 55, color: "#ffd43b" },
  { strength: 75, color: "#74c0fc" },
  { strength: 100, color: "#51cf66" },
];

export default function LandingPage() {
  const [idea, setIdea] = useState("");
  const [isHovered, setIsHovered] = useState<number | null>(null);
  const locale = useLocale() as AppLocale;
  const t = useTranslations("landing");

  const handleStart = () => {
    if (idea.trim()) {
      window.location.href = withLocale(`/validate?idea=${encodeURIComponent(idea)}`, locale);
    } else {
      window.location.href = withLocale("/validate", locale);
    }
  };

  const brandParts = t("header.brand").split(" ");
  const brandHead = brandParts[0];
  const brandTail = brandParts.slice(1).join(" ");

  return (
    <div className="relative min-h-dvh">
      {/* ── NAVBAR ── */}
      <nav className="fixed top-0 start-0 end-0 z-50 glass border-b border-white/5 safe-top">
        <div className="container-app flex items-center justify-between h-14">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-brand-500 to-accent-500 flex items-center justify-center">
              <Brain className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-sm tracking-tight">
              {brandHead} <span className="gradient-text">{brandTail}</span>
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500 hidden sm:block">{t("header.version")}</span>
            <Suspense>
              <LanguageSwitcher locale={locale} />
            </Suspense>
            <Link
              href={withLocale("/dashboard", locale)}
              className="btn-glow text-white text-xs font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5"
            >
              {t("header.launch")} <ArrowRight className="w-3.5 h-3.5 rtl:scale-x-[-1]" />
            </Link>
          </div>
        </div>
      </nav>

      {/* ── HERO ── */}
      <section className="pt-32 pb-20 px-6">
        <div className="container-app text-center max-w-4xl mx-auto">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full glass border border-brand-500/30 text-brand-400 text-xs font-medium mb-8 animate-fade-in">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 pulse-dot" />
            {t("hero.eyebrow")}
          </div>

          {/* Headline */}
          <h1 className="text-4xl sm:text-6xl lg:text-7xl font-black leading-tight mb-6 animate-slide-up text-balance">
            {t("hero.titleA")}{" "}
            <span className="gradient-text">{t("hero.titleB")}</span>
          </h1>
          <p className="text-lg sm:text-xl text-slate-400 max-w-2xl mx-auto mb-12 animate-slide-up delay-100">
            {t("hero.subA")}{" "}
            <strong className="text-slate-200">{t("hero.subB")}</strong>
            {t("hero.subC")}
          </p>

          {/* Idea input */}
          <div className="max-w-2xl mx-auto mb-8 animate-slide-up delay-200">
            <div className="glass border border-white/10 rounded-2xl p-2 flex flex-col sm:flex-row gap-2 focus-within:border-brand-500/50 transition-all">
              <input
                type="text"
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleStart()}
                placeholder={t("hero.inputPlaceholder")}
                className="flex-1 bg-transparent px-4 py-3 text-sm text-slate-200 placeholder:text-slate-500 outline-none"
                id="idea-input"
              />
              <button
                onClick={handleStart}
                className="btn-glow text-white font-semibold px-6 py-3 rounded-xl text-sm flex items-center justify-center gap-2 whitespace-nowrap"
                id="start-validation-btn"
              >
                <Brain className="w-4 h-4" />
                {t("hero.primaryCta")}
                <ArrowRight className="w-4 h-4 rtl:scale-x-[-1]" />
              </button>
            </div>
            <p className="text-xs text-slate-500 mt-2">
              {t("hero.orLineA")}{" "}
              <Link href={withLocale("/dashboard", locale)} className="text-brand-400 hover:underline">
                {t("hero.orLineB")}
              </Link>{" "}
              {t("hero.orLineC")}
            </p>
          </div>

          {/* Trust signals */}
          <div className="flex flex-wrap items-center justify-center gap-6 text-xs text-slate-500 animate-fade-in delay-300">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                {t(`trust.${i}`)}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── 6-STEP FLOW ── */}
      <section className="py-20 px-6">
        <div className="container-app">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-3">
              <span className="gradient-text">{t("golden.title")}</span>
            </h2>
            <p className="text-slate-400 text-sm max-w-lg mx-auto">
              {t("golden.sub")}
            </p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {STEP_META.map((step, i) => (
              <div
                key={i}
                className="glass glass-hover rounded-2xl p-5 text-center cursor-default"
                style={{ animationDelay: `${i * 80}ms` }}
                onMouseEnter={() => setIsHovered(i)}
                onMouseLeave={() => setIsHovered(null)}
              >
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center mx-auto mb-3 transition-all duration-300"
                  style={{
                    background: isHovered === i ? step.color : "rgba(255,255,255,0.05)",
                    color: isHovered === i ? "white" : step.color,
                    boxShadow: isHovered === i ? `0 0 20px ${step.color}60` : "none",
                  }}
                >
                  {step.icon}
                </div>
                <div className="text-xs font-bold text-slate-200 mb-1">
                  <span className="text-slate-500 me-1">{i + 1}.</span>
                  {t(`steps.${i}.label`)}
                </div>
                <div className="text-xs text-slate-500">{t(`steps.${i}.desc`)}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FEATURES ── */}
      <section className="py-20 px-6">
        <div className="container-app">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-3">
              <span className="gradient-text">{t("rigor.title")}</span>
            </h2>
            <p className="text-slate-400 text-sm max-w-lg mx-auto">
              {t("rigor.desc")}
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {FEATURE_META.map((f, i) => (
              <div
                key={i}
                className="glass glass-hover rounded-2xl p-6 group"
              >
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center mb-4 transition-all duration-300 group-hover:scale-110"
                  style={{ background: `${f.color}20`, color: f.color }}
                >
                  {f.icon}
                </div>
                <h3 className="font-bold text-slate-100 mb-2 text-sm">{t(`features.${i}.title`)}</h3>
                <p className="text-slate-400 text-xs leading-relaxed">{t(`features.${i}.desc`)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── VERDICT SYSTEM ── */}
      <section className="py-20 px-6">
        <div className="container-app">
          <div className="glass rounded-3xl p-8 lg:p-12 border border-white/5">
            <div className="grid lg:grid-cols-2 gap-12 items-center">
              <div>
            <h2 className="text-3xl font-bold mb-4 text-balance">
                  <span className="gradient-text">{t("honesty.title")}</span>
                </h2>
                <p className="text-slate-400 text-sm leading-relaxed mb-6">
                  {t("honesty.desc")}
                </p>
                <div className="space-y-3">
                  {VERDICT_META.map((v, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-3 p-3 rounded-xl glass"
                    >
                      <span className="text-lg">{v.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className={`badge ${v.color}`}>{t(`verdicts.${i}.name`)}</span>
                        </div>
                        <p className="text-xs text-slate-400">{t(`verdicts.${i}.desc`)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Evidence ladder visual */}
              <div className="space-y-2">
                <p className="text-xs text-slate-500 mb-4 font-medium uppercase tracking-wider">
                  {t("ladder.title")}
                </p>
                {LADDER_META.map((r, i) => (
                  <div key={i} className="flex items-center gap-4">
                    <span className="text-xs text-slate-500 w-4 text-end">{t(`ladder.rows.${i}.rung`)}</span>
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-slate-300">{t(`ladder.rows.${i}.label`)}</span>
                        <span className="text-xs text-slate-500">{t(`ladder.rows.${i}.example`)}</span>
                      </div>
                      <div className="progress-bar">
                        <div
                          className="progress-fill"
                          style={{ width: `${r.strength}%`, background: `linear-gradient(90deg, ${r.color}80, ${r.color})` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
                <p className="text-xs text-slate-500 mt-4 p-3 glass rounded-lg border-s-2 border-brand-500">
                  {t("ladder.note")}
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="py-20 px-6">
        <div className="container-app text-center">
          <div className="inline-block glass rounded-3xl p-12 border border-brand-500/20 max-w-2xl mx-auto">
            <div
              className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6"
              style={{ background: "linear-gradient(135deg, #5c7cfa20, #7950f220)" }}
            >
              <Sparkles className="w-8 h-8 text-brand-400" />
            </div>
            <h2 className="text-3xl font-bold mb-4">
              <span className="gradient-text">{t("final.title")}</span>
            </h2>
            <p className="text-slate-400 text-sm mb-8">
              {t("final.desc")}
            </p>
            <Link
              href={withLocale("/dashboard", locale)}
              className="btn-glow text-white font-bold px-8 py-4 rounded-xl text-base inline-flex items-center gap-2"
              id="cta-dashboard-btn"
            >
              <Brain className="w-5 h-5" />
              {t("final.cta")}
              <ArrowRight className="w-5 h-5 rtl:scale-x-[-1]" />
            </Link>
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="border-t border-white/5 py-8 px-6">
        <div className="container-app flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Brain className="w-4 h-4 text-brand-400" />
            <span className="text-xs text-slate-500">
              {t("footer.brand")}
            </span>
          </div>
          <div className="flex items-center gap-4 text-xs text-slate-500">
            <span>{t("footer.builtWith")}</span>
            <span>·</span>
            <span>{t("footer.pdpl")}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
