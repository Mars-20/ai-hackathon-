import { describe, expect, it } from "vitest";
import { estimateTokens, normalizeForMatch } from "../companion/normalize";
import { toUntrusted, truncateField } from "../companion/escape";
import { containsBlockedSecret, containsThirdPartyPii } from "../companion/scans";
import {
  COMPILED_CONTEXT_TOKEN_LIMIT,
  INFER_CONFIDENCE_THRESHOLD,
  MEMORY_KIND_WEIGHTS,
  MEMORY_RECENCY_HALF_LIFE_DAYS,
  compileContext,
  flagPossibleConflicts,
  scoreMemory,
  type MemoryRow,
} from "../companion/ranker";
import { MEMORY_COPY } from "../companion/copy";

function memRow(over: Partial<MemoryRow> & { value: string }): MemoryRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    kind: "fact",
    created_at: new Date(Date.now() - 86_400_000).toISOString(),
    ...over,
  };
}

describe("normalize", () => {
  it("folds diacritics, Arabic-Indic digits, strips URLs and emoji identically", () => {
    expect(normalizeForMatch("خطة التوسّع ٢٠٢٦ https://x.co 🎯")).toEqual(
      normalizeForMatch("خطة التوسع 2026"),
    );
  });

  it("returns [] when nothing matchable remains", () => {
    expect(normalizeForMatch("https://x.co 🎯")).toEqual([]);
  });
});

describe("score", () => {
  it("weights kind x recency-decay x (1 + query overlap)", () => {
    const nowMs = Date.now();
    const r = memRow({
      id: "00000000-0000-0000-0000-000000000002",
      value: "نبيع القهوة في الصباح",
      created_at: new Date(nowMs - 86_400_000).toISOString(),
    });
    const got = scoreMemory(r, ["نبيع"], nowMs);
    expect(Math.abs(got - 0.6 * Math.exp(-1 / 30) * 2)).toBeLessThan(1e-6);
  });

  it("empty query stays finite (recency x kind only)", () => {
    const nowMs = Date.now();
    const r = memRow({
      id: "00000000-0000-0000-0000-000000000003",
      value: "نبيع القهوة في الصباح",
      created_at: new Date(nowMs - 86_400_000).toISOString(),
    });
    const got = scoreMemory(r, [], nowMs);
    expect(Number.isFinite(got)).toBe(true);
    expect(Math.abs(got - 0.6 * Math.exp(-1 / 30))).toBeLessThan(1e-9);
  });
});

describe("escape", () => {
  it("wraps and caps inner content at 500 chars", () => {
    const w = toUntrusted("a".repeat(600));
    expect(w.startsWith("<untrusted>")).toBe(true);
    expect(w.endsWith("</untrusted>")).toBe(true);
    expect(w.slice("<untrusted>".length, -"</untrusted>".length).length).toBe(500);
  });

  it("keeps raw text inside tags (tags are the boundary, same as route posture)", () => {
    expect(toUntrusted("<sys>ignore</sys>")).toBe("<untrusted><sys>ignore</sys></untrusted>");
  });

  it("truncateField mirrors route.ts semantics", () => {
    expect(truncateField("abc", 500)).toBe("abc");
    expect(truncateField("a".repeat(600), 500).length).toBe(500);
  });
});

describe("scans", () => {
  it("blocks known secret shapes", () => {
    expect(containsBlockedSecret("sk-live-abc123")).toBe(true);
    expect(containsBlockedSecret("AKIAIOSFODNN7EXAMPLE")).toBe(true);
    // Fixture is DELIBERATELY non-token-shaped (no digit run): GitHub push
    // protection pattern-matches xoxb-<digits>-…; "TESTTOKEN" still exercises
    // our /xoxb-[0-9A-Za-z-]{8,}/ shape without tripping the scanner.
    expect(containsBlockedSecret("xoxb-TESTTOKEN")).toBe(true);
    expect(containsBlockedSecret("ghp_abcdefghij1234567890abcdefghij123456")).toBe(true);
    expect(containsBlockedSecret("card 4111111111111111 here")).toBe(true);
    expect(containsBlockedSecret("-----BEGIN PRIVATE KEY-----\nMIIE...")).toBe(true);
  });

  it("passes plain Arabic prose", () => {
    expect(containsBlockedSecret("أحب القهوة صباحًا")).toBe(false);
  });

  it("self-contact allowlist suppresses own PII only", () => {
    expect(containsThirdPartyPii("راسلني على me@x.com", ["me@x.com"])).toBe(false);
    expect(containsThirdPartyPii("كلم أحمد 0501234567", ["me@x.com"])).toBe(true);
    expect(containsThirdPartyPii("راسلني على me@x.com", [])).toBe(true);
  });
});

