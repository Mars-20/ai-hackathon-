import { describe, expect, it, vi } from "vitest";
// server-only resolves to empty.js under the react-server export condition;
// neutralize it for the node test env (companion-dal.test.ts precedent).
vi.mock("server-only", () => ({}));
import { compileContext, type MemoryRow } from "../companion/ranker";
import { estimateTokens } from "../companion/normalize";

// Task 8 — injection overhead pin. TRUE live-promptTokenCount p50 (≤350) is
// measured in Task 10; this pins the compile-time estimate (≤300) + stable
// ordering on a representative 20-row Arabic fixture.

const NOW = Date.parse("2026-10-06T12:00:00.000Z");

const KINDS = ["fact", "preference", "episode", "style"] as const;

const VALUES = [
  "يفضل الدفع عند الاستلام ولا يثق بالبطاقات مسبقة الدفع",
  "السوق المستهدف تجار التجزئة الصغار في القاهرة والجيزة",
  "القناة الأعلى تحويلا هي واتساب يليها الاتصال المباشر",
  "متوسط سلة الشراء خمسون جنيها ويتكرر أسبوعيا",
  "المنافس الرئيسي يقدم توصيلا أسرع بأسعار أعلى",
  "يفضل التواصل باللغة العربية الفصحى المبسطة",
  "قرار الشراء يتخذه صاحب المتجر وحده دون شركاء",
  "موسم الذروة قبل الأعياد ويتضاعف الطلب ثلاث مرات",
  "يرفض الاشتراكات الشهرية ويفضل الدفع per طلب",
  "التوصيل خلال يومين مقبول ولا يشترط نفس اليوم",
  "الثقة تبنى بالتجربة الأولى المجانية ثم يتوسع",
  "المنتجات الأكثر طلبا هي الأساسية سريعة الدوران",
  "يتابع الأسعار يوميا ويقارن بين ثلاثة موردين",
  "الدعم عبر الهاتف أهم من الدردشة النصية",
  "الفوترة الورقية ما زالت مطلوبة بجانب الرقمية",
  "التوسع المخطط لثلاثة فروع خلال ستة أشهر",
  "هامش الربح المستهدف عشرون بالمئة على كل صنف",
  "المخزون الراكد أكبر مصدر للخسارة حاليا",
  "يفضل المورد الذي يقبل المرتجعات دون تعقيد",
  "الدفع الآجل لمدة أسبوع شرط للتعامل المستمر",
];

const QUERY = "السوق المستهدف والقنوات والتسعير والنمو";

function fixtureRows(): MemoryRow[] {
  return VALUES.map((value, i) => ({
    id: `m${String(i + 1).padStart(2, "0")}`,
    kind: KINDS[i % KINDS.length],
    value,
    created_at: new Date(NOW - (i + 1) * 86_400_000).toISOString(),
  }));
}

describe("companion injection overhead (20-row Arabic fixture)", () => {
  it("compiled block stays within the 300-token compiler budget", () => {
    const block = compileContext(fixtureRows(), QUERY, NOW);
    expect(block.length).toBeGreaterThan(0);
    expect(estimateTokens(block)).toBeLessThanOrEqual(300);
  });

  it("ordering is stable across input shuffles (score-desc, id tiebreak)", () => {
    const a = compileContext(fixtureRows(), QUERY, NOW);
    const shuffled = compileContext([...fixtureRows()].reverse(), QUERY, NOW);
    expect(shuffled).toBe(a);
  });
});
