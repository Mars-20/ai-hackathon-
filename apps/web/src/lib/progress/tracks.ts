export interface StageStep {
  key: string;
  label: string;
}

export interface StageTrack {
  version: number;
  steps: StageStep[];
  /** Minimum rung-4+ evidence count that validates the keyed stage. */
  thresholds: Record<string, number>;
}

export const TRACKS: Record<string, StageTrack> = {
  general: {
    version: 1,
    steps: [
      { key: "idea", label: "فكرة" },
      { key: "prototype", label: "نموذج أولي" },
      { key: "live", label: "إطلاق" },
      { key: "scaling", label: "توسّع" },
    ],
    thresholds: { idea: 3, prototype: 5, live: 8 },
  },
  saas_tech: {
    version: 1,
    steps: [
      { key: "idea", label: "فكرة" },
      { key: "mvp", label: "منتج أولي" },
      { key: "beta", label: "تجربة مغلقة" },
      { key: "live", label: "إطلاق عام" },
      { key: "scaling", label: "توسّع" },
    ],
    thresholds: { idea: 3, mvp: 5, beta: 8, live: 12 },
  },
  local_service: {
    version: 1,
    steps: [
      { key: "idea", label: "فكرة" },
      { key: "pilot", label: "تجربة تشغيلية" },
      { key: "live", label: "تشغيل" },
      { key: "scaling", label: "توسّع" },
    ],
    thresholds: { idea: 2, pilot: 4, live: 8 },
  },
  consumer_product: {
    version: 1,
    steps: [
      { key: "idea", label: "فكرة" },
      { key: "prototype", label: "نموذج" },
      { key: "production", label: "إنتاج" },
      { key: "retail", label: "تجزئة" },
      { key: "scaling", label: "توسّع" },
    ],
    thresholds: { idea: 3, prototype: 5, production: 8, retail: 12 },
  },
};

export function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

/**
 * Chronological timestamp comparison. ISO strings from mixed sources carry
 * different offsets ("Z" from client writes, "+00:00" from the DB) where
 * naive lexicographic order can invert — parse to millis instead.
 * Unparseable values sort as epoch (oldest); NaN never propagates.
 */
export function compareTs(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return (Number.isNaN(ta) ? 0 : ta) - (Number.isNaN(tb) ? 0 : tb);
}

/** NULL/unknown track falls back to the general legacy order. */
export function resolveOrder(
  track: string | null,
  custom: StageStep[] | null,
): StageStep[] {
  if (custom && custom.length > 0) return custom;
  const t = track ? TRACKS[normalizeKey(track)] : undefined;
  return (t ?? TRACKS.general).steps;
}

/** Index of stage in order, or -1 when off-track. */
export function stagePosition(order: StageStep[], key: string): number {
  const want = normalizeKey(key);
  return order.findIndex((s) => normalizeKey(s.key) === want);
}

/** True when stage belongs to the project's track order. */
export function isStageInOrder(
  track: string | null,
  custom: StageStep[] | null,
  stage: string,
): boolean {
  return stagePosition(resolveOrder(track, custom), stage) >= 0;
}

/**
 * Intake produces startups before any track exists, so its stage must belong
 * to the general template: anything off-track (hallucinated or from another
 * template) falls back to "idea" instead of failing the save-time check.
 */
export function normalizeIntakeStage(raw: unknown): string {
  const key = typeof raw === "string" ? normalizeKey(raw) : "";
  return key && isStageInOrder(null, null, key) ? key : "idea";
}

/**
 * Validates a custom stage order: non-empty array of { key, label } with
 * unique normalized keys. Returns the cleaned order, or null when invalid.
 */
export function sanitizeCustomOrder(value: unknown): StageStep[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) {
    return null;
  }
  const seen = new Set<string>();
  const cleaned: StageStep[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const rec = item as Record<string, unknown>;
    const key =
      typeof rec.key === "string" && rec.key.trim()
        ? normalizeKey(rec.key)
        : null;
    const label =
      typeof rec.label === "string" && rec.label.trim()
        ? rec.label.trim().slice(0, 60)
        : null;
    if (!key || !label || key.length > 40 || seen.has(key)) return null;
    seen.add(key);
    cleaned.push({ key, label });
  }
  return cleaned;
}
