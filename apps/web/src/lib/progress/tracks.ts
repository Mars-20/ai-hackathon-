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
