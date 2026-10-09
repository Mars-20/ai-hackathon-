"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { TRACKS, type StageStep } from "@/lib/progress/tracks";
import { StageStepper } from "./StageStepper";

interface Suggestion {
  to: string;
  reason: string;
  refs: { decisionIds: string[]; evidenceIds: string[] };
}

interface ProgressPayload {
  stage: string;
  track: string | null;
  order: StageStep[];
  position: number;
  suggestion: Suggestion | null;
}

interface StageProgressSectionProps {
  startupId: string;
  stage: string;
  track?: string | null;
  customOrder?: StageStep[] | null;
  onStageChange?: (to: string) => void;
  onTrackChange?: (track: string | null) => void;
}

/** Stepper + hybrid suggestion card + track picker (self-contained). */
export function StageProgressSection({
  startupId,
  stage,
  track,
  customOrder,
  onStageChange,
  onTrackChange,
}: StageProgressSectionProps) {
  const [payload, setPayload] = useState<ProgressPayload | null>(null);
  const [busy, setBusy] = useState<"confirm" | "dismiss" | "track" | null>(null);
  const [error, setError] = useState<"confirmFailed" | "dismissFailed" | "trackFailed" | null>(null);
  const tVal = useTranslations("validate");
  const tShared = useTranslations("shared");
  // Track-step labels come from the API/lib by key; resolve via shared.stages (lib UNTOUCHED).
  const stageLabel = (key: string, fb: string) => {
    try {
      const v = tShared(`stages.${key}`);
      return v === `stages.${key}` ? fb : v;
    } catch {
      return fb;
    }
  };

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/startups/${encodeURIComponent(startupId)}/stage`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      setPayload((await res.json()) as ProgressPayload);
    } catch {
      /* card stays hidden when the read endpoint is unavailable */
    }
  }, [startupId]);

  useEffect(() => {
    load();
  }, [load, stage, track]);

  const suggestion = payload?.suggestion ?? null;
  const suggestionStep = suggestion && payload
    ? payload.order.find((s) => s.key === suggestion.to)
    : undefined;
  const suggestionLabel = suggestion
    ? stageLabel(suggestion.to, suggestionStep?.label ?? suggestion.to)
    : "";

  async function confirm() {
    if (!suggestion) return;
    setBusy("confirm");
    setError(null);
    try {
      const res = await fetch(`/api/startups/${encodeURIComponent(startupId)}/stage`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: suggestion.to }),
      });
      if (!res.ok) throw new Error(`confirm ${res.status}`);
      onStageChange?.(suggestion.to);
      await load();
    } catch {
      setError("confirmFailed");
    } finally {
      setBusy(null);
    }
  }

  async function dismiss() {
    if (!suggestion) return;
    setBusy("dismiss");
    setError(null);
    try {
      const res = await fetch(
        `/api/startups/${encodeURIComponent(startupId)}/stage/dismiss`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to: suggestion.to }),
        },
      );
      if (!res.ok) throw new Error(`dismiss ${res.status}`);
      await load();
    } catch {
      setError("dismissFailed");
    } finally {
      setBusy(null);
    }
  }

  async function switchTrack(next: string) {
    setBusy("track");
    setError(null);
    try {
      // Narrow track endpoint: updates ONLY stage_track/stage_order. The
      // full-save upsert must not be used here — absent fields there resolve
      // to defaults and would clobber the row (one_liner, domain, workspace).
      const res = await fetch(
        `/api/startups/${encodeURIComponent(startupId)}/stage/track`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ track: next }),
        },
      );
      if (!res.ok) throw new Error(`track ${res.status}`);
      onTrackChange?.(next === "general" ? null : next);
      await load();
    } catch {
      setError("trackFailed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="animate-fade-in">
      <div className="glass rounded-2xl p-5 border border-white/5">
        <div className="flex items-center justify-between gap-3 mb-1">
          <h3 className="font-bold text-slate-200 text-sm">{tVal("stage.title")}</h3>
          <label className="flex items-center gap-2 text-xs text-slate-400">
            {tVal("stage.trackLabel")}
            <select
              data-testid="track-picker"
              value={payload?.track ?? track ?? "general"}
              disabled={busy === "track"}
              onChange={(e) => switchTrack(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-slate-200"
            >
              {Object.keys(TRACKS).map((key) => (
                <option key={key} value={key}>
                  {tVal(`stage.tracks.${key}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <StageStepper
          startupId={startupId}
          stage={payload?.stage ?? stage}
          track={payload?.track ?? track ?? null}
          customOrder={customOrder ?? null}
        />
        {suggestion && (
          <div
            data-testid="stage-suggestion"
            className="mt-4 rounded-xl p-4 bg-brand-500/10 border border-brand-500/30"
          >
            <div className="text-sm text-slate-200 mb-1">
              {tVal("stage.suggestionPattern", { label: suggestionLabel })}
            </div>
            <div className="text-xs text-slate-400 mb-3">{suggestion.reason}</div>
            {error && <div className="text-xs text-red-400 mb-2">{tVal(`stage.errors.${error}`)}</div>}
            <div className="flex gap-2">
              <button
                type="button"
                data-testid="stage-confirm"
                disabled={busy !== null}
                onClick={confirm}
                className="text-xs font-bold px-3 py-1.5 rounded-lg bg-brand-500 text-white disabled:opacity-50"
              >
                {tVal("stage.confirmMove")}
              </button>
              <button
                type="button"
                data-testid="stage-dismiss"
                disabled={busy !== null}
                onClick={dismiss}
                className="text-xs px-3 py-1.5 rounded-lg border border-white/15 text-slate-300 disabled:opacity-50"
              >
                {tVal("stage.dismissSuggestion")}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
