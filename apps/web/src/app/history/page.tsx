"use client";

import { useState, useEffect, useCallback, useRef, type ReactElement } from "react";
import Link from "next/link";
import {
  Brain, Search, X, ChevronDown, ChevronLeft, ChevronRight,
  ArrowRight, Calendar, BarChart2, FlaskConical, Target, Clock,
  AlertTriangle, CheckCircle2, XCircle, RotateCcw,
  SlidersHorizontal, Download, RefreshCw,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
type Verdict = "go" | "iterate" | "stop" | "test_more";
type Stage = "idea" | "prototype" | "live" | "scaling";
type Confidence = "low" | "medium" | "high";
type SortKey = "created_at" | "name" | "updated_at";

interface HistoryRecord {
  id: string;
  name: string;
  one_liner: string;
  domain: string;
  stage: Stage;
  created_at: string;
  updated_at: string;
  latest_decision: {
    id: string;
    verdict: Verdict;
    confidence: Confidence;
    rationale: string;
    next_experiment?: string;
    created_at: string;
  } | null;
  experiment_count: number;
  assumption_stats: {
    total: number;
    validated: number;
    invalidated: number;
    critical: number;
  };
}

interface Meta {
  total: number;
  page: number;
  limit: number;
  pages: number;
}

interface SearchResult {
  id: string;
  _type: "startup" | "assumption" | "evidence";
  name?: string;
  one_liner?: string;
  domain?: string;
  stage?: string;
  statement?: string;
  claim?: string;
  strength?: string;
  startup_name?: string;
  category?: string;
  risk_level?: string;
  status?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const VERDICT_CONFIG: Record<Verdict, { label: string; icon: ReactElement; color: string; bg: string }> = {
  go:        { label: "Go",        icon: <CheckCircle2 className="w-3.5 h-3.5" />, color: "#51cf66", bg: "rgba(81,207,102,0.12)" },
  iterate:   { label: "Iterate",   icon: <RotateCcw className="w-3.5 h-3.5" />,    color: "#ffd43b", bg: "rgba(255,212,59,0.12)" },
  stop:      { label: "Stop",      icon: <XCircle className="w-3.5 h-3.5" />,      color: "#ff6b6b", bg: "rgba(255,107,107,0.12)" },
  test_more: { label: "Test More", icon: <FlaskConical className="w-3.5 h-3.5" />, color: "#74c0fc", bg: "rgba(116,192,252,0.12)" },
};

const CONFIDENCE_COLOR: Record<Confidence, string> = {
  high: "#51cf66", medium: "#ffd43b", low: "#ff6b6b",
};

const STAGE_COLOR: Record<Stage, string> = {
  idea: "#7950f2", prototype: "#5c7cfa", live: "#51cf66", scaling: "#ffd43b",
};

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// ─────────────────────────────────────────────────────────────────────────────
export default function HistoryPage() {
  // ── Filter state ────────────────────────────────────────────────────────────
  const [searchQ, setSearchQ] = useState("");
  const [verdictFilter, setVerdictFilter] = useState<Set<Verdict>>(new Set());
  const [stageFilter, setStageFilter] = useState<Set<Stage>>(new Set());
  const [confidenceFilter, setConfidenceFilter] = useState<Set<Confidence>>(new Set());
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("created_at");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(false);

  // ── Data state ──────────────────────────────────────────────────────────────
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [meta, setMeta] = useState<Meta>({ total: 0, page: 1, limit: 20, pages: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ── Global search state ──────────────────────────────────────────────────────
  const [globalSearch, setGlobalSearch] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  const debouncedQ = useDebounce(searchQ, 400);
  const debouncedGlobal = useDebounce(globalSearch, 300);

  // ── Fetch history ────────────────────────────────────────────────────────────
  const fetchHistory = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (debouncedQ) params.set("q", debouncedQ);
    if (verdictFilter.size) params.set("verdict", [...verdictFilter].join(","));
    if (stageFilter.size) params.set("stage", [...stageFilter].join(","));
    if (confidenceFilter.size) params.set("confidence", [...confidenceFilter].join(","));
    if (dateFrom) params.set("from", dateFrom);
    if (dateTo) params.set("to", dateTo);
    params.set("sort", sortKey);
    params.set("order", sortOrder);
    params.set("page", String(page));
    params.set("limit", "20");

    try {
      const res = await fetch(`/api/history?${params}`);
      if (!res.ok) throw new Error("Failed to load history");
      const json = await res.json();
      setRecords(json.data || []);
      setMeta(json.meta || { total: 0, page: 1, limit: 20, pages: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  }, [debouncedQ, verdictFilter, stageFilter, confidenceFilter, dateFrom, dateTo, sortKey, sortOrder, page]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  // ── Global search ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (debouncedGlobal.length < 2) { setSearchResults(null); return; }
    setIsSearching(true);
    fetch(`/api/search?q=${encodeURIComponent(debouncedGlobal)}&limit=4`)
      .then(r => r.json())
      .then(json => {
        const all: SearchResult[] = [
          ...(json.results?.startups || []),
          ...(json.results?.assumptions || []),
          ...(json.results?.evidence || []),
        ];
        setSearchResults(all);
        setShowSearchDropdown(true);
      })
      .catch(() => setSearchResults(null))
      .finally(() => setIsSearching(false));
  }, [debouncedGlobal]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowSearchDropdown(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const toggleFilter = <T extends string>(set: Set<T>, val: T, setter: (s: Set<T>) => void) => {
    const next = new Set(set);
    if (next.has(val)) {
      next.delete(val);
    } else {
      next.add(val);
    }
    setter(next);
    setPage(1);
  };

  const clearAllFilters = () => {
    setSearchQ(""); setVerdictFilter(new Set()); setStageFilter(new Set());
    setConfidenceFilter(new Set()); setDateFrom(""); setDateTo("");
    setSortKey("created_at"); setSortOrder("desc"); setPage(1);
  };

  const activeFilterCount = verdictFilter.size + stageFilter.size + confidenceFilter.size
    + (dateFrom ? 1 : 0) + (dateTo ? 1 : 0);

  const exportCSV = () => {
    const header = ["Name", "Domain", "Stage", "Verdict", "Confidence", "Created At"];
    const rows = records.map(r => [
      r.name, r.domain, r.stage,
      r.latest_decision?.verdict || "—",
      r.latest_decision?.confidence || "—",
      new Date(r.created_at).toLocaleDateString(),
    ]);
    const csv = [header, ...rows].map(row => row.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "validation-history.csv"; a.click();
  };

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen">
      {/* ── HEADER ─────────────────────────────────────────────────────────── */}
      <header className="fixed top-0 left-0 right-0 z-50 glass border-b border-white/5">
        <div className="container-app flex items-center justify-between h-14">
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-brand-500 to-accent-500 flex items-center justify-center">
                <Brain className="w-4 h-4 text-white" />
              </div>
              <span className="font-bold text-sm tracking-tight hidden sm:block">
                Validation <span className="gradient-text">Copilot</span>
              </span>
            </Link>
            <span className="text-slate-600 text-sm hidden sm:block">/</span>
            <span className="text-slate-400 text-sm font-medium">History</span>
          </div>

          {/* Global search bar */}
          <div className="flex-1 max-w-md mx-4 relative" ref={searchRef}>
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
            <input
              type="text"
              value={globalSearch}
              onChange={e => { setGlobalSearch(e.target.value); setShowSearchDropdown(true); }}
              placeholder="Search startups, assumptions, evidence..."
              className="w-full glass rounded-xl pl-9 pr-4 py-2 text-xs text-slate-200 placeholder:text-slate-500 outline-none border border-white/5 focus:border-brand-500/50 transition-all"
              id="global-search-input"
            />
            {isSearching && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                <RefreshCw className="w-3.5 h-3.5 text-slate-500 animate-spin" />
              </div>
            )}

            {/* Search dropdown */}
            {showSearchDropdown && searchResults && searchResults.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-2 glass rounded-2xl border border-white/10 shadow-xl overflow-hidden z-50">
                {searchResults.map((result, i) => (
                  <div key={i} className="flex items-start gap-3 px-4 py-3 hover:bg-white/5 cursor-pointer border-b border-white/5 last:border-0 transition-colors">
                    <div className="mt-0.5 flex-shrink-0">
                      {result._type === "startup" && <Brain className="w-3.5 h-3.5 text-brand-400" />}
                      {result._type === "assumption" && <Target className="w-3.5 h-3.5 text-purple-400" />}
                      {result._type === "evidence" && <BarChart2 className="w-3.5 h-3.5 text-green-400" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-slate-200 truncate">
                        {result.name || result.statement?.slice(0, 60) || result.claim?.slice(0, 60)}
                      </div>
                      <div className="text-xs text-slate-500 flex items-center gap-2 mt-0.5">
                        <span className="capitalize opacity-70">{result._type}</span>
                        {result.startup_name && <span>· {result.startup_name}</span>}
                        {result.domain && <span>· {result.domain}</span>}
                      </div>
                    </div>
                    {result._type === "startup" && (
                      <Link href={`/validate?startup_id=${result.id}`} onClick={() => setShowSearchDropdown(false)}>
                        <ArrowRight className="w-3.5 h-3.5 text-slate-500 hover:text-brand-400 transition-colors" />
                      </Link>
                    )}
                  </div>
                ))}
                {searchResults.length === 0 && (
                  <div className="px-4 py-6 text-center text-xs text-slate-500">No results for &quot;{globalSearch}&quot;</div>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button onClick={exportCSV} className="glass glass-hover px-3 py-1.5 rounded-lg text-xs text-slate-400 flex items-center gap-1.5 border border-white/5" title="Export CSV">
              <Download className="w-3.5 h-3.5" /> Export
            </button>
            <Link href="/validate" className="btn-glow text-white text-xs font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1.5">
              + New
            </Link>
          </div>
        </div>
      </header>

      <main className="pt-20 pb-16 px-6">
        <div className="container-app max-w-6xl">

          {/* ── Page title + stats ──────────────────────────────────────────── */}
          <div className="mb-6">
            <h1 className="text-2xl font-black mb-1">Validation <span className="gradient-text">History</span></h1>
            <p className="text-slate-400 text-sm">
              {meta.total} session{meta.total !== 1 ? "s" : ""} · All your past validation runs, decisions, and experiments
            </p>
          </div>

          {/* ── Search + Filter bar ─────────────────────────────────────────── */}
          <div className="flex flex-col sm:flex-row gap-3 mb-4">
            {/* Inline search (history-specific) */}
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
              <input
                type="text"
                value={searchQ}
                onChange={e => { setSearchQ(e.target.value); setPage(1); }}
                placeholder="Filter by name, domain, one-liner..."
                className="w-full glass rounded-xl pl-9 pr-4 py-2.5 text-sm text-slate-200 placeholder:text-slate-500 outline-none border border-white/5 focus:border-brand-500/50 transition-all"
                id="history-search-input"
              />
              {searchQ && (
                <button onClick={() => setSearchQ("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Filter toggle */}
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`glass glass-hover px-4 py-2.5 rounded-xl text-sm flex items-center gap-2 border transition-all ${showFilters ? "border-brand-500/50 text-brand-400" : "border-white/5 text-slate-400"}`}
              id="toggle-filters-btn"
            >
              <SlidersHorizontal className="w-4 h-4" />
              Filters
              {activeFilterCount > 0 && (
                <span className="w-5 h-5 rounded-full bg-brand-500 text-white text-xs flex items-center justify-center font-bold">
                  {activeFilterCount}
                </span>
              )}
            </button>

            {/* Sort */}
            <div className="flex items-center gap-2">
              <select
                value={sortKey}
                onChange={e => { setSortKey(e.target.value as SortKey); setPage(1); }}
                className="glass rounded-xl px-3 py-2.5 text-sm text-slate-300 outline-none border border-white/5 bg-transparent"
                id="sort-select"
              >
                <option value="created_at">Sort: Date Created</option>
                <option value="updated_at">Sort: Last Updated</option>
                <option value="name">Sort: Name</option>
              </select>
              <button
                onClick={() => setSortOrder(o => o === "asc" ? "desc" : "asc")}
                className="glass glass-hover w-9 h-9 rounded-xl flex items-center justify-center border border-white/5 text-slate-400"
                title={sortOrder === "desc" ? "Descending" : "Ascending"}
              >
                <ChevronDown className={`w-4 h-4 transition-transform ${sortOrder === "asc" ? "rotate-180" : ""}`} />
              </button>
            </div>
          </div>

          {/* ── Filter Panel ─────────────────────────────────────────────────── */}
          {showFilters && (
            <div className="glass rounded-2xl p-5 mb-4 border border-white/5 space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Active Filters</p>
                {activeFilterCount > 0 && (
                  <button onClick={clearAllFilters} className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1 transition-colors">
                    <X className="w-3 h-3" /> Clear all
                  </button>
                )}
              </div>

              <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {/* Verdict filter */}
                <div>
                  <p className="text-xs text-slate-500 mb-2 font-medium">Verdict</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(Object.keys(VERDICT_CONFIG) as Verdict[]).map(v => (
                      <button
                        key={v}
                        onClick={() => toggleFilter(verdictFilter, v, setVerdictFilter)}
                        className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium border transition-all"
                        style={{
                          background: verdictFilter.has(v) ? VERDICT_CONFIG[v].bg : "transparent",
                          color: verdictFilter.has(v) ? VERDICT_CONFIG[v].color : "#64748b",
                          borderColor: verdictFilter.has(v) ? VERDICT_CONFIG[v].color + "50" : "rgba(255,255,255,0.08)",
                        }}
                      >
                        {VERDICT_CONFIG[v].icon} {VERDICT_CONFIG[v].label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Stage filter */}
                <div>
                  <p className="text-xs text-slate-500 mb-2 font-medium">Stage</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(["idea", "prototype", "live", "scaling"] as Stage[]).map(s => (
                      <button
                        key={s}
                        onClick={() => toggleFilter(stageFilter, s, setStageFilter)}
                        className="px-2 py-1 rounded-lg text-xs font-medium border capitalize transition-all"
                        style={{
                          background: stageFilter.has(s) ? STAGE_COLOR[s] + "22" : "transparent",
                          color: stageFilter.has(s) ? STAGE_COLOR[s] : "#64748b",
                          borderColor: stageFilter.has(s) ? STAGE_COLOR[s] + "50" : "rgba(255,255,255,0.08)",
                        }}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Confidence filter */}
                <div>
                  <p className="text-xs text-slate-500 mb-2 font-medium">Confidence</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(["high", "medium", "low"] as Confidence[]).map(c => (
                      <button
                        key={c}
                        onClick={() => toggleFilter(confidenceFilter, c, setConfidenceFilter)}
                        className="px-2 py-1 rounded-lg text-xs font-medium border capitalize transition-all"
                        style={{
                          background: confidenceFilter.has(c) ? CONFIDENCE_COLOR[c] + "22" : "transparent",
                          color: confidenceFilter.has(c) ? CONFIDENCE_COLOR[c] : "#64748b",
                          borderColor: confidenceFilter.has(c) ? CONFIDENCE_COLOR[c] + "50" : "rgba(255,255,255,0.08)",
                        }}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Date range filter */}
                <div>
                  <p className="text-xs text-slate-500 mb-2 font-medium">Date Range</p>
                  <div className="space-y-1.5">
                    <div className="relative">
                      <Calendar className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500" />
                      <input
                        type="date"
                        value={dateFrom}
                        onChange={e => { setDateFrom(e.target.value); setPage(1); }}
                        className="w-full glass rounded-lg pl-7 pr-2 py-1.5 text-xs text-slate-300 outline-none border border-white/5 focus:border-brand-500/50 bg-transparent"
                        placeholder="From"
                        id="date-from-input"
                      />
                    </div>
                    <div className="relative">
                      <Calendar className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500" />
                      <input
                        type="date"
                        value={dateTo}
                        onChange={e => { setDateTo(e.target.value); setPage(1); }}
                        className="w-full glass rounded-lg pl-7 pr-2 py-1.5 text-xs text-slate-300 outline-none border border-white/5 focus:border-brand-500/50 bg-transparent"
                        placeholder="To"
                        id="date-to-input"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Results ──────────────────────────────────────────────────────── */}
          {isLoading ? (
            <div className="grid md:grid-cols-2 gap-4">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="glass rounded-2xl p-5 animate-pulse">
                  <div className="h-4 w-32 bg-white/5 rounded mb-2" />
                  <div className="h-3 w-full bg-white/5 rounded mb-4" />
                  <div className="flex gap-2">
                    <div className="h-6 w-16 bg-white/5 rounded" />
                    <div className="h-6 w-20 bg-white/5 rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="glass rounded-2xl p-10 text-center border border-red-500/20">
              <AlertTriangle className="w-8 h-8 text-red-400 mx-auto mb-3" />
              <p className="text-red-300 text-sm mb-4">{error}</p>
              <button onClick={fetchHistory} className="text-xs text-brand-400 hover:underline">Retry</button>
            </div>
          ) : records.length === 0 ? (
            <div className="glass rounded-2xl p-16 text-center border border-dashed border-white/10">
              <Brain className="w-10 h-10 text-slate-700 mx-auto mb-4" />
              <p className="text-slate-400 text-sm mb-2">
                {activeFilterCount > 0 || searchQ
                  ? "No results match your filters."
                  : "No validation sessions yet."}
              </p>
              {activeFilterCount > 0 || searchQ ? (
                <button onClick={clearAllFilters} className="text-xs text-brand-400 hover:underline">
                  Clear filters
                </button>
              ) : (
                <Link href="/validate" className="btn-glow text-white text-xs font-semibold px-4 py-2 rounded-lg inline-flex items-center gap-1.5 mt-2">
                  Start Validating <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              )}
            </div>
          ) : (
            <div className="grid md:grid-cols-2 gap-4">
              {records.map((record) => {
                const dec = record.latest_decision;
                const vc = dec ? VERDICT_CONFIG[dec.verdict] : null;
                return (
                  <div key={record.id} className="glass glass-hover rounded-2xl p-5 border border-white/5 group flex flex-col gap-4">
                    {/* Header */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="font-bold text-slate-200 truncate">{record.name}</div>
                        <p className="text-xs text-slate-400 mt-0.5 line-clamp-2">{record.one_liner}</p>
                      </div>
                      <Link
                        href={`/validate?startup_id=${record.id}`}
                        className="flex-shrink-0 text-slate-600 group-hover:text-brand-400 transition-colors"
                      >
                        <ArrowRight className="w-4 h-4" />
                      </Link>
                    </div>

                    {/* Tags */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs px-2 py-0.5 rounded-full border capitalize"
                        style={{ color: STAGE_COLOR[record.stage], borderColor: STAGE_COLOR[record.stage] + "40", background: STAGE_COLOR[record.stage] + "15" }}>
                        {record.stage}
                      </span>
                      <span className="text-xs text-slate-500 px-2 py-0.5 rounded-full border border-white/5">
                        {record.domain}
                      </span>
                      {vc && (
                        <span className="text-xs px-2 py-0.5 rounded-full border flex items-center gap-1"
                          style={{ color: vc.color, borderColor: vc.color + "40", background: vc.bg }}>
                          {vc.icon} {vc.label}
                        </span>
                      )}
                      {dec && (
                        <span className="text-xs px-2 py-0.5 rounded-full border capitalize"
                          style={{ color: CONFIDENCE_COLOR[dec.confidence], borderColor: CONFIDENCE_COLOR[dec.confidence] + "40", background: CONFIDENCE_COLOR[dec.confidence] + "15" }}>
                          {dec.confidence} confidence
                        </span>
                      )}
                    </div>

                    {/* Stats row */}
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { icon: <Target className="w-3 h-3" />, value: record.assumption_stats.total, label: "Assumptions", color: "#7950f2" },
                        { icon: <CheckCircle2 className="w-3 h-3" />, value: record.assumption_stats.validated, label: "Validated", color: "#51cf66" },
                        { icon: <FlaskConical className="w-3 h-3" />, value: record.experiment_count, label: "Experiments", color: "#74c0fc" },
                      ].map((stat) => (
                        <div key={stat.label} className="glass rounded-xl p-2.5 text-center">
                          <div className="flex justify-center mb-1" style={{ color: stat.color }}>{stat.icon}</div>
                          <div className="text-sm font-bold" style={{ color: stat.color }}>{stat.value}</div>
                          <div className="text-xs text-slate-600">{stat.label}</div>
                        </div>
                      ))}
                    </div>

                    {/* Decision rationale snippet */}
                    {dec?.rationale && (
                      <p className="text-xs text-slate-500 line-clamp-2 p-3 glass rounded-xl border-l-2 border-brand-500/40">
                        {dec.rationale}
                      </p>
                    )}

                    {/* Footer */}
                    <div className="flex items-center justify-between text-xs text-slate-600">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {new Date(record.created_at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}
                      </span>
                      {record.assumption_stats.critical > 0 && (
                        <span className="flex items-center gap-1 text-red-400">
                          <AlertTriangle className="w-3 h-3" /> {record.assumption_stats.critical} critical
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Pagination ───────────────────────────────────────────────────── */}
          {meta.pages > 1 && (
            <div className="flex items-center justify-center gap-3 mt-8">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="glass glass-hover w-9 h-9 rounded-xl flex items-center justify-center border border-white/5 text-slate-400 disabled:opacity-30 disabled:cursor-not-allowed"
                id="prev-page-btn"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>

              {[...Array(Math.min(meta.pages, 7))].map((_, i) => {
                const pageNum = i + 1;
                return (
                  <button
                    key={pageNum}
                    onClick={() => setPage(pageNum)}
                    className="w-9 h-9 rounded-xl text-xs font-bold transition-all border"
                    style={{
                      background: page === pageNum ? "rgba(92,124,250,0.3)" : "transparent",
                      color: page === pageNum ? "#c4b5fd" : "#64748b",
                      borderColor: page === pageNum ? "rgba(92,124,250,0.4)" : "rgba(255,255,255,0.08)",
                    }}
                  >
                    {pageNum}
                  </button>
                );
              })}

              <button
                onClick={() => setPage(p => Math.min(meta.pages, p + 1))}
                disabled={page === meta.pages}
                className="glass glass-hover w-9 h-9 rounded-xl flex items-center justify-center border border-white/5 text-slate-400 disabled:opacity-30 disabled:cursor-not-allowed"
                id="next-page-btn"
              >
                <ChevronRight className="w-4 h-4" />
              </button>

              <span className="text-xs text-slate-500 ml-2">
                Page {page} of {meta.pages} · {meta.total} total
              </span>
            </div>
          )}

        </div>
      </main>
    </div>
  );
}
