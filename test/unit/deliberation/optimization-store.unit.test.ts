import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  FileOptimizationContinuityStore,
  OPTIMIZATION_CONTINUITY_STATE_SCHEMA,
  resolveOptimizationContinuityStatePath,
} from "@brewva/brewva-deliberation";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

describe("optimization continuity store", () => {
  test("normalizes persisted lineage vocabularies and drops unknown metadata keys", () => {
    const workspace = createTestWorkspace("optimization-continuity-store");
    try {
      const statePath = resolveOptimizationContinuityStatePath(workspace);
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(
        statePath,
        JSON.stringify({
          schema: OPTIMIZATION_CONTINUITY_STATE_SCHEMA,
          updatedAt: 1,
          sessionDigests: [],
          lineages: [
            {
              id: "opt:coverage:session-1",
              loopKey: "coverage",
              goalRef: "goal-loop:coverage",
              rootSessionId: "session-1",
              summary: "summary",
              scope: ["packages/brewva-runtime/src/runtime.ts"],
              continuityMode: "detached",
              status: "active",
              runCount: 1,
              lineageSessionIds: ["session-1"],
              sourceSkillNames: ["goal-loop"],
              metric: {
                metricKey: "coverage_pct",
                direction: "sideways",
                trend: "improving",
                observationCount: 1,
              },
              firstObservedAt: 1,
              lastObservedAt: 2,
              evidence: [],
              metadata: {
                stuckSignalCount: 2,
                latestIterationOutcome: null,
                nextRunAt: 42,
                ignored: "value",
              },
            },
          ],
        }),
      );

      const state = new FileOptimizationContinuityStore(workspace).read();

      expect(state?.lineages).toHaveLength(1);
      expect(state?.lineages[0]?.metric?.direction).toBe("unknown");
      expect(state?.lineages[0]?.continuityMode).toBeUndefined();
      expect(state?.lineages[0]?.metadata).toEqual({
        stuckSignalCount: 2,
        latestIterationOutcome: null,
        nextRunAt: 42,
      });
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });
});
