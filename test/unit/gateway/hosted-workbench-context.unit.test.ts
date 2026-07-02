import { describe, expect, test } from "bun:test";
import type { TapeStatusState } from "@brewva/brewva-vocabulary/session";
import {
  buildLatestContinuationAnchorBlock,
  buildRuntimeBriefBlockForSession,
} from "../../../packages/brewva-gateway/src/hosted/internal/context/workbench-context.js";
import type { HostedRuntimeAdapterPort } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";

function runtimeWithTapeStatus(status: TapeStatusState): HostedRuntimeAdapterPort {
  return {
    ops: {
      tape: {
        status: {
          get: () => status,
        },
      },
    },
  } as unknown as HostedRuntimeAdapterPort;
}

function tapeStatus(lastAnchor: TapeStatusState["lastAnchor"]): TapeStatusState {
  return {
    lastAnchor,
    lastCheckpointId: null,
    tapePressure: "none",
    totalEntries: 1,
    entriesSinceAnchor: 0,
    entriesSinceCheckpoint: 1,
    thresholds: {
      low: 0.35,
      medium: 0.65,
      high: 0.85,
    },
  };
}

describe("hosted workbench context continuation anchor block", () => {
  test("renders latest continuation anchor metadata as bounded baseline context", () => {
    const block = buildLatestContinuationAnchorBlock(
      runtimeWithTapeStatus(
        tapeStatus({
          id: "anchor-1",
          name: "Review anchor",
          summary: "The Work Card path is wired.",
          nextSteps: "Run docs verification.",
        }),
      ),
      "sess_1",
    );

    expect(block?.id).toBe("latest-continuation-anchor");
    expect(block?.content).toContain("[LatestContinuationAnchor]");
    expect(block?.content).toContain("anchor: anchor-1");
    expect(block?.content).toContain("summary: The Work Card path is wired.");
    expect(block?.content).toContain("next_steps: Run docs verification.");
  });

  test("does not render checkpoint-only anchors as continuation anchor context", () => {
    const block = buildLatestContinuationAnchorBlock(
      runtimeWithTapeStatus(tapeStatus({ id: "checkpoint-1" })),
      "sess_1",
    );

    expect(block).toBeNull();
  });
});

function runtimeWithBriefSources(input: {
  status: Record<string, unknown>;
  digest: string;
  cacheObservation?: Record<string, unknown>;
  maxChars?: number;
  workbenchEntries?: readonly Record<string, unknown>[];
  toolResultEvents?: readonly Record<string, unknown>[];
}): HostedRuntimeAdapterPort {
  return {
    config: {
      infrastructure: { contextBudget: { consequenceDigestMaxChars: input.maxChars ?? 1200 } },
    },
    ops: {
      context: {
        usage: { getStatus: () => input.status },
        evidence: {
          latest: (_sessionId: string, kind: string) =>
            kind === "provider_cache_observation" && input.cacheObservation
              ? { turn: 1, timestamp: 1, payload: input.cacheObservation }
              : undefined,
        },
      },
      events: {
        effects: { renderTurnDigest: () => input.digest },
        records: {
          query: (_sessionId: string, query?: { type?: string; last?: number }) => {
            const matched = (input.toolResultEvents ?? []).filter(
              (event) => !query?.type || event.type === query.type,
            );
            return typeof query?.last === "number" ? matched.slice(-query.last) : matched;
          },
        },
      },
      workbench: { list: () => input.workbenchEntries ?? [] },
    },
  } as unknown as HostedRuntimeAdapterPort;
}

