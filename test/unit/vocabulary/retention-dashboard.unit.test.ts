import { describe, expect, test } from "bun:test";
import { projectRetentionDashboard } from "@brewva/brewva-vocabulary/iteration";

describe("retention dashboard projection", () => {
  test("computes the three rates and defaults attribution to unknown", () => {
    const dashboard = projectRetentionDashboard({
      consumeRatio: 0.4,
      eviction: { undone: 1, recorded: 4 },
      forcedCompaction: { forced: 1, opportunities: 10 },
    });

    expect(dashboard.consumeRate).toEqual({ value: 0.4, attribution: "unknown" });
    expect(dashboard.evictThenUndoRate).toEqual({ value: 0.25, attribution: "unknown" });
    expect(dashboard.forcedCompactionRate).toEqual({ value: 0.1, attribution: "unknown" });
  });

  test("a rate is inconclusive (null) when it has no denominator", () => {
    const dashboard = projectRetentionDashboard({
      consumeRatio: null,
      eviction: { undone: 0, recorded: 0 },
      forcedCompaction: { forced: 0, opportunities: 0 },
    });

    expect(dashboard.consumeRate.value).toBeNull();
    expect(dashboard.evictThenUndoRate.value).toBeNull();
    expect(dashboard.forcedCompactionRate.value).toBeNull();
  });

  test("attribution is explicit input only, never inferred from the rate", () => {
    const dashboard = projectRetentionDashboard({
      consumeRatio: 0.1,
      eviction: { undone: 3, recorded: 4 },
      forcedCompaction: { forced: 0, opportunities: 5 },
      attribution: { consumeRate: "implementation", evictThenUndoRate: "capability" },
    });

    expect(dashboard.consumeRate.attribution).toBe("implementation");
    expect(dashboard.evictThenUndoRate.attribution).toBe("capability");
    // A high evict-then-undo rate (0.75) is NOT auto-attributed; stays unknown.
    expect(dashboard.forcedCompactionRate.attribution).toBe("unknown");
  });
});
