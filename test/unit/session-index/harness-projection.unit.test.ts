import { describe, expect, test } from "bun:test";
import { projectSessionHarnessTraceSnapshots } from "@brewva/brewva-session-index";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import {
  buildHarnessManifest,
  type HarnessManifest,
  wrapHarnessManifestRecordedAdvisoryPayload,
} from "@brewva/brewva-vocabulary/harness";

function event(input: {
  id: string;
  type: string;
  timestamp: number;
  turn?: number;
  payload?: BrewvaEventRecord["payload"];
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: "session-harness-projection",
    type: input.type,
    timestamp: input.timestamp,
    ...(input.turn === undefined ? {} : { turn: input.turn }),
    payload: input.payload ?? {},
  };
}

function harnessManifestEvent(input: {
  id: string;
  timestamp: number;
  turn?: number;
  payload: HarnessManifest;
}): BrewvaEventRecord {
  return event({
    id: input.id,
    type: "custom",
    timestamp: input.timestamp,
    turn: input.turn,
    payload: wrapHarnessManifestRecordedAdvisoryPayload(
      input.payload,
    ) as unknown as BrewvaEventRecord["payload"],
  });
}

describe("harness trace projection", () => {
  test("folds manifest and advisory evidence into a deterministic trace snapshot", () => {
    const manifest = buildHarnessManifest({
      sessionId: "session-harness-projection",
      turn: 3,
      attempt: 1,
      runtime: { configHash: "hash:config" },
      prompt: {
        systemPromptHash: "hash:system",
        blockHashes: ["hash:block"],
      },
      tools: {
        activeToolNames: ["exec"],
        toolSchemaSnapshotHash: "hash:tool-schema",
      },
      skillSelection: {
        selectionId: "skill-selection-1",
        mode: "shortlist_prompt_context",
        selectedSkillIds: ["skill-a"],
        renderedContextHash: "hash:skill-context",
      },
      capabilitySelection: {
        selectionId: "capability-selection-1",
        selectedCapabilityNames: ["execution"],
      },
      context: {
        materializationPolicyHash: "hash:context",
        promptStablePrefixHash: "hash:stable",
        promptDynamicTailHash: "hash:tail",
      },
      provider: {
        provider: "faux",
        api: "faux",
        model: "faux-model",
        cachePolicyHash: "hash:cache",
        requestHash: "hash:request",
      },
      refs: { sourceEventIds: ["event-manifest"] },
    });
    const records = [
      harnessManifestEvent({
        id: "event-manifest",
        timestamp: 1_000,
        turn: 3,
        payload: manifest,
      }),
      event({
        id: "event-context",
        type: "context_evidence_appended",
        timestamp: 1_010,
        turn: 3,
        payload: {
          kind: "provider_cache_observation",
          turn: 3,
          payload: {
            status: "break",
            classification: "unexpected",
            reason: "cache_read_drop_exceeded_threshold",
            cacheReadTokens: 0,
            cacheWriteTokens: 20,
            cacheMissTokens: 1200,
            changedFields: ["stablePrefixHash"],
          },
        },
      }),
      event({
        id: "event-tool",
        type: "tool.committed",
        timestamp: 1_020,
        turn: 3,
        payload: {
          commitmentId: "tool:session:call-exec",
          call: { toolName: "exec" },
          result: { outcome: { kind: "err", error: "failed" } },
        },
      }),
      event({
        id: "event-suspended",
        type: "runtime.suspended",
        timestamp: 1_030,
        turn: 3,
        payload: { cause: "provider_retry", error: { reason: "provider" } },
      }),
      event({
        id: "event-ended",
        type: "turn.ended",
        timestamp: 1_040,
        turn: 3,
        payload: { status: "error" },
      }),
    ];

    const snapshots = projectSessionHarnessTraceSnapshots({
      sessionId: "session-harness-projection",
      records,
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      schema: "brewva.harness.trace_snapshot.v1",
      sessionId: "session-harness-projection",
      turn: 3,
      manifestId: manifest.manifestId,
      updatedAt: 1_040,
      provider: {
        provider: "faux",
        model: "faux-model",
      },
      tools: {
        committed: 1,
        errors: 1,
        inconclusive: 0,
      },
      cache: {
        status: "break",
        unexpectedBreak: true,
      },
      outcome: {
        status: "error",
      },
    });
    expect(snapshots[0]?.signals.map((signal) => signal.kind).toSorted()).toEqual([
      "cache_regression",
      "provider_failure",
      "tool_contract",
    ]);
  });

  test("folds inconclusive tool outcomes into tool contract signals", () => {
    const manifest = buildHarnessManifest({
      sessionId: "session-harness-projection",
      turn: 4,
      attempt: 1,
      tools: {
        activeToolNames: ["verify"],
        toolSchemaSnapshotHash: "hash:tool-schema",
      },
    });
    const records = [
      harnessManifestEvent({
        id: "event-manifest",
        timestamp: 2_000,
        turn: 4,
        payload: manifest,
      }),
      event({
        id: "event-tool-inconclusive",
        type: "tool.committed",
        timestamp: 2_010,
        turn: 4,
        payload: {
          call: { toolName: "verify" },
          result: { outcome: { kind: "inconclusive" } },
        },
      }),
    ];

    const snapshots = projectSessionHarnessTraceSnapshots({
      sessionId: "session-harness-projection",
      records,
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.tools).toMatchObject({
      committed: 1,
      errors: 0,
      inconclusive: 1,
    });
    expect(snapshots[0]?.updatedAt).toBe(2_010);
    expect(snapshots[0]?.signals).toContainEqual({
      kind: "tool_contract",
      severity: "medium",
      reason: "tool_contract:inconclusive_outcome",
      eventIds: ["event-tool-inconclusive"],
    });
  });
});
