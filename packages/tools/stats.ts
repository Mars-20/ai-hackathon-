/**
 * Deterministic math tool for stats, Sean Ellis PMF score, response rates, and Wilson intervals.
 * Never computed by LLM prose.
 */

export interface SampleStats {
  n: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  std: number;
}

export function sampleStats(data: number[]): SampleStats {
  if (!data || data.length === 0) return { n: 0, mean: 0, median: 0, min: 0, max: 0, std: 0 };
  const n = data.length;
  const mean = data.reduce((a, b) => a + b, 0) / n;
  const sorted = [...data].sort((a, b) => a - b);
  const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
  const min = sorted[0];
  const max = sorted[n - 1];
  const variance = data.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / n;
  const std = Math.sqrt(variance);
  return { n, mean: +mean.toFixed(2), median, min, max, std: +std.toFixed(2) };
}

export function seanEllisScore(responses: number[]): {
  score: number;
  interpretation: string;
  pmf_reached: boolean;
} {
  if (!responses || responses.length === 0) return { score: 0, interpretation: "No data", pmf_reached: false };
  // 1 = very disappointed, 2 = somewhat, 3 = not disappointed
  const veryDisappointed = responses.filter((r) => r === 1).length;
  const score = Math.round((veryDisappointed / responses.length) * 100);
  const pmf_reached = score >= 40;
  let interpretation: string;
  if (score >= 40) interpretation = "Strong PMF signal — 40%+ threshold reached";
  else if (score >= 25) interpretation = "Moderate signal — iterate toward PMF";
  else interpretation = "Weak signal — significant product/market mismatch";
  return { score, interpretation, pmf_reached };
}

export function responseRate(sent: number, replied: number): {
  rate: number;
  label: string;
} {
  if (!sent || sent === 0) return { rate: 0, label: "No messages sent" };
  const rate = Math.round((replied / sent) * 100);
  let label: string;
  if (rate >= 30) label = "Excellent";
  else if (rate >= 15) label = "Good";
  else if (rate >= 5) label = "Typical";
  else label = "Low";
  return { rate, label };
}

export function confidenceInterval(
  successes: number,
  n: number,
  confidence = 0.95
): { lower: number; upper: number; center: number } {
  if (!n || n === 0) return { lower: 0, upper: 0, center: 0 };
  const z = confidence === 0.95 ? 1.96 : 1.645;
  const p = successes / n;
  const center = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const margin = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / (1 + (z * z) / n);
  return {
    lower: Math.max(0, +((center - margin) * 100).toFixed(1)),
    upper: Math.min(100, +((center + margin) * 100).toFixed(1)),
    center: +((center * 100).toFixed(1)),
  };
}