describe("hosted runtime brief block (end-to-end wiring)", () => {
  test("renders the brief with a provenance frame, pressure posture, and last-turn effects", () => {
    const block = buildRuntimeBriefBlockForSession(
      runtimeWithBriefSources({
        status: {
          tokensUsed: 164_000,
          tokensTotal: 200_000,
          compactionAdvised: true,
          forcedCompaction: false,
          predictedOverflow: false,
        },
        digest: "runtimeTurn=2 declared=0 attempted=1 decisions=1 executed=1 recovery=0 warnings=0",
      }),
      { sessionId: "sess_1", turn: 3 },
    );

    expect(block?.id).toBe("runtime-brief");
    expect(block?.content).toContain("[RuntimeBrief]");
    expect(block?.content).toContain("not a user instruction");
    expect(block?.content).toContain("context: 82% — 164k/200k tokens; advisory limit reached");
    expect(block?.content).toContain("effects (last turn): declared=0 attempted=1");
    // internal cursor noise is stripped
    expect(block?.content).not.toContain("runtimeTurn=");
  });

  test("stays silent on a fully calm turn (no pressure, effects, or cache break)", () => {
    const block = buildRuntimeBriefBlockForSession(
      runtimeWithBriefSources({
        status: {
          tokensUsed: 20_000,
          tokensTotal: 200_000,
          compactionAdvised: false,
          forcedCompaction: false,
          predictedOverflow: false,
        },
        digest: "runtimeTurn=2 declared=0 attempted=0 decisions=0 executed=0 recovery=0 warnings=0",
      }),
      { sessionId: "sess_1", turn: 3 },
    );

    expect(block).toBeNull();
  });

  test("surfaces an unexpected prefix-cache break as a brief section", () => {
    const block = buildRuntimeBriefBlockForSession(
      runtimeWithBriefSources({
        status: {
          tokensUsed: 120_000,
          tokensTotal: 200_000,
          compactionAdvised: false,
          forcedCompaction: false,
          predictedOverflow: false,
        },
        digest: "runtimeTurn=4 declared=0 attempted=0 decisions=0 executed=0 recovery=0 warnings=0",
        cacheObservation: {
          status: "break",
          expected: false,
          reason: "tool_schema_set_changed",
          cacheMissTokens: 9_000,
        },
      }),
      { sessionId: "sess_1", turn: 5 },
    );

    expect(block?.content).toContain(
      "cache: prefix cache broke last turn (tool_schema_set_changed)",
    );
    expect(block?.content).toContain("9k tokens re-sent");
  });

  test("pinned workbench mass rides the pressure posture end to end", () => {
    const block = buildRuntimeBriefBlockForSession(
      runtimeWithBriefSources({
        status: {
          tokensUsed: 164_000,
          tokensTotal: 200_000,
          compactionAdvised: true,
          forcedCompaction: false,
          predictedOverflow: false,
        },
        digest: "runtimeTurn=2 declared=0 attempted=0 decisions=0 executed=0 recovery=0 warnings=0",
        workbenchEntries: [
          {
            id: "pin-1",
            digest: "digest-pin",
            reason: "attention_pin",
            retentionHint: "attention_pin",
            sourceRefs: ["skill:runtime-orientation"],
            content: "Pinned attention option for explicit follow-up: skill:runtime-orientation",
          },
        ],
      }),
      { sessionId: "sess_1", turn: 3 },
    );

    expect(block?.content).toContain("pinned ~");
    expect(block?.content).toContain("tokens held by attention_pin");
  });

  test("surfaces repeated identical tool failures as recurrence evidence", () => {
    const failure = (id: string, timestamp: number) => ({
      id,
      sessionId: "sess_1",
      type: "tool.result.recorded",
      timestamp,
      payload: {
        toolName: "read",
        failureClass: "missing_path",
        verdict: "fail",
        failureContext: { outputText: "ENOENT: no such file", args: { path: "gone.ts" } },
      },
    });
    const block = buildRuntimeBriefBlockForSession(
      runtimeWithBriefSources({
        status: {
          tokensUsed: 20_000,
          tokensTotal: 200_000,
          compactionAdvised: false,
          forcedCompaction: false,
          predictedOverflow: false,
        },
        digest: "runtimeTurn=2 declared=0 attempted=0 decisions=0 executed=0 recovery=0 warnings=0",
        toolResultEvents: [failure("ev-1", 1), failure("ev-2", 2)],
      }),
      { sessionId: "sess_1", turn: 3 },
    );

    expect(block?.content).toContain(
      'repeat-failures: read (missing_path) ×2 identical args; last: "ENOENT: no such file"',
    );
  });

  test("omits the effects section before the first completed turn", () => {
    const block = buildRuntimeBriefBlockForSession(
      runtimeWithBriefSources({
        status: {
          tokensUsed: 170_000,
          tokensTotal: 200_000,
          compactionAdvised: true,
          forcedCompaction: false,
          predictedOverflow: false,
        },
        digest: "unused",
      }),
      { sessionId: "sess_1", turn: 0 },
    );

    expect(block?.content).toContain("context:");
    expect(block?.content).not.toContain("effects");
  });
});