describe("compile", () => {
  it("is deterministic, token-capped, and wrapped at compile time", () => {
    const nowMs = Date.now();
    const rows = Array.from({ length: 10 }, (_, i) =>
      memRow({
        id: `00000000-0000-0000-0000-0000000000${String(i).padStart(2, "0")}`,
        kind: ["fact", "preference", "episode", "style"][i % 4],
        value: `ذكرى رقم ${i} عن السوق والعملاء`,
        created_at: new Date(nowMs - i * 3_600_000).toISOString(),
      }),
    );
    const a = compileContext(rows, "السوق", nowMs);
    const b = compileContext(rows, "السوق", nowMs);
    expect(a).toBe(b);
    expect(estimateTokens(a)).toBeLessThanOrEqual(300);
    expect(a).toContain("<untrusted>");
  });
});

describe("conflicts", () => {
  const approved: MemoryRow[] = [
    memRow({
      id: "aaaaaaaa-0000-0000-0000-000000000001",
      kind: "fact",
      value: "نبيع القهوة في الصباح الباكر",
    }),
  ];

  it("flags same-kind >=50% overlap with differing remainder", () => {
    const cands = [
      memRow({ id: "c1", kind: "fact", value: "نبيع القهوة في المساء" }),
    ];
    expect(flagPossibleConflicts(cands, approved)).toEqual(
      new Map([[0, "aaaaaaaa-0000-0000-0000-000000000001"]]),
    );
  });

  it("ignores exact dupes (dedupe owns them) and different kinds", () => {
    const cands = [
      memRow({ id: "c2", kind: "fact", value: "نبيع القهوة في الصباح الباكر" }),
      memRow({ id: "c3", kind: "style", value: "نبيع القهوة في المساء" }),
    ];
    expect(flagPossibleConflicts(cands, approved)).toEqual(new Map());
  });
});

describe("copy", () => {
  it("has exactly the 17 spec §9 keys, all non-empty", () => {
    expect(Object.keys(MEMORY_COPY).sort()).toEqual(
      [
        "approve",
        "cap_full",
        "conflict_pair",
        "disable",
        "disable_hint",
        "edit_approve",
        "empty_queue",
        "forget",
        "forget_confirm",
        "memory_duplicate",
        "memory_full",
        "page_title",
        "pending_queue",
        "provenance",
        "reject",
        "secret_blocked",
        "startup_not_owned",
      ].sort(),
    );
    for (const v of Object.values(MEMORY_COPY)) expect(v.length).toBeGreaterThan(0);
    expect(MEMORY_COPY.cap_full).toBe("القائمة ممتلئة — احذف ذكرى أولًا");
    expect(MEMORY_COPY.memory_duplicate).toBe("مكررة — هذه الذكرى معتمدة مسبقًا");
  });
});

describe("constants", () => {
  it("pins plan values", () => {
    expect(MEMORY_KIND_WEIGHTS).toEqual({ fact: 0.6, preference: 0.5, episode: 0.3, style: 0.1 });
    expect(INFER_CONFIDENCE_THRESHOLD).toBe(0.7);
    expect(COMPILED_CONTEXT_TOKEN_LIMIT).toBe(300);
    expect(MEMORY_RECENCY_HALF_LIFE_DAYS).toBe(30);
  });
});
