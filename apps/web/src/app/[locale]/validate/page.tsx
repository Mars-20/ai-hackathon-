"use client";

import { useState, useRef, useEffect, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import LanguageSwitcher from "@/components/LanguageSwitcher";
import { withLocale, type AppLocale } from "@/lib/i18n-path";
import {
  AlertTriangle,
  ArrowLeft,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Clock,
  ExternalLink,
  FileText,
  FlaskConical,
  Globe,
  History,
  Info,
  Layers,
  LineChart,
  Loader2,
  MessageCircle,
  Search,
  Shield,
  Target,
  TrendingUp,
  Upload,
  Users,
  XCircle,
  Zap,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { createSseParser } from "@/lib/sse-client";
import { StageProgressSection } from "@/components/StageProgressSection";
import type {
  Startup,
  Assumption,
  Evidence,
  Experiment,
  Decision,
  IcpProfile,
  InvestorScorecard,
  TraceEvent,
  SessionPhase,
} from "@/lib/types";
import {
  cn,
  formatMs,
  getVerdictColor,
  getRiskColor,
  STRENGTH_COLOR,
  truncate,
} from "@/lib/utils";

// ── Sub-components ────────────────────────────────────────────────────────────

function PhaseIndicator({ phase }: { phase: SessionPhase }) {
  const tVal = useTranslations("validate");
  const phases: { id: SessionPhase; icon: React.ReactNode }[] = [
    { id: "intake", icon: <Brain className="w-3.5 h-3.5" /> },
    { id: "mapping", icon: <Target className="w-3.5 h-3.5" /> },
    { id: "icp_sizing", icon: <Globe className="w-3.5 h-3.5" /> },
    { id: "research", icon: <Search className="w-3.5 h-3.5" /> },
    { id: "experiment", icon: <FlaskConical className="w-3.5 h-3.5" /> },
    { id: "leads", icon: <Users className="w-3.5 h-3.5" /> },
    { id: "evidence", icon: <Users className="w-3.5 h-3.5" /> },
    { id: "verifying", icon: <Shield className="w-3.5 h-3.5" /> },
    { id: "memo", icon: <LineChart className="w-3.5 h-3.5" /> },
    { id: "investor_readiness", icon: <TrendingUp className="w-3.5 h-3.5" /> },
  ];

  const activeIdx = phases.findIndex((p) => p.id === phase);

  return (
    <div className="flex items-center gap-0">
      {phases.map((p, i) => {
        const isDone = i < activeIdx;
        const isActive = p.id === phase;
        return (
          <div key={p.id} className="flex items-center">
            <div
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all",
                isDone && "text-green-400",
                isActive && "bg-brand-500/20 text-brand-400 border border-brand-500/30",
                !isDone && !isActive && "text-slate-500"
              )}
            >
              {isDone ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
              ) : isActive ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                p.icon
              )}
              <span className="hidden sm:inline">{tVal(`phases.${p.id}`)}</span>
            </div>
            {i < phases.length - 1 && (
              <div
                className={cn(
                  "w-4 h-px mx-0.5 transition-all",
                  i < activeIdx ? "bg-green-500/50" : "bg-slate-700"
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function TracePanel({ events }: { events: TraceEvent[] }) {
  const tVal = useTranslations("validate");
  const [expanded, setExpanded] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  const actorColor: Record<string, string> = {
    router: "#748ffc",
    planner: "#9775fa",
    executor: "#74c0fc",
    verifier: "#ffa94d",
    tool: "#63e6be",
  };

  const getActorColor = (actor: string) => {
    for (const [k, v] of Object.entries(actorColor)) {
      if (actor.startsWith(k)) return v;
    }
    return "#94a3b8";
  };

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-brand-400" />
          <span className="text-xs font-semibold text-slate-300">{tVal("trace.title")}</span>
          <span className="text-xs text-slate-500">{tVal("trace.countPattern", { count: events.length })}</span>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5 font-mono text-xs">
        {events.length === 0 && (
          <div className="text-slate-500 text-center py-8">{tVal("trace.waiting")}</div>
        )}
        {events.map((e) => {
          const color = getActorColor(e.actor);
          const isOpen = expanded === e.id;
          const payloadStr = JSON.stringify(e.payload, null, 2);
          return (
            <div
              key={e.id}
              className="rounded-lg glass overflow-hidden border-s-2"
              style={{ borderInlineStartColor: color }}
            >
              <button
                onClick={() => setExpanded(isOpen ? null : e.id)}
                className="w-full flex items-center gap-2 px-3 py-2 text-start hover:bg-white/5 transition-colors"
              >
                <span style={{ color }} className="font-semibold text-xs shrink-0">
                  {e.actor.replace("skill:", "")}
                </span>
                <span className="text-slate-500 shrink-0">/</span>
                <span className="text-slate-300 truncate">{e.event_type}</span>
                {e.latency_ms !== undefined && (
                  <span className="ms-auto text-slate-500 shrink-0">{formatMs(e.latency_ms)}</span>
                )}
                {isOpen ? (
                  <ChevronUp className="w-3 h-3 text-slate-500 shrink-0" />
                ) : (
                  <ChevronDown className="w-3 h-3 text-slate-500 shrink-0" />
                )}
              </button>
              {isOpen && (
                <div className="px-3 pb-3">
                  <pre className="text-slate-400 text-xs overflow-x-auto whitespace-pre-wrap max-h-48">
                    {truncate(payloadStr, 1500)}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function AssumptionCard({ a, idx }: { a: Assumption; idx: number }) {
  const tVal = useTranslations("validate");
  const [open, setOpen] = useState(false);
  const riskColor = getRiskColor(a.risk_level);
  const catIcons: Record<string, React.ReactNode> = {
    desirability: <Users className="w-3.5 h-3.5" />,
    viability: <TrendingUp className="w-3.5 h-3.5" />,
    feasibility: <Layers className="w-3.5 h-3.5" />,
  };

  return (
    <div
      className="glass rounded-xl overflow-hidden border border-white/5 hover:border-white/10 transition-all animate-slide-up"
      style={{ animationDelay: `${idx * 60}ms`, borderInlineStartColor: riskColor, borderInlineStartWidth: 2 }}
    >
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-start gap-3 p-4 text-start"
      >
        <div className="flex items-center gap-2 flex-wrap flex-1 min-w-0">
          <span
            className="badge shrink-0"
            style={{
              background: `${riskColor}20`,
              color: riskColor,
              border: `1px solid ${riskColor}40`,
            }}
          >
            {a.risk_level}
          </span>
          <span className="flex items-center gap-1 text-xs text-slate-500 shrink-0">
            {catIcons[a.category]}
            {a.category}
          </span>
          <p className="text-sm text-slate-200 truncate flex-1">{a.statement}</p>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-slate-400 shrink-0" /> : <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />}
      </button>
      {open && a.reasoning && (
        <div className="px-4 pb-4">
          <div className="text-xs text-slate-400 p-3 glass rounded-lg border-s-2 border-brand-500/50">
            <strong className="text-brand-400">{tVal("cards.riskWhy")} </strong>
            {a.reasoning}
          </div>
        </div>
      )}
    </div>
  );
}

function EvidenceCard({ e, idx }: { e: Evidence; idx: number }) {
  const tVal = useTranslations("validate");
  const strengthColor = STRENGTH_COLOR[e.strength];
  const strengthKey: Record<string, string> = {
    opinion: "strengthOpinion",
    intent: "strengthIntent",
    time_given: "strengthTimeGiven",
    contact_shared: "strengthContactShared",
    commitment: "strengthCommitment",
  };
  const strengthLabel = tVal(`assistant.errors.${strengthKey[e.strength] ?? "strengthOpinion"}`);
  return (
    <div
      className="glass rounded-xl p-4 border border-white/5 animate-slide-up"
      style={{ animationDelay: `${idx * 40}ms` }}
    >
      <div className="flex items-start gap-3">
        <div
          className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0"
          style={{ background: strengthColor }}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-slate-200 mb-2">{e.claim}</p>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="badge text-xs"
              style={{
                background: `${strengthColor}20`,
                color: strengthColor,
                border: `1px solid ${strengthColor}40`,
              }}
            >
              {strengthLabel}
            </span>
            <span className="text-xs text-slate-500 uppercase tracking-wider">
              {e.evidence_type}
            </span>
            {e.sample_size && e.sample_size > 1 && (
              <span className="text-xs text-slate-500">n={e.sample_size}</span>
            )}
            {(e.grounding_status === "unverified" || e.grounding_status === "quarantined") ? (
              <span className="badge text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/30 ms-auto">
                Unverified — not evidence
              </span>
            ) : (
              e.source_url && (
                <a
                  href={e.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="cite-link ms-auto"
                >
                  <ExternalLink className="w-3 h-3" />
                  {tVal("cards.source")}
                </a>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ExperimentPanel({ exp }: { exp: Experiment }) {
  const tVal = useTranslations("validate");
  const [showQuestions, setShowQuestions] = useState(true);
  return (
    <div className="space-y-4">
      <div className="glass rounded-xl p-5 border border-white/5">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            <h3 className="font-bold text-slate-100 mb-1">{exp.design.title}</h3>
            <p className="text-sm text-slate-400">{exp.design.description}</p>
          </div>
          <span className="badge badge-test shrink-0 capitalize">{exp.type}</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-4">
          {exp.design.target_sample_size && (
            <div className="glass rounded-lg p-3">
              <div className="text-xs text-slate-500 mb-1">{tVal("cards.targetSample")}</div>
              <div className="text-lg font-bold text-brand-400">n≥{exp.design.target_sample_size}</div>
            </div>
          )}
          {exp.design.estimated_cost && (
            <div className="glass rounded-lg p-3">
              <div className="text-xs text-slate-500 mb-1">{tVal("cards.estCost")}</div>
              <div className="text-lg font-bold text-green-400">{exp.design.estimated_cost}</div>
            </div>
          )}
          {exp.design.time_to_run && (
            <div className="glass rounded-lg p-3">
              <div className="text-xs text-slate-500 mb-1">{tVal("cards.timeToRun")}</div>
              <div className="text-sm font-bold text-slate-200">{exp.design.time_to_run}</div>
            </div>
          )}
        </div>
        {exp.design.success_criteria && (
          <div className="mt-3 p-3 glass rounded-lg border-s-2 border-green-500/50">
            <div className="text-xs text-slate-500 mb-1">{tVal("cards.successCriteria")}</div>
            <div className="text-sm text-slate-300">{exp.design.success_criteria}</div>
          </div>
        )}
      </div>

      {exp.design.questions && exp.design.questions.length > 0 && (
        <div>
          <button
            onClick={() => setShowQuestions(!showQuestions)}
            className="flex items-center gap-2 text-sm font-medium text-slate-300 mb-3 hover:text-white transition-colors"
          >
            <ClipboardList className="w-4 h-4 text-brand-400" />
            {tVal("cards.questionsTitle", { count: exp.design.questions.length })}
            {showQuestions ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
          {showQuestions && (
            <div className="space-y-2">
              {exp.design.questions.map((q, i) => (
                <div
                  key={q.id || i}
                  className={cn(
                    "glass rounded-xl p-4 border",
                    q.is_leading ? "border-red-500/30 bg-red-500/5" : "border-white/5"
                  )}
                >
                  <div className="flex items-start gap-3">
                    <span className="text-xs font-bold text-slate-500 shrink-0 mt-0.5">Q{i + 1}</span>
                    <div className="flex-1">
                      <p className="text-sm text-slate-200">{q.text}</p>
                      {q.is_leading && q.warning && (
                        <div className="mt-2 flex items-start gap-1.5 text-xs text-red-400">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          <span>{q.warning}</span>
                        </div>
                      )}
                      {!q.is_leading && (
                        <div className="mt-2 flex items-center gap-1.5 text-xs text-green-400">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>{tVal("cards.biasApproved")}</span>
                        </div>
                      )}
                    </div>
                    <span className="text-xs text-slate-500 capitalize shrink-0">{q.type}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LeadsPanel({ leads, message }: { leads: import("@/lib/apollo").ApolloLead[]; message?: string | null }) {
  const tVal = useTranslations("validate");
  if (leads.length === 0) return null;
  return (
    <div className="space-y-3">
      {message && (
        <p className="text-xs text-slate-400 p-3 glass rounded-xl border-s-2 border-green-500/50">
          {message}
        </p>
      )}
      <div className="grid sm:grid-cols-2 gap-2">
        {leads.map((lead) => (
          <div key={lead.id} className="glass rounded-xl p-4 border border-white/5">
            <div className="font-bold text-slate-200 text-sm mb-0.5">{lead.name}</div>
            <div className="text-xs text-slate-400 mb-1">
              {lead.title}{lead.company ? ` · ${lead.company}` : ""}
            </div>
            <div className="flex flex-wrap gap-2 text-xs text-slate-500">
              {lead.email && <span>✉️ {lead.email}</span>}
              {lead.linkedin_url && (
                <a href={lead.linkedin_url} target="_blank" rel="noopener noreferrer" className="cite-link">
                  <ExternalLink className="w-3 h-3" />
                  LinkedIn
                </a>
              )}
              {[lead.city, lead.country].filter(Boolean).join(", ") && (
                <span>📍 {[lead.city, lead.country].filter(Boolean).join(", ")}</span>
              )}
            </div>
            {lead.headline && (
              <p className="text-xs text-slate-500 mt-2 line-clamp-2">{lead.headline}</p>
            )}
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-500">
        {tVal("leads.notice")}
      </p>
    </div>
  );
}

function IcpProfileCard({ profile }: { profile: IcpProfile }) {
  const tVal = useTranslations("validate");
  const dims: { id: "role" | "context" | "pain" | "workaround" | "authority"; value: string }[] = [
    { id: "role", value: profile.role_title },
    { id: "context", value: profile.context },
    { id: "pain", value: profile.pain },
    { id: "workaround", value: profile.workaround },
    { id: "authority", value: profile.buying_authority },
  ];
  const markets: { id: "tam" | "sam" | "som"; value: string; note?: string }[] = [
    { id: "tam", value: profile.tam.value, note: profile.tam.source_url },
    { id: "sam", value: profile.sam.value, note: profile.sam.source_note },
    { id: "som", value: profile.som.value, note: profile.som.basis },
  ];
  return (
    <div className="glass rounded-xl p-4 border border-white/5 animate-slide-up">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="text-sm font-bold text-slate-200">{profile.role_title}</span>
        {profile.preliminary && (
          <span className="badge text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/30">
            {tVal("icp.preliminary")}
          </span>
        )}
      </div>
      <div className="space-y-2 mb-3">
        {dims.map((d) => (
          <div key={d.id} className="flex gap-2 text-sm">
            <span className="text-xs text-slate-500 uppercase tracking-wider shrink-0 w-28">{tVal(`icp.${d.id}`)}</span>
            <span className="text-sm text-slate-200">{d.value}</span>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {markets.map((m) => (
          <div key={m.id} className="glass rounded-lg p-3">
            <div className="text-xs text-slate-500 mb-1">{tVal(`icp.${m.id}`)}</div>
            <div className="text-sm font-bold text-slate-100">{m.value}</div>
            {m.note && <div className="text-xs text-slate-500 mt-1 truncate">{m.note}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function InvestorScorecardCard({ scorecard }: { scorecard: InvestorScorecard }) {
  const tVal = useTranslations("validate");
  const fitColor: Record<string, string> = {
    fundable: "#22c55e",
    not_yet: "#eab308",
    unfit: "#ef4444",
  };
  const color = fitColor[scorecard.verdict_fit] ?? "#94a3b8";
  return (
    <div
      className="glass rounded-2xl p-6 border animate-slide-up"
      style={{ borderColor: `${color}40` }}
    >
      <div className="flex items-center gap-3 mb-4">
        <span
          className="text-3xl font-black uppercase tracking-wider"
          style={{ color }}
        >
          {scorecard.overall_1_10}/10
        </span>
        <span
          className="badge"
          style={{ background: `${color}20`, color, border: `1px solid ${color}40` }}
        >
          {scorecard.verdict_fit.replace("_", " ")}
        </span>
      </div>
      <div className="space-y-2 mb-4">
        {scorecard.signals.map((s) => (
          <div key={s.key} className="flex items-start gap-2 text-sm">
            <span className="text-xs text-slate-500 uppercase tracking-wider shrink-0 w-28">
              {s.key.replace("_", " ")}
            </span>
            <span className="text-sm font-bold text-slate-100 shrink-0 w-8">{s.score_1_10}/10</span>
            <span className="text-sm text-slate-400">{s.note}</span>
          </div>
        ))}
      </div>
      {scorecard.top_gaps.length > 0 && (
        <div className="p-3 glass rounded-lg border-s-2 border-yellow-500/50">
          <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">{tVal("investor.topGaps")}</div>
          <ul className="text-sm text-slate-300 list-disc list-inside">
            {scorecard.top_gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function DecisionMemoPanel({ decision }: { decision: Decision }) {
  const tVal = useTranslations("validate");
  const tShared = useTranslations("shared");
  const verdictColor = getVerdictColor(decision.verdict);
  const verdictEmoji: Record<string, string> = {
    go: "🚀",
    iterate: "🔄",
    stop: "🛑",
    test_more: "🔬",
  };

  return (
    <div className="glass rounded-2xl p-6 border animate-slide-up" style={{ borderColor: `${verdictColor}40` }}>
      <div className="flex items-center gap-4 mb-6">
        <div
          className="w-16 h-16 rounded-2xl flex items-center justify-center text-3xl"
          style={{ background: `${verdictColor}20` }}
        >
          {verdictEmoji[decision.verdict]}
        </div>
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span
              className="text-3xl font-black uppercase tracking-wider"
              style={{ color: verdictColor }}
            >
              {tShared(`verdicts.${decision.verdict === "test_more" ? "testMore" : decision.verdict}`)}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span
              className="badge"
              style={{
                background: `${verdictColor}20`,
                color: verdictColor,
                border: `1px solid ${verdictColor}40`,
              }}
            >
              {decision.confidence} {tVal("decision.confidence")}
            </span>
            {decision.sample_size !== undefined && decision.sample_size > 0 && (
              <span className="text-xs text-slate-500">n={decision.sample_size}</span>
            )}
            {decision.response_rate !== undefined && (
              <span className="text-xs text-slate-500">{tVal("decision.responsePattern", { rate: decision.response_rate })}</span>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">{tVal("decision.rationale")}</div>
          <p className="text-sm text-slate-300 leading-relaxed">{decision.rationale}</p>
        </div>

        {decision.next_experiment && (
          <div className="p-4 glass rounded-xl border-s-2 border-brand-500/60">
            <div className="text-xs text-slate-500 uppercase tracking-wider mb-1">
              {tVal("decision.nextExperiment")}
            </div>
            <p className="text-sm text-slate-200">{decision.next_experiment}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────

function ValidateDashboard() {
  const searchParams = useSearchParams();
  const locale = useLocale() as AppLocale;
  const t = useTranslations("nav");
  const tVal = useTranslations("validate");
  const tShared = useTranslations("shared");
  // Stage keys from the API resolve to shared.stages labels by id (lib UNTOUCHED).
  const stageLabel = (key: string, fb: string) => {
    try {
      const v = tShared(`stages.${key}`);
      return v === `stages.${key}` ? fb : v;
    } catch {
      return fb;
    }
  };
  const initialIdea = searchParams.get("idea") ?? "";
  const startupIdParam = searchParams.get("startup_id") ?? "";

  const [idea, setIdea] = useState(initialIdea);
  const [uploadedData, setUploadedData] = useState("");
  const [phase, setPhase] = useState<SessionPhase>("idle");
  const [startup, setStartup] = useState<Startup | null>(null);
  // Task 7: intake clarifying_questions (<=3) streamed on the startup frame.
  const [questions, setQuestions] = useState<string[]>([]);
  const [assumptions, setAssumptions] = useState<Assumption[]>([]);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [experiment, setExperiment] = useState<Experiment | null>(null);
  const [leads, setLeads] = useState<import("@/lib/apollo").ApolloLead[]>([]);
  const [leadsMessage, setLeadsMessage] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [icpProfile, setIcpProfile] = useState<IcpProfile | null>(null);
  const [scorecard, setScorecard] = useState<InvestorScorecard | null>(null);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Snapshot persistence notice: set when the server save fails and the
  // snapshot is kept in this browser only, so the user is never left
  // believing server history has it.
  const [persistNotice, setPersistNotice] = useState<string | null>(null);
  // Trial paywall (Task 7): locks the run composer when the loaded startup
  // is frozen or the account is consumed/paused. Reads stay untouched.
  const [paywallFrozen, setPaywallFrozen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"results" | "trace">("results");
  const [stats, setStats] = useState<{
    tool_calls?: number;
    evidence_count?: number;
    verifier_approved?: boolean;
    unsupported_claims?: number;
  }>({});

  const abortRef = useRef<AbortController | null>(null);

  // Resume: load ?startup_id= via /api/history detail, fallback to localStorage.
  useEffect(() => {
    if (!startupIdParam) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/history?startup_id=${encodeURIComponent(startupIdParam)}`);
        if (!res.ok) throw new Error(`history ${res.status}`);
        const json = await res.json();
        const s = json.data;
        if (!s || cancelled) return;
        setStartup(s);
        setAssumptions(s.assumptions ?? []);
        setEvidence(s.evidence ?? []);
        setExperiment(s.experiments?.[0] ?? s.experiment ?? null);
        setLeads([]);
        setLeadsMessage(null);
        setDecision(s.decisions?.[0] ?? s.decision ?? null);
        setPhase("done");
      } catch {
        try {
          const raw = localStorage.getItem(`startup:${startupIdParam}`);
          if (!raw || cancelled) return;
          const saved = JSON.parse(raw);
          if (saved.startup) setStartup(saved.startup);
          if (saved.assumptions) setAssumptions(saved.assumptions);
          if (saved.evidence) setEvidence(saved.evidence);
          if (saved.experiment) setExperiment(saved.experiment);
          if (saved.decision) {
            setDecision(saved.decision);
            setPhase("done");
          }
        } catch {}
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [startupIdParam]);

  // Trial paywall (Task 7): entitlement is fetched FRESH on each navigation
  // (no cross-navigation caching). Consumed/paused accounts — or a loaded
  // startup whose id is frozen — lock the run composer. Fail-open for reads:
  // on fetch failure reset to unfrozen (banner hidden, run enabled); the
  // SERVER remains the enforcement authority on submit.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/entitlements/me", { cache: "no-store" });
        if (cancelled) return;
        if (!res.ok) {
          if (!cancelled) setPaywallFrozen(false);
          console.warn("[paywall] entitlement fetch failed:", res.status);
          return;
        }
        const ent = (await res.json()) as {
          status?: string;
          frozen_startup_ids?: string[];
        };
        if (cancelled) return;
        const loadedId = startup?.id ?? (startupIdParam || null);
        if (ent.status === "trial_consumed" || ent.status === "paused") {
          setPaywallFrozen(true);
        } else if (
          loadedId &&
          Array.isArray(ent.frozen_startup_ids) &&
          ent.frozen_startup_ids.includes(loadedId)
        ) {
          setPaywallFrozen(true);
        } else {
          setPaywallFrozen(false);
        }
      } catch (err) {
        // Fail-open for reads: clear any stale frozen lock; the SERVER still
        // enforces on submit.
        if (!cancelled) setPaywallFrozen(false);
        console.warn("[paywall] entitlement fetch error:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [startup?.id, startupIdParam]);

  const persistStartupSnapshot = useCallback(
    async (snapshot: {
      startup: Startup;
      assumptions: Assumption[];
      evidence: Evidence[];
      experiment: Experiment | null;
      decision: Decision | null;
    }) => {
      // Prefer server persistence; fall back to localStorage when the
      // endpoint does not exist (e.g. 404) or the request fails — and say
      // so, so a device-local snapshot is never mistaken for server history.
      try {
        const saveRes = await fetch("/api/startups/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ startup: snapshot.startup }),
        });
        if (!saveRes.ok) throw new Error(`save ${saveRes.status}`);
        setPersistNotice(null);
      } catch {
        try {
          localStorage.setItem(`startup:${snapshot.startup.id}`, JSON.stringify(snapshot));
          setPersistNotice("offlineSnapshot");
        } catch {
          setPersistNotice("saveFailed");
        }
      }
    },
    []
  );

  const runAgent = useCallback(async () => {
    if (!idea.trim() || isLoading) return;
    setIsLoading(true);
    setError(null);
    setPersistNotice(null);
    setStartup(null);
    setQuestions([]);
    setAssumptions([]);
    setEvidence([]);
    setExperiment(null);
    setLeads([]);
    setLeadsMessage(null);
    setDecision(null);
    // Reset skill cards: a skip path (verdict stop/test_more) emits no new
    // scorecard, so a previous run's card must not linger on screen.
    setIcpProfile(null);
    setScorecard(null);
    setTrace([]);
    setPhase("intake");
    setStats({});

    abortRef.current = new AbortController();

    // Identity from Supabase session (browser env uses NEXT_PUBLIC_ keys via
    // the shared client). Never invent or hardcode a user id.
    let workspace_id: string | undefined;
    let user_id: string | undefined;
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      user_id = session?.user?.id;
      const stored = localStorage.getItem("active_workspace_id");
      if (stored) {
        workspace_id = stored;
      } else if (user_id) {
        const { data: memberships } = await supabase
          .from("workspace_members")
          .select("workspace_id")
          .eq("user_id", user_id)
          .limit(1);
        workspace_id = (memberships as Array<{ workspace_id: string }> | null)?.[0]?.workspace_id;
      }
    } catch {}

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idea, uploaded_data: uploadedData, workspace_id, user_id }),
        signal: abortRef.current.signal,
      });

      // Non-SSE pre-flight rejections (429 rate-limit, 402 budget): surface
      // the JSON error instead of hanging on an empty stream.
      if (!res.ok) {
        let message = tVal("serverErrors.statusPattern", { status: res.status });
        try {
          const errBody = (await res.json()) as { error?: unknown; retryAfter?: unknown };
          if (typeof errBody.error === "string" && errBody.error) message = errBody.error;
          if (typeof errBody.retryAfter === "number" && errBody.retryAfter > 0) {
            message += ` ${tVal("serverErrors.retryIn", { seconds: errBody.retryAfter })}`;
          }
        } catch {
          // keep default message
        }
        setError(message);
        setPhase("error");
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      // Buffered SSE parsing (lib/sse-client): a `done` event straddling
      // two TCP chunks used to die in JSON.parse and freeze the UI with no
      // verdict and no error. Frames are reassembled before parsing, and
      // the terminal guard below surfaces streams that die mid-run.
      const sse = createSseParser();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const events = sse.push(decoder.decode(value, { stream: true }));

        for (const event of events) {
          const data = event as unknown as {
            type: string;
            phase?: SessionPhase;
            trace?: TraceEvent[];
            startup?: Startup;
            questions?: unknown;
            assumptions?: Assumption[];
            evidence?: Evidence[];
            experiment?: Experiment;
            leads?: import("@/lib/apollo").ApolloLead[];
            decision?: Decision;
            icp_profile?: IcpProfile;
            investor_scorecard?: InvestorScorecard;
            stats?: {
              tool_calls?: number;
              evidence_count?: number;
              verifier_approved?: boolean;
              unsupported_claims?: number;
            };
            message?: unknown;
          };

          switch (data.type) {
              case "phase":
                if (data.phase) setPhase(data.phase);
                if (data.trace) setTrace([...data.trace]);
                break;
              case "startup":
                setStartup(data.startup ?? null);
                if (Array.isArray(data.questions)) setQuestions(data.questions.slice(0, 3));
                if (data.trace) setTrace([...data.trace]);
                break;
              case "assumptions":
                if (data.assumptions) setAssumptions(data.assumptions);
                if (data.trace) setTrace([...data.trace]);
                break;
              case "evidence":
              case "primary_evidence":
                if (data.evidence) {
                  const incoming = data.evidence;
                  setEvidence((prev) => {
                    const newIds = new Set(incoming.map((e) => e.id));
                    const filtered = prev.filter((e) => !newIds.has(e.id));
                    return [...filtered, ...incoming];
                  });
                }
                if (data.trace) setTrace([...data.trace]);
                break;
              case "experiment":
                setExperiment(data.experiment ?? null);
                if (data.trace) setTrace([...data.trace]);
                break;
              case "leads":
                if (Array.isArray(data.leads)) setLeads(data.leads);
                if (typeof data.message === "string") setLeadsMessage(data.message);
                if (data.trace) setTrace([...data.trace]);
                break;
              case "icp_profile":
                if (data.icp_profile) setIcpProfile(data.icp_profile);
                if (data.trace) setTrace([...data.trace]);
                break;
              case "investor_scorecard":
                if (data.investor_scorecard) setScorecard(data.investor_scorecard);
                if (data.trace) setTrace([...data.trace]);
                break;
              case "done":
                setStartup(data.startup ?? null);
                if (data.assumptions) setAssumptions(data.assumptions);
                if (data.evidence) setEvidence(data.evidence);
                setExperiment(data.experiment ?? null);
                if (Array.isArray(data.leads)) setLeads(data.leads);
                if (typeof data.message === "string") setLeadsMessage(data.message);
                setDecision(data.decision ?? null);
                // Explicit hydration: a skip path sends no scorecard, so clear
                // any state rather than leaving a stale card from a prior run.
                setIcpProfile(data.icp_profile ?? null);
                setScorecard(data.investor_scorecard ?? null);
                if (data.trace) setTrace(data.trace);
                setStats(data.stats || {});
                setPhase("done");
                if (data.startup) {
                  const snapshotStartup = data.startup;
                  void persistStartupSnapshot({
                    startup: snapshotStartup,
                    assumptions: data.assumptions ?? [],
                    evidence: data.evidence ?? [],
                    experiment: data.experiment ?? null,
                    decision: data.decision ?? null,
                  });
                }
                break;
              case "error":
                setError(typeof data.message === "string" ? data.message : tShared("errors.agentRunFailed"));
                setPhase("error");
                if (data.trace) setTrace([...data.trace]);
                break;
            }
          }
        }
        // Terminal guard: the stream ended with no `done`/`error` (platform
        // kill, dropped connection, lost frames). Never freeze silently —
        // surface it so the user can retry instead of staring at a dead UI.
        if (!sse.hasTerminalEvent()) {
          setError(tVal("serverErrors.streamEnded"));
          setPhase("error");
        }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(String(err));
        setPhase("error");
      }
    } finally {
      setIsLoading(false);
    }
  }, [idea, uploadedData, isLoading, persistStartupSnapshot, tVal, tShared]);

  const handleStop = () => {
    abortRef.current?.abort();
    setIsLoading(false);
    if (phase !== "done") setPhase("idle");
  };

  const primaryEvidence = evidence.filter((e) => e.evidence_type === "primary");
  const secondaryEvidence = evidence.filter((e) => e.evidence_type === "secondary");

  return (
    <div className="min-h-dvh flex flex-col">
      {/* ── Top bar ── */}
      <header className="glass border-b border-white/5 sticky top-0 z-40 safe-top">
        <div className="container-app h-14 flex items-center gap-4">
          <Link href={withLocale("/dashboard", locale)} className="flex items-center gap-2 text-slate-400 hover:text-slate-200 transition-colors">
            <ArrowLeft className="w-4 h-4" />
            <Brain className="w-5 h-5 text-brand-400" />
            <span className="font-bold text-sm">
              Validation <span className="gradient-text">Copilot</span>
            </span>
          </Link>

          <div className="flex-1 overflow-x-auto">
            {isLoading || phase !== "idle" ? (
              <PhaseIndicator phase={phase} />
            ) : (
              <span className="text-xs text-slate-500">{tVal("header.readyTitle")}</span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Suspense>
              <LanguageSwitcher locale={locale} />
            </Suspense>
            <Link
              href={withLocale("/assistant", locale)}
              className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg text-slate-400 hover:text-slate-200 glass transition-colors"
              id="validate-assistant-link"
              title={t("assistant")}
            >
              <MessageCircle className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t("assistant")}</span>
            </Link>
            <Link
              href={withLocale("/history", locale)}
              className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg text-slate-400 hover:text-slate-200 glass transition-colors"
              id="validate-history-link"
              title={t("history")}
            >
              <History className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t("history")}</span>
            </Link>
            {stats.verifier_approved !== undefined && (
              <div className={cn(
                "flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg",
                stats.verifier_approved ? "text-green-400 bg-green-500/10" : "text-yellow-400 bg-yellow-500/10"
              )}>
                <Shield className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{tVal("header.verifier")}</span> {stats.verifier_approved ? tVal("header.verifierOk") : tVal("header.verifierFlags", { count: stats.unsupported_claims ?? 0 })}
              </div>
            )}
            {stats.tool_calls !== undefined && (
              <div className="hidden sm:block text-xs text-slate-500 px-2 py-1 glass rounded-lg">
                {tVal("header.callsUsed", { used: stats.tool_calls, max: 15 })}
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="flex-1 flex flex-col lg:flex-row">
        {/* ── Left sidebar — Input ── */}
        <aside className="w-full lg:w-80 lg:shrink-0 glass border-b lg:border-b-0 lg:border-e border-white/5 p-4 flex flex-col gap-4 lg:overflow-y-auto">
          <div>
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 block">
              {tVal("form.ideaLabel")}
            </label>
            <textarea
              id="idea-textarea"
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
              placeholder={tVal("form.ideaPlaceholder")}
              rows={6}
              className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm text-slate-200 placeholder:text-slate-500 outline-none focus:border-brand-500/50 resize-none transition-colors"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Upload className="w-3.5 h-3.5" />
              {tVal("form.evidenceLabel")}
            </label>
            <textarea
              id="evidence-textarea"
              value={uploadedData}
              onChange={(e) => setUploadedData(e.target.value)}
              placeholder={tVal("form.evidencePlaceholder")}
              rows={5}
              className="w-full bg-white/5 border border-white/10 rounded-xl p-3 text-sm text-slate-200 placeholder:text-slate-500 outline-none focus:border-brand-500/50 resize-none transition-colors"
            />
            <p className="text-xs text-slate-500 mt-1">
              {tVal("form.evidenceHint")}
            </p>
          </div>

          {/* Trial paywall (Task 7): frozen banner — reads untouched, run locked. */}
          {paywallFrozen && (
            <div dir={locale === "ar" ? "rtl" : "ltr"} className="glass rounded-xl p-4 border border-brand-500/30">
              <p className="text-sm text-slate-200 mb-3">
                {tVal("paywall.title")}
              </p>
              <Link
                href={withLocale("/plans", locale)}
                id="paywall-cta"
                className="btn-glow text-white text-sm font-bold px-4 py-2 rounded-xl inline-flex items-center justify-center w-full"
              >
                {tVal("paywall.cta")}
              </Link>
            </div>
          )}

          <button
            onClick={isLoading ? handleStop : runAgent}
            disabled={(!idea.trim() && !isLoading) || (paywallFrozen && !isLoading)}
            id="run-agent-btn"
            className={cn(
              "w-full py-3 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-all",
              isLoading
                ? "bg-red-500/20 border border-red-500/30 text-red-400 hover:bg-red-500/30"
                : "btn-glow text-white disabled:opacity-40 disabled:cursor-not-allowed"
            )}
          >
            {isLoading ? (
              <>
                <XCircle className="w-4 h-4" />
                {tVal("controls.stop")}
              </>
            ) : (
              <>
                <Brain className="w-4 h-4" />
                {tVal("controls.run")}
              </>
            )}
          </button>

          {/* Example ideas */}
          <div>
            <div className="text-xs text-slate-500 mb-2">{tVal("controls.examplesTitle")}</div>
            <div className="space-y-1.5">
              {[0, 1, 2].map((i) => {
                const ex = tVal(`controls.examples.${i}`);
                return (
                <button
                  key={i}
                  onClick={() => setIdea(ex)}
                  className="w-full text-start text-xs text-slate-400 hover:text-brand-400 p-2 rounded-lg hover:bg-brand-500/10 transition-colors"
                >
                  {ex}
                </button>
                );
              })}
            </div>
          </div>

          {/* Stats */}
          {phase === "done" && (
            <div className="space-y-2 pt-2 border-t border-white/5">
              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">{tVal("stats.title")}</div>
              <div className="grid grid-cols-2 gap-2">
                <div className="glass rounded-lg p-2 text-center">
                  <div className="text-base font-bold text-brand-400">{evidence.length}</div>
                  <div className="text-xs text-slate-500">{tVal("stats.evidence")}</div>
                </div>
                <div className="glass rounded-lg p-2 text-center">
                  <div className="text-base font-bold text-slate-200">{assumptions.length}</div>
                  <div className="text-xs text-slate-500">{tVal("stats.assumptions")}</div>
                </div>
              </div>
            </div>
          )}
        </aside>

        {/* ── Main content ── */}
        <main className="flex-1 min-w-0 flex flex-col">
          {/* Tab bar */}
          <div className="flex items-center gap-1 px-4 pt-3 pb-0 border-b border-white/5">
            {(["results", "trace"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  "px-4 py-2 rounded-t-lg text-sm font-medium transition-all border-b-2",
                  activeTab === tab
                    ? "text-brand-400 border-brand-500 bg-brand-500/10"
                    : "text-slate-500 border-transparent hover:text-slate-300"
                )}
              >
                {tab === "results" ? (
                  <span className="flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5" />
                    {tVal("tabs.results")}
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5" />
                    {tVal("tabs.trace")}
                    {trace.length > 0 && (
                      <span className="text-xs bg-brand-500/20 text-brand-400 px-1.5 py-0.5 rounded-full">
                        {trace.length}
                      </span>
                    )}
                  </span>
                )}
              </button>
            ))}
          </div>

          {activeTab === "trace" ? (
            <div className="flex-1 min-h-0">
              <TracePanel events={trace} />
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-4 space-y-6">
              {/* Idle state */}
              {phase === "idle" && !startup && (
                <div className="flex flex-col items-center justify-center h-full min-h-80 text-center">
                  <div className="w-16 h-16 rounded-2xl bg-brand-500/10 flex items-center justify-center mb-4">
                    <Brain className="w-8 h-8 text-brand-400" />
                  </div>
                  <h2 className="text-xl font-bold text-slate-200 mb-2">{tVal("idle.title")}</h2>
                  <p className="text-slate-400 text-sm max-w-sm">
                    {tVal("idle.descA")}{" "}
                    <strong className="text-brand-400">{tVal("controls.run")}</strong> {tVal("idle.descC")}
                  </p>
                  <div className="mt-6 flex flex-wrap gap-3 justify-center text-xs text-slate-500">
                    {[0, 1, 2, 3].map((i) => (
                      <span key={i} className="flex items-center gap-1.5 glass px-3 py-1.5 rounded-full">
                        <CheckCircle2 className="w-3 h-3 text-green-400" />
                        {tVal(`idle.bullets.${i}`)}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Error state */}
              {error && (
                <div className="glass rounded-xl p-4 border border-red-500/30 flex items-start gap-3">
                  <XCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="text-sm font-semibold text-red-400 mb-1">{tVal("results.agentError")}</div>
                    <div className="text-sm text-slate-300">{error}</div>
                    <div className="text-xs text-slate-500 mt-2">
                      {tVal("results.apiKeyHint")}
                    </div>
                  </div>
                </div>
              )}

              {/* Local-only snapshot notice (server save failed) */}
              {persistNotice && (
                <div className="glass rounded-xl p-4 border border-amber-500/30 flex items-start gap-3">
                  <XCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="text-sm font-semibold text-amber-400 mb-1">{tVal("results.browserOnly")}</div>
                    <div className="text-sm text-slate-300">{persistNotice ? tVal(`serverErrors.${persistNotice}`) : null}</div>
                  </div>
                </div>
              )}

              {/* Loading skeleton */}
              {isLoading && !startup && (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="glass rounded-xl p-5">
                      <div className="shimmer h-4 rounded-lg mb-3 w-1/3" style={{ background: "rgba(255,255,255,0.05)" }} />
                      <div className="shimmer h-3 rounded mb-2" style={{ background: "rgba(255,255,255,0.03)" }} />
                      <div className="shimmer h-3 rounded w-2/3" style={{ background: "rgba(255,255,255,0.03)" }} />
                    </div>
                  ))}
                </div>
              )}

              {/* Startup card */}
              {startup && (
                <section className="animate-fade-in">
                  <div className="glass rounded-2xl p-5 border border-white/5">
                    <div className="flex items-start gap-4">
                      <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-brand-500/30 to-accent-500/30 flex items-center justify-center shrink-0">
                        <Globe className="w-6 h-6 text-brand-400" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <h2 className="text-xl font-bold text-slate-100 mb-1">{startup.name}</h2>
                        <p className="text-slate-300 text-sm mb-3">{startup.one_liner}</p>
                        <div className="flex flex-wrap gap-2">
                          <span className="text-xs glass px-2.5 py-1 rounded-full text-slate-300">
                            📍 {startup.domain}
                          </span>
                          {startup.target_customer && (
                            <span className="text-xs glass px-2.5 py-1 rounded-full text-slate-300">
                              👤 {startup.target_customer}
                            </span>
                          )}
                          <span className="text-xs glass px-2.5 py-1 rounded-full text-slate-300 capitalize">
                            🚦 {stageLabel(startup.stage, startup.stage)}
                          </span>
                          {startup.business_model && (
                            <span className="text-xs glass px-2.5 py-1 rounded-full text-slate-300">
                              💰 {startup.business_model}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </section>
              )}

              {/* Project progress: stepper + hybrid suggestion + track picker */}
              {startup?.id && (
                <StageProgressSection
                  startupId={startup.id}
                  stage={startup.stage}
                  track={startup.stage_track ?? null}
                  customOrder={startup.stage_order ?? null}
                  onStageChange={(to) =>
                    setStartup((prev) => (prev ? { ...prev, stage: to } : prev))
                  }
                  onTrackChange={(t) =>
                    setStartup((prev) => (prev ? { ...prev, stage_track: t } : prev))
                  }
                />
              )}

              {/* Task 7: intake clarifying_questions frame (<=3, never guessed) */}
              {questions.length > 0 && (
                <section className="animate-fade-in">
                  <div className="glass rounded-2xl p-5 border border-white/5">
                    <div className="text-xs text-slate-500 uppercase tracking-wider mb-2">
                      {tVal("results.clarifying")}
                    </div>
                    <ul className="space-y-1.5">
                      {questions.map((q, i) => (
                        <li key={i} className="text-sm text-slate-200">• {q}</li>
                      ))}
                    </ul>
                  </div>
                </section>
              )}

              {/* Assumption map */}
              {assumptions.length > 0 && (
                <section>
                  <div className="flex items-center gap-2 mb-3">
                    <Target className="w-4 h-4 text-brand-400" />
                    <h3 className="font-bold text-slate-200 text-sm">
                      {tVal("results.assumptionMap", { count: assumptions.length })}
                    </h3>
                    {isLoading && phase === "mapping" && (
                      <Loader2 className="w-3.5 h-3.5 text-slate-500 animate-spin" />
                    )}
                  </div>
                  <div className="space-y-2">
                    {assumptions.map((a, i) => (
                      <AssumptionCard key={a.id} a={a} idx={i} />
                    ))}
                  </div>
                </section>
              )}

              {/* Secondary Evidence */}
              {secondaryEvidence.length > 0 && (
                <section>
                  <div className="flex items-center gap-2 mb-3">
                    <Search className="w-4 h-4 text-brand-400" />
                    <h3 className="font-bold text-slate-200 text-sm">
                      {secondaryEvidence.length === 0
                        ? tVal("assistant.errors.researchEmpty")
                        : (() => {
                            const grounded = secondaryEvidence.filter(
                              (e) => e.source_type === "web_search" && !!e.source_url && e.grounding_status !== "unverified" && e.grounding_status !== "quarantined"
                            ).length;
                            const count = secondaryEvidence.length;
                            if (grounded === count)
                              return tVal("assistant.errors.researchGrounded", { count });
                            if (grounded === 0)
                              return tVal("assistant.errors.researchUnverified", { count });
                            return tVal("assistant.errors.researchPartial", { count, grounded });
                          })()}
                    </h3>
                    <div className="flex items-center gap-1 text-xs text-slate-500 ms-auto">
                      <Info className="w-3 h-3" />
                      {tVal("results.secondaryOnly")}
                    </div>
                  </div>
                  <div className="space-y-2">
                    {secondaryEvidence.slice(0, 8).map((e, i) => (
                      <EvidenceCard key={e.id} e={e} idx={i} />
                    ))}
                    {secondaryEvidence.length > 8 && (
                      <p className="text-xs text-slate-500 text-center py-2">
                        {tVal("results.moreItems", { count: secondaryEvidence.length - 8 })}
                      </p>
                    )}
                  </div>
                </section>
              )}

              {/* ICP & Market */}
              {icpProfile && (
                <section>
                  <div className="flex items-center gap-2 mb-3">
                    <Globe className="w-4 h-4 text-brand-400" />
                    <h3 className="font-bold text-slate-200 text-sm">{tVal("results.icpTitle")}</h3>
                  </div>
                  <IcpProfileCard profile={icpProfile} />
                </section>
              )}

              {/* Experiment */}
              {experiment && (
                <section>
                  <div className="flex items-center gap-2 mb-3">
                    <FlaskConical className="w-4 h-4 text-brand-400" />
                    <h3 className="font-bold text-slate-200 text-sm">{tVal("results.experimentTitle")}</h3>
                  </div>
                  <ExperimentPanel exp={experiment} />
                </section>
              )}

              {/* Leads — Apollo shortlist for manual outreach */}
              {(leads.length > 0 || leadsMessage || phase === "leads") && (
                <section>
                  <div className="flex items-center gap-2 mb-3">
                    <Users className="w-4 h-4 text-green-400" />
                    <h3 className="font-bold text-slate-200 text-sm">
                      {tVal("results.leadsTitle")} {leads.length > 0 && tVal("results.leadsFound", { count: leads.length })}
                    </h3>
                    {phase === "leads" && leads.length === 0 && !leadsMessage && (
                      <Loader2 className="w-3.5 h-3.5 text-slate-500 animate-spin" />
                    )}
                  </div>
                  {leads.length > 0 ? (
                    <LeadsPanel leads={leads} message={leadsMessage} />
                  ) : leadsMessage ? (
                    <p className="text-xs text-slate-400 p-3 glass rounded-xl border-s-2 border-yellow-500/50">
                      {leadsMessage}
                    </p>
                  ) : (
                    <p className="text-xs text-slate-500 p-3 glass rounded-xl">
                      {tVal("results.leadsSearching")}
                    </p>
                  )}
                </section>
              )}

              {/* Primary Evidence */}
              {primaryEvidence.length > 0 && (
                <section>
                  <div className="flex items-center gap-2 mb-3">
                    <Users className="w-4 h-4 text-green-400" />
                    <h3 className="font-bold text-slate-200 text-sm">
                      {tVal("results.primaryTitle", { count: primaryEvidence.length })}
                    </h3>
                    <span className="text-xs text-green-400 bg-green-500/10 px-2 py-0.5 rounded-full">
                      {tVal("results.primarySub")}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {primaryEvidence.map((e, i) => (
                      <EvidenceCard key={e.id} e={e} idx={i} />
                    ))}
                  </div>
                </section>
              )}

              {/* Decision Memo */}
              {decision && (
                <section>
                  <div className="flex items-center gap-2 mb-3">
                    <LineChart className="w-4 h-4 text-brand-400" />
                    <h3 className="font-bold text-slate-200 text-sm">{tVal("results.memoTitle")}</h3>
                  </div>
                  <DecisionMemoPanel decision={decision} />
                </section>
              )}

              {/* Investor Readiness */}
              {scorecard && (
                <section>
                  <div className="flex items-center gap-2 mb-3">
                    <TrendingUp className="w-4 h-4 text-brand-400" />
                    <h3 className="font-bold text-slate-200 text-sm">{tVal("results.scoreTitle")}</h3>
                  </div>
                  <InvestorScorecardCard scorecard={scorecard} />
                </section>
              )}

              {/* Stats footer */}
              {phase === "done" && stats.tool_calls !== undefined && (
                <div className="glass rounded-xl p-4 border border-white/5">
                  <div className="flex flex-wrap gap-4 text-xs">
                    <div className="flex items-center gap-1.5 text-slate-400">
                      <Clock className="w-3.5 h-3.5" />
                      {tVal("results.toolsUsed", { count: stats.tool_calls })}
                    </div>
                    <div className="flex items-center gap-1.5 text-slate-400">
                      <Shield className="w-3.5 h-3.5" />
                      {tVal("header.verifier")}: {stats.verifier_approved ? tVal("results.verifierApproved") : tVal("header.verifierFlags", { count: stats.unsupported_claims ?? 0 })}
                    </div>
                    <div className="flex items-center gap-1.5 text-slate-400">
                      <FileText className="w-3.5 h-3.5" />
                      {tVal("results.evidenceCount", { count: stats.evidence_count ?? 0 })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default function ValidatePage() {
  return (
    <Suspense fallback={
      <div className="min-h-dvh flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-brand-400 animate-spin" />
      </div>
    }>
      <ValidateDashboard />
    </Suspense>
  );
}
