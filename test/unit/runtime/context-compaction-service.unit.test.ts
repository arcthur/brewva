import { describe, expect, test } from "bun:test";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import { asBrewvaEventType } from "@brewva/brewva-runtime/events";
import {
  commitSessionCompaction,
  type ContextCompactionDeps,
} from "../../../packages/brewva-runtime/src/domain/context/context-compaction.js";
import type { BrewvaEventRecord } from "../../../packages/brewva-runtime/src/events/types.js";

function emptyCacheImpact() {
  return {
    before: null,
    after: null,
    explicitEpochChanges: 1,
    prefixBytesChanged: null,
    degradedReason: null,
  };
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

function createDeps(input?: { governancePort?: ContextCompactionDeps["governancePort"] }): {
  deps: ContextCompactionDeps;
  events: Array<{
    sessionId: string;
    type: string;
    turn?: number;
    payload?: object;
  }>;
  pressureMarks: string[];
} {
  const events: Array<{
    sessionId: string;
    type: string;
    turn?: number;
    payload?: object;
  }> = [];
  const pressureMarks: string[] = [];
  return {
    deps: {
      governancePort: input?.governancePort,
      markPressureCompacted: (sessionId) => {
        pressureMarks.push(sessionId);
      },
      getCurrentTurn: () => 17,
      recordEvent: (eventInput) => {
        events.push(eventInput);
        return createRecordedEvent(events.length, eventInput);
      },
    },
    events,
    pressureMarks,
  };
}

describe("context-compaction module", () => {
  test("records only the durable session_compact receipt", async () => {
    const { deps, events, pressureMarks } = createDeps();

    await commitSessionCompaction(deps, "session-a", {
      compactId: "  cmp-42 ",
      sanitizedSummary: "  keep latest failures only  ",
      summaryDigest: "unused",
      sourceTurn: 17,
      leafEntryId: "leaf-a",
      referenceContextDigest: "ref-digest",
      fromTokens: 900,
      toTokens: 320,
      origin: "auto_compaction",
      cacheImpact: emptyCacheImpact(),
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
          cacheImpact: emptyCacheImpact(),
        }),
      }),
    );
  });

  test("awaits governance integrity check inside the commit barrier", async () => {
    const { deps, events } = createDeps({
      governancePort: {
        checkCompactionIntegrity: async () => ({ ok: true }),
      },
    });

    await commitSessionCompaction(deps, "session-b", {
      compactId: "cmp-43",
      sanitizedSummary: "keep latest failures only",
      summaryDigest: "unused",
      sourceTurn: 17,
      leafEntryId: null,
      referenceContextDigest: null,
      fromTokens: 900,
      toTokens: 320,
      origin: "auto_compaction",
      cacheImpact: emptyCacheImpact(),
    });

    expect(events.map((event) => event.type)).toEqual([
      "session_compact",
      "governance_compaction_integrity_checked",
    ]);
  });
});
