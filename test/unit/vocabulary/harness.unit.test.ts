import { describe, expect, test } from "bun:test";
import {
  buildHarnessTraceSnapshotId,
  buildHarnessManifest,
  CAPABILITY_SELECTION_RECORDED_EVENT_TYPE,
  clusterHarnessTraceSnapshots,
  CONTEXT_EVIDENCE_APPENDED_EVENT_TYPE,
  HARNESS_MANIFEST_RECORDED_EVENT_AUTHORITY,
  HARNESS_MANIFEST_RECORDED_EVENT_NAMESPACE,
  HARNESS_MANIFEST_RECORDED_EVENT_TYPE,
  HARNESS_MANIFEST_RECORDED_EVENT_VERSION,
  HARNESS_MANIFEST_SCHEMA,
  redactHarnessManifest,
  readHarnessManifestRecordedAdvisoryEvent,
  SKILL_SELECTION_RECORDED_EVENT_TYPE,
  stableHarnessId,
  TOOL_SURFACE_RESOLVED_EVENT_TYPE,
  unwrapHarnessManifestRecordedAdvisoryPayload,
  wrapHarnessManifestRecordedAdvisoryPayload,
  type HarnessTraceSnapshot,
} from "@brewva/brewva-vocabulary/harness";

describe("harness vocabulary", () => {
  test("pins the wire values of the harness-folded advisory event kinds", () => {
    // These constants are the single source of truth shared by the gateway emit
    // sites and the session-index harness fold; the literals must never drift.
    // context_evidence_appended intentionally stays snake_case because the value
    // is persisted on the tape — dotting it would break replay of existing events.
    expect(SKILL_SELECTION_RECORDED_EVENT_TYPE).toBe("skill.selection.recorded");
    expect(CAPABILITY_SELECTION_RECORDED_EVENT_TYPE).toBe("tool.capability.selected");
    expect(TOOL_SURFACE_RESOLVED_EVENT_TYPE).toBe("tool.surface.resolved");
    expect(CONTEXT_EVIDENCE_APPENDED_EVENT_TYPE).toBe("context_evidence_appended");
  });

  test("builds a stable redacted manifest identity", () => {
    const first = buildHarnessManifest({
      sessionId: "session-harness",
      turn: 2,
      attempt: 1,
      runtime: {
        configHash: "hash:config",
        buildVersion: "0.1.0",
      },
      prompt: {
        systemPromptHash: "hash:system",
        blockHashes: ["hash:block-a", "hash:block-b"],
      },
      tools: {
        activeToolNames: ["exec", "source_read"],
        toolSchemaSnapshotHash: "hash:tools",
      },
      skillSelection: {
        selectionId: "skill-selection-1",
        mode: "shortlist_prompt_context",
        selectedSkillIds: ["skill-a"],
        renderedContextHash: "hash:skills",
      },
      capabilitySelection: {
        selectionId: "capability-selection-1",
        selectedCapabilityNames: ["source"],
      },
      context: {
        materializationPolicyHash: "hash:context-policy",
        compactionPolicyHash: "hash:compaction-policy",
        promptStablePrefixHash: "hash:stable-prefix",
        promptDynamicTailHash: "hash:dynamic-tail",
      },
      provider: {
        provider: "faux",
        api: "faux",
        model: "faux-model",
        transport: "auto",
        cachePolicyHash: "hash:cache-policy",
        requestHash: "hash:request",
        providerFallbackHash: "hash:fallback",
      },
      plugins: {
        mutatingHookIds: ["before_provider_request:test"],
      },
      refs: {
        sourceEventIds: ["event-manifest-source"],
      },
    });
    const second = buildHarnessManifest({
      ...first,
      manifestId: undefined,
    });

    expect(first.schema).toBe(HARNESS_MANIFEST_SCHEMA);
    expect(first.eventType).toBe(HARNESS_MANIFEST_RECORDED_EVENT_TYPE);
    expect(second.manifestId).toBe(first.manifestId);
    expect(first.manifestId).toStartWith("harness_manifest:");
    expect(first.manifestId.split(":")[1]).toHaveLength(32);
    expect(JSON.stringify(first)).not.toContain("raw prompt");
  });

  test("derives Harness ids from redacted SHA-256 json fingerprints", () => {
    const left = stableHarnessId("harness_candidate", {
      sessionId: "session-harness",
      apiKey: "secret-a",
      nested: { z: 1, a: 2 },
    });
    const right = stableHarnessId("harness_candidate", {
      nested: { a: 2, z: 1 },
      apiKey: "secret-b",
      sessionId: "session-harness",
    });

    expect(left).toBe(right);
    expect(left).toMatch(/^harness_candidate:[a-f0-9]{32}$/);
  });

  test("rejects unsafe raw payload fields at the manifest boundary", () => {
    expect(() =>
      redactHarnessManifest({
        schema: HARNESS_MANIFEST_SCHEMA,
        eventType: HARNESS_MANIFEST_RECORDED_EVENT_TYPE,
        manifestId: "harness_manifest:unsafe",
        sessionId: "session-harness",
        turn: 1,
        attempt: 1,
        prompt: {
          systemPromptHash: "hash:system",
          rawPrompt: "raw prompt must not persist",
        },
      } as unknown),
    ).toThrow("harness_manifest_unsafe_field:rawPrompt");
  });

  test("rejects unsafe snake_case payload fields at the manifest boundary", () => {
    expect(() =>
      redactHarnessManifest({
        schema: HARNESS_MANIFEST_SCHEMA,
        eventType: HARNESS_MANIFEST_RECORDED_EVENT_TYPE,
        manifestId: "harness_manifest:unsafe",
        sessionId: "session-harness",
        turn: 1,
        attempt: 1,
        prompt: {
          systemPromptHash: "hash:system",
          raw_prompt: "raw prompt must not persist",
        },
      } as unknown),
    ).toThrow("harness_manifest_unsafe_field:raw_prompt");
  });

  test("wraps and unwraps the advisory manifest envelope through one contract", () => {
    const manifest = buildHarnessManifest({
      sessionId: "session-harness",
      attempt: 1,
    });
    const envelope = wrapHarnessManifestRecordedAdvisoryPayload(manifest);

    expect(envelope).toMatchObject({
      namespace: HARNESS_MANIFEST_RECORDED_EVENT_NAMESPACE,
      kind: HARNESS_MANIFEST_RECORDED_EVENT_TYPE,
      version: HARNESS_MANIFEST_RECORDED_EVENT_VERSION,
      authority: HARNESS_MANIFEST_RECORDED_EVENT_AUTHORITY,
      payload: { manifestId: manifest.manifestId },
    });
    expect(
      unwrapHarnessManifestRecordedAdvisoryPayload({
        type: "custom",
        payload: envelope,
      }),
    ).toMatchObject({ manifestId: manifest.manifestId });
    expect(
      readHarnessManifestRecordedAdvisoryEvent({
        type: "custom",
        payload: envelope,
      }),
    ).toMatchObject({ manifestId: manifest.manifestId });
    expect(
      unwrapHarnessManifestRecordedAdvisoryPayload({
        type: "custom",
        payload: { ...envelope, authority: "canonical" },
      }),
    ).toEqual(undefined);
  });

  test("builds snapshot ids from manifest identity rather than folded signals", () => {
    const manifest = buildHarnessManifest({
      sessionId: "session-harness",
      turn: 1,
      turnId: "turn-1",
      attempt: 1,
    });

    expect(
      buildHarnessTraceSnapshotId({
        sessionId: manifest.sessionId,
        turn: manifest.turn,
        turnId: manifest.turnId,
        attempt: manifest.attempt,
        manifestId: manifest.manifestId,
      }),
    ).toMatch(/^harness_snapshot:[a-f0-9]{32}$/);
  });

  test("clusters trace snapshots with a low confidence single-occurrence candidate", () => {
    const snapshot: HarnessTraceSnapshot = {
      schema: "brewva.harness.trace_snapshot.v1",
      snapshotId: "snapshot-a",
      sessionId: "session-a",
      attempt: 1,
      manifestId: "manifest-a",
      eventIds: ["event-a"],
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
      outcome: { status: "error" },
      signals: [
        {
          kind: "provider_failure",
          severity: "high",
          reason: "provider_failure:detected",
          eventIds: ["event-a"],
        },
      ],
    };

    expect(clusterHarnessTraceSnapshots([snapshot], { minOccurrences: 1 })).toMatchObject([
      {
        kind: "provider_failure",
        occurrenceCount: 1,
        severity: "high",
        confidence: "low",
      },
    ]);
  });
});
