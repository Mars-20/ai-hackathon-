// ─────────────────────────────────────────────────────────────────────────────
// KpiCard — presentational Server Component for /admin overview KPIs.
// Spend cards pass `estimated` to render the spec §3 "estimated —
// COST_TABLE metering, not provider billing" label (never bare spend).
// ─────────────────────────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string;
  value: string;
  hint?: string;
  estimated?: boolean;
}

export default function KpiCard({ label, value, hint, estimated }: KpiCardProps) {
  return (
    <div className="glass rounded-2xl p-5 border border-white/5">
      <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">
        {label}
      </p>
      <p className="text-2xl font-black text-slate-100 mt-1">{value}</p>
      {estimated === true && (
        <span
          className="inline-block mt-2 text-xs px-2 py-0.5 rounded-full border border-yellow-500/30 bg-yellow-500/10 text-yellow-400"
          title="Estimated — COST_TABLE metering, not provider billing"
        >
          estimated
        </span>
      )}
      {hint !== undefined && hint.length > 0 && (
        <p className="text-xs text-slate-500 mt-1">{hint}</p>
      )}
    </div>
  );
}
