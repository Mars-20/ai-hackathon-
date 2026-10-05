"use client";

import { useState } from "react";
import Link from "next/link";
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

const STEPS = [
  {
    icon: <Brain className="w-5 h-5" />,
    label: "Intake",
    desc: "Describe your idea",
    color: "#5c7cfa",
  },
  {
    icon: <Target className="w-5 h-5" />,
    label: "Assumptions",
    desc: "Risk-ranked map",
    color: "#7950f2",
  },
  {
    icon: <Search className="w-5 h-5" />,
    label: "Research",
    desc: "Grounded evidence",
    color: "#9775fa",
  },
  {
    icon: <FlaskConical className="w-5 h-5" />,
    label: "Experiment",
    desc: "Design & validate",
    color: "#74c0fc",
  },
  {
    icon: <Users className="w-5 h-5" />,
    label: "Evidence",
    desc: "Real responses",
    color: "#63e6be",
  },
  {
    icon: <LineChart className="w-5 h-5" />,
    label: "Decision",
    desc: "Go / Iterate / Stop",
    color: "#ffd43b",
  },
];

const FEATURES = [
  {
    icon: <Shield className="w-6 h-6" />,
    title: "Anti-Hallucination Engine",
    desc: "Every claim is grounded to a source URL. A dedicated Verifier model strips unsupported claims before they reach you.",
    color: "#5c7cfa",
  },
  {
    icon: <TrendingUp className="w-6 h-6" />,
    title: "Commitment Ladder",
    desc: "Distinguishes between 'sounds great' (opinion) and 'here's my credit card' (commitment). No false positives.",
    color: "#7950f2",
  },
  {
    icon: <CheckCircle2 className="w-6 h-6" />,
    title: "Bias-Free Surveys",
    desc: "The leading-question validator blocks biased questions before they poison your data. Built on The Mom Test methodology.",
    color: "#40c057",
  },
  {
    icon: <Globe className="w-6 h-6" />,
    title: "Domain-Agnostic",
    desc: "Works for edtech, SaaS, food-tech, health, or any vertical — domain knowledge is fetched at runtime, not hardcoded.",
    color: "#74c0fc",
  },
  {
    icon: <Zap className="w-6 h-6" />,
    title: "Full Trace Panel",
    desc: "Every tool call, source, and verifier check shown in real time. No black box — complete observability.",
    color: "#ffd43b",
  },
  {
    icon: <Sparkles className="w-6 h-6" />,
    title: "Real Evidence Required",
    desc: "The system refuses to output 'Go' without real user evidence. 'Test More' is a valid, honest answer.",
    color: "#ff6b6b",
  },
];

const VERDICTS = [
  { label: "Go", color: "badge-go", icon: "🚀", desc: "Strong evidence supports moving forward" },
  { label: "Iterate", color: "badge-iterate", icon: "🔄", desc: "Some evidence but key assumptions unproven" },
  { label: "Stop", color: "badge-stop", icon: "🛑", desc: "Evidence contradicts core assumptions" },
  { label: "Test More", color: "badge-test", icon: "🔬", desc: "Insufficient evidence to conclude either way" },
];

