import { describe, expect, test } from "bun:test";
import { projectSessionHarnessTraceSnapshots } from "@brewva/brewva-session-index";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import {
  buildHarnessManifest,
  type HarnessManifest,
  wrapHarnessManifestRecordedAdvisoryPayload,
} from "@brewva/brewva-vocabulary/harness";
import { VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import { listHarnessPatternCandidateRows } from "../../../packages/brewva-session-index/src/projection/harness.js";
import type { SessionIndexQueryPort } from "../../../packages/brewva-session-index/src/query/port.js";

function event(input: {
  id: string;
  type: string;
  timestamp: number;
  turn?: number;
  turnId?: string;
  payload?: BrewvaEventRecord["payload"];
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: "session-harness-projection",
    type: input.type,
    timestamp: input.timestamp,
    ...(input.turn === undefined ? {} : { turn: input.turn }),
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    payload: input.payload ?? {},
  };
}

function harnessManifestEvent(input: {
  id: string;
  timestamp: number;
  turn?: number;
  turnId?: string;
  payload: HarnessManifest;
}): BrewvaEventRecord {
  return event({
    id: input.id,
    type: "custom",
    timestamp: input.timestamp,
    turn: input.turn,
    turnId: input.turnId,
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
        payload: { status: "failed" },
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
        status: "failed",
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

  test("an independent skipped receipt is flagged as weak evidence like any other non-pass outcome (Task 6 harness decision: no perspective-specific carve-out)", () => {
    // Task 6 decision: `weakVerificationEventIds` does NOT special-case
    // `independent` + `skipped` receipts. Reasoning: "weak evidence" here
    // means "this receipt does not establish confidence" — an independent
    // review that came back inconclusive (skipped, with a reason) is exactly
    // that, same as an authored skip; the existing `outcome !== "pass"` branch
    // already catches it correctly with no perspective-aware logic needed, and
    // this test proves the wider payload (Task 1's four new fields) compiles
    // and folds through this exact path without any code change here.
    const manifest = buildHarnessManifest({
      sessionId: "session-harness-projection",
      turn: 9,
      attempt: 1,
      skillSelection: {
        selectionId: "skill-selection-independent-skipped",
        mode: "shortlist_prompt_context",
        selectedSkillIds: ["skill-a"],
      },
    });
    const records = [
      harnessManifestEvent({
        id: "event-manifest-independent-skipped",
        timestamp: 4_000,
        turn: 9,
        payload: manifest,
      }),
      event({
        id: "event-verification-independent-skipped",
        type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
        timestamp: 4_010,
        turn: 9,
        payload: {
          outcome: "skipped",
          level: "requirements",
          perspective: "independent",
          independenceBasis: ["fresh_context"],
          reviewerContext: { model: "reviewer-model", contextId: "run-1", lenses: [] },
          targetRef: { kind: "patch_sets", patchSetRefs: ["ps-1"] },
          reason: "review was inconclusive: evidence was insufficient to reach a verdict.",
        },
      }),
    ];

    const snapshots = projectSessionHarnessTraceSnapshots({
      sessionId: "session-harness-projection",
      records,
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.verification).toEqual({ weakEvidence: true });
    expect(snapshots[0]?.signals.map((signal) => signal.kind)).toEqual(["verification_hygiene"]);
    expect(snapshots[0]?.signals[0]?.eventIds).toEqual(["event-verification-independent-skipped"]);
  });

  test("uses exact verification and provider retry semantics", () => {
    const manifest = buildHarnessManifest({
      sessionId: "session-harness-projection",
      turn: 5,
      attempt: 1,
      skillSelection: {
        selectionId: "skill-selection-1",
        mode: "shortlist_prompt_context",
        selectedSkillIds: ["skill-a"],
      },
    });
    const records = [
      harnessManifestEvent({
        id: "event-manifest",
        timestamp: 3_000,
        turn: 5,
        payload: manifest,
      }),
      event({
        id: "event-provider-word-only",
        type: "runtime.suspended",
        timestamp: 3_010,
        turn: 5,
        payload: { cause: "not_provider_related" },
      }),
      event({
        id: "event-verification-word-only",
        type: "custom",
        timestamp: 3_020,
        turn: 5,
        payload: { kind: "verification_word_only", status: "weak" },
      }),
      event({
        id: "event-verification-outcome",
        type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
        timestamp: 3_030,
        turn: 5,
        payload: {
          outcome: "fail",
          failedChecks: ["bun test"],
          missingChecks: [],
          missingEvidence: [],
        },
      }),
    ];

    const snapshots = projectSessionHarnessTraceSnapshots({
      sessionId: "session-harness-projection",
      records,
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.signals.map((signal) => signal.kind)).toEqual(["verification_hygiene"]);
    expect(snapshots[0]?.signals[0]?.eventIds).toEqual(["event-verification-outcome"]);
  });

  test("folds evidence through turn indexes without crossing manifests", () => {
    const first = buildHarnessManifest({
      sessionId: "session-harness-projection",
      turn: 6,
      attempt: 1,
    });
    const second = buildHarnessManifest({
      sessionId: "session-harness-projection",
      turn: 7,
      attempt: 1,
    });
    const records = [
      harnessManifestEvent({
        id: "event-manifest-6",
        timestamp: 4_000,
        turn: 6,
        payload: first,
      }),
      harnessManifestEvent({
        id: "event-manifest-7",
        timestamp: 4_010,
        turn: 7,
        payload: second,
      }),
      event({
        id: "event-tool-7",
        type: "tool.committed",
        timestamp: 4_020,
        turn: 7,
        payload: {
          call: { toolName: "missing_tool" },
          result: { outcome: { kind: "err", error: "failed" } },
        },
      }),
    ];

    const snapshots = projectSessionHarnessTraceSnapshots({
      sessionId: "session-harness-projection",
      records,
    });

    expect(snapshots).toHaveLength(2);
    expect(snapshots.find((snapshot) => snapshot.turn === 6)?.tools.committed).toBe(0);
    expect(snapshots.find((snapshot) => snapshot.turn === 7)?.tools.committed).toBe(1);
  });

  test("folds skill selection evidence from the canonical dotted event kind", () => {
    const manifest = buildHarnessManifest({
      sessionId: "session-harness-projection",
      turn: 8,
      attempt: 1,
      skillSelection: {
        selectionId: "skill-selection-1",
        mode: "shortlist_prompt_context",
        selectedSkillIds: ["skill-a"],
      },
    });
    const records = [
      harnessManifestEvent({
        id: "event-manifest",
        timestamp: 5_000,
        turn: 8,
        payload: manifest,
      }),
      event({
        id: "event-skill-selection",
        // Canonical kind emitted by the gateway via ctx.emit and preserved
        // verbatim as record.type by the four-port converter (dotted form).
        type: "skill.selection.recorded",
        timestamp: 5_010,
        turn: 8,
        payload: { omittedCount: 2 },
      }),
    ];

    const snapshots = projectSessionHarnessTraceSnapshots({
      sessionId: "session-harness-projection",
      records,
    });

    expect(snapshots).toHaveLength(1);
    // The manifest records a selection, so the baseline omitted count is 0;
    // folding the advisory event must raise it to the event payload's count.
    expect(snapshots[0]?.skills).toMatchObject({
      selectionId: "skill-selection-1",
      omittedCount: 2,
    });
    // foldSkillSelection records the event id, proving the switch case matched.
    expect(snapshots[0]?.eventIds).toContain("event-skill-selection");
    expect(snapshots[0]?.updatedAt).toBe(5_010);
    expect(snapshots[0]?.signals.map((signal) => signal.kind)).toContain("skill_surface_miss");
  });

  test("patrol rows read only snapshots with projected signals", async () => {
    let observedSql = "";
    const snapshot = {
      schema: "brewva.harness.trace_snapshot.v1" as const,
      snapshotId: "snapshot-signal",
      sessionId: "session-harness-projection",
      attempt: 1,
      manifestId: "manifest-signal",
      eventIds: ["event-signal"],
      provider: { attempts: 1, failures: 1, fallbackActive: false },
      context: { usageRatio: null, gateRequired: false },
      cache: { status: null, unexpectedBreak: false, changedFields: [] },
      skills: { selectionId: null, selectedSkillIds: [], omittedCount: 0 },
      tools: {
        activeToolNames: [],
        requestedUnknownToolNames: [],
        committed: 0,
        errors: 0,
        inconclusive: 0,
      },
      verification: { weakEvidence: false },
      outcome: { status: "failed" },
      signals: [
        {
          kind: "provider_failure" as const,
          severity: "high" as const,
          reason: "provider_failure:detected",
          eventIds: ["event-signal"],
        },
      ],
    };
    const port: SessionIndexQueryPort = {
      async ensureAvailable() {},
      async selectOne<T>() {
        return undefined as T | undefined;
      },
      async selectRows<T>(sql: string) {
        observedSql = sql;
        return [{ snapshot_json: JSON.stringify(snapshot) }] as T[];
      },
    };

    const candidates = await listHarnessPatternCandidateRows({
      port,
      sessionId: "session-harness-projection",
      minOccurrences: 1,
    });

    expect(observedSql).toContain("signal_kinds_json <> '[]'");
    expect(candidates).toMatchObject([{ kind: "provider_failure" }]);
  });
});
