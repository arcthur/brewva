import type {
  RuntimeSessionHydration,
  RuntimeSessionIntegrity,
  WorkspaceRewindReadiness,
} from "@brewva/brewva-tools/contracts";
import type { SessionRewindState } from "@brewva/brewva-vocabulary/session";

type SessionRewindCheckpointRecord = SessionRewindState["checkpoints"][number];
import { describe, expect, test } from "bun:test";
import {
  deriveRecoveryCapabilities,
  type RecoveryCapabilities,
  type RecoveryCapabilityName,
} from "../../../packages/brewva-cli/src/operator/inspect/recovery-capabilities.js";

const emptyRewind: SessionRewindState = {
  checkpoints: [],
  rewindAvailable: false,
  redoAvailable: false,
  redoStack: [],
};

const inconclusiveIntegrity: RuntimeSessionIntegrity = {
  status: "inconclusive",
  cursor: null,
  reason: "checks pending",
  issues: [],
};

const readyWorkspace: WorkspaceRewindReadiness = {
  ready: true,
  windowSize: 0,
  blockedReason: null,
};
const blockedWorkspace: WorkspaceRewindReadiness = {
  ready: false,
  windowSize: 2,
  blockedReason: "rollback_artifact_missing",
};

function cap(caps: RecoveryCapabilities, name: RecoveryCapabilityName) {
  const found = caps.capabilities.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing capability ${name}`);
  return found;
}

describe("recovery capability derivation (RFC WS1)", () => {
  test("a cold clean session is inspectable and replayable but not continuable or rewindable", () => {
    const hydration: RuntimeSessionHydration = {
      status: "cold",
      hydratedAt: 1,
      cursor: { latestEventId: null, eventCount: 0 },
      reason: null,
      issues: [],
    };
    const caps = deriveRecoveryCapabilities({
      hydration,
      integrity: inconclusiveIntegrity,
      rewind: emptyRewind,
      workspaceRewind: readyWorkspace,
    });

    expect(cap(caps, "inspectable").available).toBe(true);
    expect(cap(caps, "replayable").available).toBe(true);
    expect(cap(caps, "continuable").available).toBe(false);
    expect(cap(caps, "rewindableBoth").available).toBe(false);
    expect(cap(caps, "redoable").available).toBe(false);
  });

  test("a ready session with non-degraded integrity is continuable, cursor-bound", () => {
    const hydration: RuntimeSessionHydration = {
      status: "ready",
      hydratedAt: 1,
      cursor: { latestEventId: "e9", eventCount: 9 },
      reason: null,
      issues: [],
    };
    const caps = deriveRecoveryCapabilities({
      hydration,
      integrity: inconclusiveIntegrity,
      rewind: emptyRewind,
      workspaceRewind: readyWorkspace,
    });

    expect(cap(caps, "continuable").available).toBe(true);
    expect(cap(caps, "replayable").available).toBe(true);
    expect(caps.cursor?.latestEventId).toBe("e9");
    expect(cap(caps, "replayable").evidenceRefs).toContain("e9");
  });

  test("a degraded tape blocks replay and continuation with the tape issue as the reason", () => {
    const hydration: RuntimeSessionHydration = {
      status: "degraded",
      hydratedAt: 1,
      cursor: { latestEventId: "e3", eventCount: 3 },
      reason: null,
      issues: [{ domain: "event_tape", severity: "error", reason: "malformed_json at line 4" }],
    };
    const caps = deriveRecoveryCapabilities({
      hydration,
      integrity: inconclusiveIntegrity,
      rewind: emptyRewind,
      workspaceRewind: readyWorkspace,
    });

    expect(cap(caps, "replayable").available).toBe(false);
    expect(cap(caps, "replayable").reasons).toContain("malformed_json at line 4");
    expect(cap(caps, "continuable").available).toBe(false);
  });

  test("an active rewind checkpoint makes rewind capabilities available with checkpoint evidence", () => {
    const checkpoint: SessionRewindCheckpointRecord = {
      checkpointId: "cp1",
      sessionId: "s1",
      turnId: "t1",
      reasoningCheckpointId: "rc1",
      leafEntryId: null,
      turn: 1,
      eventId: "e1",
      timestamp: 1,
      status: "active",
    };
    const rewind: SessionRewindState = {
      checkpoints: [checkpoint],
      rewindAvailable: true,
      redoAvailable: false,
      redoStack: [],
      latestRewindable: checkpoint,
    };
    const hydration: RuntimeSessionHydration = {
      status: "ready",
      hydratedAt: 1,
      cursor: { latestEventId: "e1", eventCount: 1 },
      reason: null,
      issues: [],
    };
    const caps = deriveRecoveryCapabilities({
      hydration,
      integrity: inconclusiveIntegrity,
      rewind,
      workspaceRewind: readyWorkspace,
    });

    expect(cap(caps, "rewindableConversation").available).toBe(true);
    expect(cap(caps, "rewindableConversation").evidenceRefs).toContain("cp1");
    expect(cap(caps, "rewindableBoth").available).toBe(true);
    expect(cap(caps, "rewindableBoth").evidenceRefs).toContain("cp1");
    expect(cap(caps, "redoable").available).toBe(false);
  });

  test("missing rollback material blocks workspace/both rewind but not conversation rewind", () => {
    const checkpoint: SessionRewindCheckpointRecord = {
      checkpointId: "cp1",
      sessionId: "s1",
      turnId: "t1",
      reasoningCheckpointId: "rc1",
      leafEntryId: null,
      turn: 1,
      eventId: "e1",
      timestamp: 1,
      status: "active",
    };
    const rewind: SessionRewindState = {
      checkpoints: [checkpoint],
      rewindAvailable: true,
      redoAvailable: false,
      redoStack: [],
      latestRewindable: checkpoint,
    };
    const hydration: RuntimeSessionHydration = {
      status: "ready",
      hydratedAt: 1,
      cursor: { latestEventId: "e1", eventCount: 1 },
      reason: null,
      issues: [],
    };
    const caps = deriveRecoveryCapabilities({
      hydration,
      integrity: inconclusiveIntegrity,
      rewind,
      workspaceRewind: blockedWorkspace,
    });

    // Capability honesty (RFC WS3): the engine fails closed on missing rollback
    // material, so inspect must not advertise a workspace rewind it would reject.
    expect(cap(caps, "rewindableConversation").available).toBe(true);
    expect(cap(caps, "rewindableWorkspace").available).toBe(false);
    expect(cap(caps, "rewindableWorkspace").reasons.join(" ")).toContain(
      "rollback_artifact_missing",
    );
    expect(cap(caps, "rewindableBoth").available).toBe(false);
  });
});
