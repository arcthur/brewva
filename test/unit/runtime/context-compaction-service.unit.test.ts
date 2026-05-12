import { describe, expect, test } from "bun:test";
import { asBrewvaSessionId } from "@brewva/brewva-runtime";
import { asBrewvaEventType } from "@brewva/brewva-runtime/events";
import {
  commitSessionCompaction,
  type ContextCompactionDeps,
} from "../../../packages/brewva-runtime/src/domain/context/context-compaction.js";
import { RuntimeSessionStateStore } from "../../../packages/brewva-runtime/src/domain/sessions/session-state.js";
import type { BrewvaEventRecord } from "../../../packages/brewva-runtime/src/events/types.js";

async function flushAsyncEvents(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createRecordedEvent(
  index: number,
  input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: object;
  },
): BrewvaEventRecord {
  return {
    id: `ev-${index}`,
    sessionId: asBrewvaSessionId(input.sessionId),
    type: asBrewvaEventType(input.type),
    timestamp: 1,
    turn: input.turn,
    payload: input.payload as BrewvaEventRecord["payload"],
  };
}

describe("context-compaction module", () => {
  test("marks compaction without clearing prompt-cache state, emits event, and appends ledger evidence", () => {
    const sessionState = new RuntimeSessionStateStore();

    const events: Array<{
      sessionId: string;
      type: string;
      turn?: number;
      payload?: object;
    }> = [];
    const ledgerRows: Array<Record<string, unknown>> = [];
    const pressureMarks: string[] = [];

    const deps: ContextCompactionDeps = {
      workspaceRoot: "/tmp/context-compaction",
      sessionState,
      recordInfrastructureRow: (row) => {
        ledgerRows.push(row as Record<string, unknown>);
        return "ev_test";
      },
      markPressureCompacted: (sessionId) => {
        pressureMarks.push(sessionId);
      },
      getCurrentTurn: () => 17,
      recordEvent: (input) => {
        events.push(input);
        return createRecordedEvent(events.length, input);
      },
    };

    commitSessionCompaction(deps, "session-a", {
      compactId: "  cmp-42 ",
      sanitizedSummary: "  keep latest failures only  ",
      summaryDigest: "unused",
      sourceTurn: 17,
      leafEntryId: "leaf-a",
      referenceContextDigest: "ref-digest",
      fromTokens: 900,
      toTokens: 320,
      origin: "auto_compaction",
    });

    expect(pressureMarks).toEqual(["session-a"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        sessionId: "session-a",
        type: "session_compact",
        turn: 17,
        payload: expect.objectContaining({
          compactId: "cmp-42",
          fromTokens: 900,
          toTokens: 320,
          leafEntryId: "leaf-a",
          referenceContextDigest: "ref-digest",
          sanitizedSummary: "keep latest failures only",
          cacheImpact: expect.objectContaining({
            before: null,
            after: null,
            explicitEpochChanges: 1,
            prefixBytesChanged: null,
            degradedReason: null,
          }),
        }),
      }),
    );

    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]).toEqual(
      expect.objectContaining({
        sessionId: "session-a",
        turn: 17,
        tool: "brewva_session_compaction",
        skill: null,
      }),
    );
    expect(ledgerRows[0]?.metadata).toEqual(
      expect.objectContaining({
        source: "session_compact",
        fromTokens: 900,
        toTokens: 320,
        compactId: "cmp-42",
      }),
    );
  });

  test("keeps compaction payload normalization when summary text is empty after trim", () => {
    const sessionState = new RuntimeSessionStateStore();

    const events: Array<{
      sessionId: string;
      type: string;
      turn?: number;
      payload?: object;
    }> = [];

    const deps: ContextCompactionDeps = {
      workspaceRoot: "/tmp/context-compaction",
      sessionState,
      recordInfrastructureRow: () => "ev_test",
      markPressureCompacted: () => undefined,
      getCurrentTurn: () => 3,
      recordEvent: (input) => {
        events.push(input);
        return createRecordedEvent(events.length, input);
      },
    };

    commitSessionCompaction(deps, "session-a", {
      compactId: "  ",
      sanitizedSummary: "   ",
      summaryDigest: "unused",
      sourceTurn: 3,
      leafEntryId: null,
      referenceContextDigest: null,
      fromTokens: null,
      toTokens: null,
      origin: "auto_compaction",
    });

    expect(events[0]?.payload).toEqual(
      expect.objectContaining({
        compactId: "",
        sanitizedSummary: "",
      }),
    );
  });

  test("records cache impact baseline from the last provider cache observation", () => {
    const sessionState = new RuntimeSessionStateStore();
    sessionState.setProviderCacheObservation("session-cache", {
      turn: 8,
      updatedAt: 123,
      source: "bucket-a",
      fingerprint: {
        bucketKey: "bucket-a",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4",
        cachePolicyHash: "cache-policy",
        toolSchemaSnapshotHash: "tools",
        toolSchemaOverlayHash: "tool-overlay",
        perToolHashes: {},
        stablePrefixHash: "stable-prefix",
        dynamicTailHash: "dynamic-tail",
        requestHash: "request",
        channelContextHash: "channel",
        renderedCacheHash: "rendered",
        cacheCapabilityHash: "capability",
        stickyLatchHash: "sticky",
        reasoningHash: "reasoning",
        thinkingBudgetHash: "thinking",
        cacheRelevantHeadersHash: "headers",
        extraBodyHash: "body",
        visibleHistoryReductionHash: "visible-history",
        workbenchContextHash: "workbench",
        providerFallbackHash: "provider-fallback",
      },
      render: {
        status: "rendered",
        reason: "ok",
        renderedRetention: "short",
        bucketKey: "bucket-a",
      },
      breakObservation: {
        status: "warm",
        classification: "prefixPreserving",
        expected: false,
        reason: null,
        previousCacheReadTokens: 20,
        cacheReadTokens: 15,
        cacheWriteTokens: 5,
        cacheMissTokens: 0,
        thresholdTokens: 1_000,
        relativeDropThreshold: 0.2,
        changedFields: [],
      },
    });
    const events: Array<{
      sessionId: string;
      type: string;
      turn?: number;
      payload?: object;
    }> = [];

    const deps: ContextCompactionDeps = {
      workspaceRoot: "/tmp/context-compaction",
      sessionState,
      recordInfrastructureRow: () => "ev_test",
      markPressureCompacted: () => undefined,
      getCurrentTurn: () => 8,
      recordEvent: (input) => {
        events.push(input);
        return createRecordedEvent(events.length, input);
      },
    };

    commitSessionCompaction(deps, "session-cache", {
      compactId: "cmp-cache",
      sanitizedSummary: "cache summary",
      summaryDigest: "unused",
      sourceTurn: 8,
      leafEntryId: null,
      referenceContextDigest: null,
      fromTokens: 800,
      toTokens: 240,
      origin: "auto_compaction",
    });

    expect(events[0]?.payload).toEqual(
      expect.objectContaining({
        cacheImpact: expect.objectContaining({
          before: expect.objectContaining({
            cacheReadTokens: 15,
            cacheWriteTokens: 5,
            bucketKey: "bucket-a",
            stablePrefixHash: "stable-prefix",
            dynamicTailHash: "dynamic-tail",
            visibleHistoryReductionHash: "visible-history",
            workbenchContextHash: "workbench",
          }),
          after: null,
          explicitEpochChanges: 1,
        }),
      }),
    );
  });

  test("emits governance_compaction_integrity_checked when governance port accepts summary", async () => {
    const sessionState = new RuntimeSessionStateStore();
    const events: Array<{
      sessionId: string;
      type: string;
      turn?: number;
      payload?: object;
    }> = [];

    const deps: ContextCompactionDeps = {
      workspaceRoot: "/tmp/context-compaction",
      sessionState,
      recordInfrastructureRow: () => "ev_test",
      governancePort: {
        checkCompactionIntegrity: () => ({ ok: true }),
      },
      markPressureCompacted: () => undefined,
      getCurrentTurn: () => 3,
      recordEvent: (input) => {
        events.push(input);
        return createRecordedEvent(events.length, input);
      },
    };

    commitSessionCompaction(deps, "session-a", {
      compactId: "cmp-ok",
      sanitizedSummary: "compact summary",
      summaryDigest: "unused",
      sourceTurn: 3,
      leafEntryId: null,
      referenceContextDigest: null,
      fromTokens: 400,
      toTokens: 120,
      origin: "auto_compaction",
    });
    await flushAsyncEvents();

    expect(events.some((event) => event.type === "governance_compaction_integrity_checked")).toBe(
      true,
    );
  });

  test("emits governance_compaction_integrity_failed when governance port rejects summary", async () => {
    const sessionState = new RuntimeSessionStateStore();
    const events: Array<{
      sessionId: string;
      type: string;
      turn?: number;
      payload?: object;
    }> = [];

    const deps: ContextCompactionDeps = {
      workspaceRoot: "/tmp/context-compaction",
      sessionState,
      recordInfrastructureRow: () => "ev_test",
      governancePort: {
        checkCompactionIntegrity: () => ({ ok: false, reason: "missing-required-fact" }),
      },
      markPressureCompacted: () => undefined,
      getCurrentTurn: () => 3,
      recordEvent: (input) => {
        events.push(input);
        return createRecordedEvent(events.length, input);
      },
    };

    commitSessionCompaction(deps, "session-a", {
      compactId: "cmp-failed",
      sanitizedSummary: "compact summary",
      summaryDigest: "unused",
      sourceTurn: 3,
      leafEntryId: null,
      referenceContextDigest: null,
      fromTokens: 400,
      toTokens: 120,
      origin: "auto_compaction",
    });
    await flushAsyncEvents();

    const failed = events.find((event) => event.type === "governance_compaction_integrity_failed");
    expect(failed).toBeDefined();
    const payload = failed?.payload as { reason?: string } | undefined;
    expect(payload?.reason).toBe("missing-required-fact");
  });

  test("emits governance_compaction_integrity_error when governance port throws", async () => {
    const sessionState = new RuntimeSessionStateStore();
    const events: Array<{
      sessionId: string;
      type: string;
      turn?: number;
      payload?: object;
    }> = [];

    const deps: ContextCompactionDeps = {
      workspaceRoot: "/tmp/context-compaction",
      sessionState,
      recordInfrastructureRow: () => "ev_test",
      governancePort: {
        checkCompactionIntegrity: () => {
          throw new Error("compaction-integrity-port-error");
        },
      },
      markPressureCompacted: () => undefined,
      getCurrentTurn: () => 3,
      recordEvent: (input) => {
        events.push(input);
        return createRecordedEvent(events.length, input);
      },
    };

    commitSessionCompaction(deps, "session-a", {
      compactId: "cmp-error",
      sanitizedSummary: "compact summary",
      summaryDigest: "unused",
      sourceTurn: 3,
      leafEntryId: null,
      referenceContextDigest: null,
      fromTokens: 400,
      toTokens: 120,
      origin: "auto_compaction",
    });
    await flushAsyncEvents();

    const errored = events.find((event) => event.type === "governance_compaction_integrity_error");
    expect(errored).toBeDefined();
    const payload = errored?.payload as { error?: string } | undefined;
    expect(payload?.error).toContain("compaction-integrity-port-error");
  });
});
