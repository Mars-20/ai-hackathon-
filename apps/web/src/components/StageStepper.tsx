"use client";

import { resolveOrder, stagePosition, type StageStep } from "@/lib/progress/tracks";

interface StageStepperProps {
  startupId: string;
  stage: string;
  track?: string | null;
  customOrder?: StageStep[] | null;
}

/** Visual stage journey: dots + labels from the project's track order. */
export function StageStepper({ startupId, stage, track, customOrder }: StageStepperProps) {
  const order = resolveOrder(track ?? null, customOrder ?? null);
  const pos = stagePosition(order, stage ?? "idea");
  return (
    <div data-stage-stepper={startupId} className="flex flex-wrap items-center gap-1.5 mt-2">
      {order.map((s, i) => {
        const done = pos >= 0 && i < pos;
        const active = i === pos;
        return (
          <div key={s.key} className="flex items-center gap-1.5">
            {i > 0 && <span className="w-3 h-px bg-white/15" aria-hidden="true" />}
            <span
              data-stage-dot={s.key}
              data-active={active}
              title={s.label}
              className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${
                active
                  ? "bg-brand-500/25 text-brand-300 border-brand-500/40 font-bold"
                  : done
                    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/25"
                    : "bg-white/5 text-slate-500 border-white/10"
              }`}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  active ? "bg-brand-300" : done ? "bg-emerald-400" : "bg-slate-600"
                }`}
              />
              {s.label}
            </span>
          </div>
        );
      })}
      {pos < 0 && (
        <span
          data-stage-offtrack="true"
          className="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30"
        >
          {stage} (خارج المسار)
        </span>
      )}
    </div>
  );
}
