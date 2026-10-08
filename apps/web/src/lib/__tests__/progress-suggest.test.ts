import { describe, expect, it } from "vitest";
import { suggestNextStage } from "@/lib/progress/suggest";
import { resolveOrder, TRACKS } from "@/lib/progress/tracks";

const ORDER = resolveOrder("general", null);
const base = {
  stage: "idea",
  order: ORDER,
  thresholds: TRACKS.general.thresholds,
  rung4Count: 0,
  rung4Ids: [] as string[],
  dismissals: [] as {
    from: string;
    to: string;
    rung4_count: number;
    created_at: string;
  }[],
};

describe("suggestNextStage", () => {
  it("R1: latest Go suggests next with decision ref", () => {
    const r = suggestNextStage({
      ...base,
      decisions: [{ id: "d1", verdict: "go", created_at: "2026-10-08T00:00:00Z" }],
    });
    expect(r?.to).toBe("prototype");
    expect(r?.refs.decisionIds).toEqual(["d1"]);
  });

  it("R2: threshold met suggests next with evidence refs", () => {
    const r = suggestNextStage({
      ...base,
      decisions: [],
      rung4Count: 3,
      rung4Ids: ["e1", "e2", "e3"],
    });
    expect(r?.to).toBe("prototype");
  });

  it("below threshold suggests nothing", () => {
    expect(
      suggestNextStage({
        ...base,
        decisions: [],
        rung4Count: 2,
        rung4Ids: ["e1", "e2"],
      }),
    ).toBeNull();
  });

  it("final stage suggests nothing", () => {
    expect(
      suggestNextStage({
        ...base,
        stage: "scaling",
        decisions: [{ id: "d9", verdict: "go", created_at: "2026-10-08T00:00:00Z" }],
        rung4Count: 99,
        rung4Ids: ["x"],
      }),
    ).toBeNull();
  });

  it("dismissed pair suppressed without newer data", () => {
    const r = suggestNextStage({
      ...base,
      decisions: [{ id: "d1", verdict: "go", created_at: "2026-10-08T00:00:00Z" }],
      dismissals: [
        {
          from: "idea",
          to: "prototype",
          rung4_count: 0,
          created_at: "2026-10-09T00:00:00Z",
        },
      ],
    });
    expect(r).toBeNull();
  });

  it("newer Go re-arms after dismissal", () => {
    const r = suggestNextStage({
      ...base,
      decisions: [
        { id: "d1", verdict: "go", created_at: "2026-10-08T00:00:00Z" },
        { id: "d2", verdict: "go", created_at: "2026-10-10T00:00:00Z" },
      ],
      dismissals: [
        {
          from: "idea",
          to: "prototype",
          rung4_count: 0,
          created_at: "2026-10-09T00:00:00Z",
        },
      ],
    });
    expect(r?.to).toBe("prototype");
    expect(r?.refs.decisionIds).toEqual(["d2"]);
  });

  it("grown rung4 count re-arms after dismissal", () => {
    const r = suggestNextStage({
      ...base,
      decisions: [],
      rung4Count: 4,
      rung4Ids: ["e1", "e2", "e3", "e4"],
      dismissals: [
        {
          from: "idea",
          to: "prototype",
          rung4_count: 3,
          created_at: "2026-10-09T00:00:00Z",
        },
      ],
    });
    expect(r?.to).toBe("prototype");
  });

  it("off-track stage pauses suggestions", () => {
    expect(
      suggestNextStage({
        ...base,
        stage: "beta",
        decisions: [{ id: "d1", verdict: "go", created_at: "2026-10-08T00:00:00Z" }],
      }),
    ).toBeNull();
  });
});