export default function LandingPage() {
  const [idea, setIdea] = useState("");
  const [isHovered, setIsHovered] = useState<number | null>(null);

  const handleStart = () => {
    if (idea.trim()) {
      window.location.href = `/validate?idea=${encodeURIComponent(idea)}`;
    } else {
      window.location.href = "/validate";
    }
  };

  return (
    <div className="relative min-h-screen">
      {/* ── NAVBAR ── */}
      <nav className="fixed top-0 left-0 right-0 z-50 glass border-b border-white/5">
        <div className="container-app flex items-center justify-between h-14">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-brand-500 to-accent-500 flex items-center justify-center">
              <Brain className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-sm tracking-tight">
              Validation <span className="gradient-text">Copilot</span>
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-500 hidden sm:block">AI-OS Hackathon v2.0</span>
            <Link
              href="/dashboard"
              className="btn-glow text-white text-xs font-semibold px-4 py-2 rounded-lg flex items-center gap-1.5"
            >
              Launch App <ArrowRight className="w-3.5 h-3.5" />
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
            AI-Powered Startup Validation · Real Evidence · No Hallucinations
          </div>

          {/* Headline */}
          <h1 className="text-5xl sm:text-6xl lg:text-7xl font-black leading-tight mb-6 animate-slide-up">
            Stop building{" "}
            <span className="gradient-text">the wrong thing.</span>
          </h1>
          <p className="text-lg sm:text-xl text-slate-400 max-w-2xl mx-auto mb-12 animate-slide-up delay-100">
            Most startups fail not from bad execution, but from{" "}
            <strong className="text-slate-200">unvalidated assumptions</strong>. Validation Copilot maps
            your risks, gathers grounded evidence, and refuses to call anything &ldquo;validated&rdquo; without
            real user data.
          </p>

          {/* Idea input */}
          <div className="max-w-2xl mx-auto mb-8 animate-slide-up delay-200">
            <div className="glass border border-white/10 rounded-2xl p-2 flex flex-col sm:flex-row gap-2 focus-within:border-brand-500/50 transition-all">
              <input
                type="text"
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleStart()}
                placeholder="Describe your startup idea..."
                className="flex-1 bg-transparent px-4 py-3 text-sm text-slate-200 placeholder:text-slate-500 outline-none"
                id="idea-input"
              />
              <button
                onClick={handleStart}
                className="btn-glow text-white font-semibold px-6 py-3 rounded-xl text-sm flex items-center justify-center gap-2 whitespace-nowrap"
                id="start-validation-btn"
              >
                <Brain className="w-4 h-4" />
                Validate Now
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-500 mt-2">
              Or{" "}
              <Link href="/dashboard" className="text-brand-400 hover:underline">
                open the full dashboard
              </Link>{" "}
              to see an example analysis
            </p>
          </div>

          {/* Trust signals */}
          <div className="flex flex-wrap items-center justify-center gap-6 text-xs text-slate-500 animate-fade-in delay-300">
            {["Grounded web research", "Leading-question validator", "Full trace log", "Evidence ladder"].map(
              (f) => (
                <span key={f} className="flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                  {f}
                </span>
              )
            )}
          </div>
        </div>
      </section>

      {/* ── 6-STEP FLOW ── */}
      <section className="py-20 px-6">
        <div className="container-app">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-3">
              The <span className="gradient-text">Golden Path</span>
            </h2>
            <p className="text-slate-400 text-sm max-w-lg mx-auto">
              Six steps from idea to evidence-backed decision memo — all in one session.
            </p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {STEPS.map((step, i) => (
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
                  <span className="text-slate-500 mr-1">{i + 1}.</span>
                  {step.label}
                </div>
                <div className="text-xs text-slate-500">{step.desc}</div>
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
              Built for <span className="gradient-text">rigor</span>, not comfort
            </h2>
            <p className="text-slate-400 text-sm max-w-lg mx-auto">
              Every feature exists to prevent the mistakes that kill startups after months of wasted effort.
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {FEATURES.map((f, i) => (
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
                <h3 className="font-bold text-slate-100 mb-2 text-sm">{f.title}</h3>
                <p className="text-slate-400 text-xs leading-relaxed">{f.desc}</p>
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
                <h2 className="text-3xl font-bold mb-4">
                  Honest decisions,{" "}
                  <span className="gradient-text">every time</span>
                </h2>
                <p className="text-slate-400 text-sm leading-relaxed mb-6">
                  The system never inflates a verdict. If your evidence is thin, it says so — with the
                  next cheapest experiment to run, not false encouragement. Built on the commitment
                  ladder: opinion → intent → time given → contact shared → money committed.
                </p>
                <div className="space-y-3">
                  {VERDICTS.map((v) => (
                    <div
                      key={v.label}
                      className="flex items-center gap-3 p-3 rounded-xl glass"
                    >
                      <span className="text-lg">{v.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className={`badge ${v.color}`}>{v.label}</span>
                        </div>
                        <p className="text-xs text-slate-400">{v.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Evidence ladder visual */}
              <div className="space-y-2">
                <p className="text-xs text-slate-500 mb-4 font-medium uppercase tracking-wider">
                  Commitment Ladder
                </p>
                {[
                  { rung: 1, label: "Opinion", example: "\"Sounds useful!\"", strength: 10, color: "#ff6b6b" },
                  { rung: 2, label: "Stated intent", example: "\"I would probably use this\"", strength: 30, color: "#ffa94d" },
                  { rung: 3, label: "Time given", example: "Agreed to a call / filled survey", strength: 55, color: "#ffd43b" },
                  { rung: 4, label: "Contact shared", example: "Gave email voluntarily", strength: 75, color: "#74c0fc" },
                  { rung: 5, label: "Commitment", example: "Pre-order / deposit / LOI", strength: 100, color: "#51cf66" },
                ].map((r) => (
                  <div key={r.rung} className="flex items-center gap-4">
                    <span className="text-xs text-slate-500 w-4 text-right">{r.rung}</span>
                    <div className="flex-1">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-slate-300">{r.label}</span>
                        <span className="text-xs text-slate-500">{r.example}</span>
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
                <p className="text-xs text-slate-500 mt-4 p-3 glass rounded-lg border-l-2 border-brand-500">
                  ⚠️ Minimum rung-4+ x3 sources, n≥30 (or n≥12 interviews) required before any &ldquo;Go&rdquo; verdict is possible.
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
              Ready to <span className="gradient-text">stop guessing?</span>
            </h2>
            <p className="text-slate-400 text-sm mb-8">
              Describe your idea and get a risk-ranked assumption map, grounded market research, and a
              bias-free validation experiment — in minutes, not weeks.
            </p>
            <Link
              href="/dashboard"
              className="btn-glow text-white font-bold px-8 py-4 rounded-xl text-base inline-flex items-center gap-2"
              id="cta-validate-btn"
            >
              <Brain className="w-5 h-5" />
              Start Validation
              <ArrowRight className="w-5 h-5" />
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
              Validation Copilot · AI-OS Hackathon 2026
            </span>
          </div>
          <div className="flex items-center gap-4 text-xs text-slate-500">
            <span>Built with Gemini + Groq + Supabase</span>
            <span>·</span>
            <span>PDPL-compliant evidence collection</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
