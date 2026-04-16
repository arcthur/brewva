import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DELIBERATION_MEMORY_STATE_SCHEMA,
  FileDeliberationMemoryStore,
  resolveDeliberationMemoryStatePath,
} from "@brewva/brewva-deliberation";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

describe("deliberation memory file store", () => {
  test("normalizes persisted artifact metadata and drops unknown keys", () => {
    const workspace = createTestWorkspace("deliberation-memory-store");
    try {
      const statePath = resolveDeliberationMemoryStatePath(workspace);
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(
        statePath,
        JSON.stringify({
          schema: DELIBERATION_MEMORY_STATE_SCHEMA,
          updatedAt: 1,
          sessionDigests: [],
          artifacts: [
            {
              id: "repository-working-contract:abc123",
              kind: "repository_strategy_memory",
              title: "Repository Working Contract",
              summary: "summary",
              content: "content",
              tags: ["check"],
              confidenceScore: 0.8,
              firstCapturedAt: 1,
              lastValidatedAt: 2,
              applicabilityScope: "repository",
              sessionIds: ["session-1"],
              evidence: [],
              metadata: {
                repositoryRoot: "/repo/workspace",
                taskSpecCount: 4,
                loopKey: "coverage-raise",
                metricCount: 2,
                guardCount: 1,
                retention: {
                  retentionScore: 0.9,
                  retrievalBias: 0.8,
                  decayFactor: 0.7,
                  ageDays: 1,
                  evidenceCount: 3,
                  sessionSpan: 2,
                  band: "frozen",
                },
                ignored: "value",
              },
            },
          ],
        }),
      );

      const state = new FileDeliberationMemoryStore(workspace).read();

      expect(state?.artifacts).toHaveLength(1);
      expect(state?.artifacts[0]?.metadata).toEqual({
        repositoryRoot: "/repo/workspace",
        taskSpecCount: 4,
        loopKey: "coverage-raise",
        metricCount: 2,
        guardCount: 1,
      });
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });
});
