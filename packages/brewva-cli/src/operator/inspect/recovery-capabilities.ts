import type {
  RuntimeSessionEvidenceCursor,
  RuntimeSessionHydration,
  RuntimeSessionIntegrity,
  WorkspaceRewindReadiness,
} from "@brewva/brewva-tools/contracts";
import type { SessionRewindState } from "@brewva/brewva-vocabulary/session";

// Recovery posture is a set of evidence-derived capabilities, not one health bit
// (RFC "Project Capabilities, Not One Health Bit"). The stable contract is the
// capability shape — { name, available, reasons, evidenceRefs } plus a source
// cursor — not the fixed set of names, which may grow (e.g. forkable, handoffable)
// without a contract change.

export type RecoveryCapabilityName =
  | "inspectable"
  | "replayable"
  | "continuable"
  | "rewindableConversation"
  | "rewindableWorkspace"
  | "rewindableBoth"
  | "redoable";

export type RecoveryCapability = {
  readonly name: RecoveryCapabilityName;
  readonly available: boolean;
  /** Why the capability is unavailable (empty when available). */
  readonly reasons: readonly string[];
  /** Canonical refs (event ids, checkpoint ids) the verdict was derived from. */
  readonly evidenceRefs: readonly string[];
};

export type RecoveryCapabilities = {
  readonly cursor: RuntimeSessionEvidenceCursor | null;
  readonly capabilities: readonly RecoveryCapability[];
};

export function deriveRecoveryCapabilities(input: {
  readonly hydration: RuntimeSessionHydration;
  readonly integrity: RuntimeSessionIntegrity;
  readonly rewind: SessionRewindState;
  readonly workspaceRewind: WorkspaceRewindReadiness;
}): RecoveryCapabilities {
  const { hydration, integrity, rewind, workspaceRewind } = input;
  const cursor = hydration.cursor ?? integrity.cursor;
  const tapeRefs = cursor?.latestEventId ? [cursor.latestEventId] : [];

  const hydrationReasons =
    hydration.status === "degraded"
      ? hydration.issues.map((issue) => issue.reason)
      : hydration.status === "unavailable"
        ? [hydration.reason]
        : [];
  const integrityDegradedReasons =
    integrity.status === "degraded" ? integrity.issues.map((issue) => issue.reason) : [];

  const replayable = hydration.status === "ready" || hydration.status === "cold";
  const continuable = hydration.status === "ready" && integrity.status !== "degraded";

  const rewindReady = rewind.rewindAvailable && rewind.checkpoints.length > 0;
  const rewindReasons = rewindReady ? [] : ["no active rewind checkpoint"];
  const rewindRefs = rewind.latestRewindable ? [rewind.latestRewindable.checkpointId] : [];
  const redoReady = rewind.redoAvailable && rewind.redoStack.length > 0;

  // Workspace and `both` rewind additionally need the patch window's rollback
  // material; the engine fails closed without it, so the capability must too rather
  // than promise a rewind that would then be rejected.
  const workspaceRewindReady = rewindReady && workspaceRewind.ready;
  const workspaceRewindReasons = !rewindReady
    ? rewindReasons
    : workspaceRewind.ready
      ? []
      : [`workspace rollback material unavailable: ${workspaceRewind.blockedReason ?? "unknown"}`];

  const capabilities: readonly RecoveryCapability[] = [
    { name: "inspectable", available: true, reasons: [], evidenceRefs: tapeRefs },
    {
      name: "replayable",
      available: replayable,
      reasons: replayable ? [] : hydrationReasons,
      evidenceRefs: tapeRefs,
    },
    {
      name: "continuable",
      available: continuable,
      reasons: continuable
        ? []
        : hydration.status === "cold"
          ? ["session has no committed state to continue"]
          : [...hydrationReasons, ...integrityDegradedReasons],
      evidenceRefs: tapeRefs,
    },
    {
      name: "rewindableConversation",
      available: rewindReady,
      reasons: rewindReasons,
      evidenceRefs: rewindRefs,
    },
    {
      name: "rewindableWorkspace",
      available: workspaceRewindReady,
      reasons: workspaceRewindReasons,
      evidenceRefs: rewindRefs,
    },
    {
      name: "rewindableBoth",
      available: workspaceRewindReady,
      reasons: workspaceRewindReasons,
      evidenceRefs: rewindRefs,
    },
    {
      name: "redoable",
      available: redoReady,
      reasons: redoReady ? [] : ["no redo window"],
      evidenceRefs: rewind.nextRedoable ? [rewind.nextRedoable.checkpointId] : [],
    },
  ];

  return { cursor: cursor ?? null, capabilities };
}
