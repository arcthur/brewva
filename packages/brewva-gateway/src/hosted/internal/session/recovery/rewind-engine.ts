import { isRecord } from "@brewva/brewva-std/unknown";
import type { WorkspaceRewindReadiness } from "@brewva/brewva-tools/contracts";
import {
  REASONING_CHECKPOINT_EVENT_TYPE,
  REASONING_REVERT_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/iteration";
import type {
  SessionRedoInput,
  SessionRedoResult,
  SessionRewindInput,
  SessionRewindResult,
} from "@brewva/brewva-vocabulary/session";
import {
  deriveAppliedPatchSetIds,
  type PatchRollbackResult,
} from "@brewva/brewva-vocabulary/workbench";
import { buildHostedPatchRollbackOps } from "../runtime-ops-builders/patches/rollback.js";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import { projectRewindState } from "./rewind-state.js";

// The one rewind/redo transaction owner (RFC WS3), kept out of the session ops
// builder so that builder stays a thin wiring layer. Conversation-only rewind is a
// compensation-free fork (re-anchor reasoning, no file mutation); workspace
// (`code`/`both`) rewind rolls patch sets back to the checkpoint boundary through
// the receipt-bearing rollback capability. The engine emits no new authority-bearing
// canonical event — every mutation flows through an existing receipt-bearing
// capability, and the only durable records it owns are the advisory `reasoning.revert`
// re-anchor and the `session.rewind.completed` coordination receipt.
//
// Crash posture: emits are synchronous tape commits ordered mutations-first,
// commit-receipt-last, and each patch rollback writes its own started/recorded
// receipt, so a crash leaves a visible partial state rather than a silent one. A
// distributed WAL with lease and fencing is intentionally not built here: the
// hosted adapter is a single in-process writer, so there is no concurrent writer
// to fence; that machinery belongs to the daemon control plane, not this engine.

const REWIND_CONTINUITY_SCHEMA = "brewva.session.rewind.continuity.v1" as const;

type ReasoningRevertResult = {
  readonly targetLeafEntryId: string | null;
  readonly continuityPacket: { readonly schema: string; readonly text: string };
};

// Capture a full, executable rewind checkpoint: a reasoning checkpoint is recorded
// alongside so the conversation-fork executor can re-anchor reasoning to it later.
export function recordRewindCheckpoint(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
  input: unknown,
) {
  const fields = isRecord(input) ? input : {};
  const turn = ctx.listEvents(sessionId, { type: "turn.started" }).length;
  const seq = ctx.listEvents(sessionId, { type: "session_rewind_checkpoint" }).length;
  const leafEntryId = typeof fields.leafEntryId === "string" ? fields.leafEntryId : null;
  // Reuse a reasoning checkpoint captured upstream (turn start records one) or
  // capture our own, so the rewind always has a reasoning anchor to revert to.
  const providedReasoning =
    typeof fields.reasoningCheckpointId === "string" ? fields.reasoningCheckpointId : "";
  const reasoningCheckpointId = providedReasoning || `reasoning:${turn}:${seq}`;
  if (!providedReasoning) {
    ctx.emit(sessionId, REASONING_CHECKPOINT_EVENT_TYPE, {
      checkpointId: reasoningCheckpointId,
      branchId: "main",
      boundary: "rewind",
      leafEntryId,
    });
  }
  // The workspace window a later rewind reverses is derived from tape order (the
  // patch sets applied after this checkpoint), so the checkpoint needs no
  // high-water snapshot — tape order, not a captured id, is authoritative.
  return ctx.emit(sessionId, "session_rewind_checkpoint", {
    ...fields,
    reasoningCheckpointId,
    turn,
  });
}

interface WorkspaceRollbackOutcome {
  readonly results: readonly PatchRollbackResult[];
  readonly patchSetIds: readonly string[];
  readonly failure?: PatchRollbackResult;
}

// The exact workspace window a rewind must reverse: patch sets applied after the
// checkpoint (by tape order, never wall-clock) that are still applied, oldest to
// newest. Boundary and older patch sets are excluded by construction, so their
// rollback material is irrelevant to this rewind. Tape order is authoritative —
// same-millisecond or replayed events must not reorder or drop the window.
//
// Delegates the applied-minus-rolled-back fold to the shared
// deriveAppliedPatchSetIds (@brewva/brewva-vocabulary/workbench) — the same
// pure scan the review-debt projection's effectful shell uses for "what is
// applied right now" — over the slice strictly after the checkpoint. Slicing
// first, folding second is equivalent to the prior single-pass index guard:
// the fold only ever looks at events at its own index, never ahead.
function derivePatchWindowAfterCheckpoint(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
  checkpointEventId: string | undefined,
): string[] {
  const events = ctx.listEvents(sessionId);
  const checkpointIndex = checkpointEventId
    ? events.findIndex((event) => event.id === checkpointEventId)
    : -1;
  return [...deriveAppliedPatchSetIds(events.slice(checkpointIndex + 1))];
}

// Reverse exactly the checkpoint window, newest first, through the receipt-bearing
// rollback capability. The boundary patch (and anything older) is never reversed,
// so its rollback material being missing or invalid cannot fail this rewind — only
// a missing or invalid artifact for a WINDOW patch fails closed (RFC failure
// semantics: missing rollback material makes a workspace rewind unavailable).
// Window exhaustion is success; a failed rollback step stops with the partial
// result; the guard caps a pathological loop.
function rollbackWorkspaceToBoundary(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
  windowPatchSetIds: readonly string[],
): WorkspaceRollbackOutcome {
  const patchRollback = buildHostedPatchRollbackOps(ctx);
  const results: PatchRollbackResult[] = [];
  const patchSetIds: string[] = [];
  const remaining = new Set(windowPatchSetIds);
  for (let guard = 0; guard < 10_000 && remaining.size > 0; guard += 1) {
    const candidate = patchRollback.rollbackCandidate(sessionId);
    if (!candidate.available) {
      // The next window patch to reverse has no usable rollback material.
      return {
        results,
        patchSetIds,
        failure: {
          ok: false,
          restoredPaths: [],
          failedPaths: [],
          reason: candidate.noCandidateReason ?? "rollback_artifact_missing",
        },
      };
    }
    const candidatePatchSetId = candidate.patchSetId;
    if (candidatePatchSetId === undefined || !remaining.has(candidatePatchSetId)) {
      // Reached the boundary (or older): the window is fully reversed.
      break;
    }
    const result = patchRollback.rollbackLastPatchSet(sessionId);
    results.push(result);
    if (!result.ok) return { results, patchSetIds, failure: result };
    if (result.patchSetId) {
      patchSetIds.push(result.patchSetId);
      remaining.delete(result.patchSetId);
    }
  }
  return { results, patchSetIds };
}

// One rewind transaction owner. Conversation-only rewind is a compensation-free
// fork (re-anchor reasoning, no file mutation). Workspace (`code`/`both`) rewind
// rolls patch sets back to the checkpoint boundary through the receipt-bearing
// rollback capability; a failed or materially-incomplete rollback stops with a
// visible result that blocks continuation rather than compensating silently. The
// reasoning re-anchor is emitted as a canonical `reasoning.revert` so the live
// session store and a cold hydration converge on the same conversation leaf, and
// the result carries the same `reasoningRevert` so the interactive shell switches
// the in-memory leaf immediately.
export function executeRewind(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
  input: SessionRewindInput,
): SessionRewindResult {
  const mode = input.mode ?? "both";
  const summary = input.summary ?? "carry";
  const summaryMode = summary === "none" ? "none" : "carry";
  const events = ctx.listEvents(sessionId);
  const state = projectRewindState(sessionId, events);
  const target = input.checkpointId
    ? state.checkpoints.find(
        (checkpoint) =>
          checkpoint.checkpointId === input.checkpointId &&
          (checkpoint.status === "active" || checkpoint.status === "redone"),
      )
    : state.latestRewindable;
  if (!target) {
    return { ok: false, reason: "no_checkpoint", trigger: "rewind", mode, summary };
  }

  const touchesWorkspace = mode === "code" || mode === "both";
  const touchesConversation = mode === "conversation" || mode === "both";

  const checkpointEvent = events.find(
    (event) =>
      event.type === "session_rewind_checkpoint" &&
      (typeof event.payload?.checkpointId === "string" ? event.payload.checkpointId : event.id) ===
        target.checkpointId,
  );

  // One tape-ordered window drives both the workspace rollback and the
  // conversation-only divergence count, so the two can never disagree.
  const windowPatchSetIds = derivePatchWindowAfterCheckpoint(ctx, sessionId, checkpointEvent?.id);

  let rollbackResults: readonly PatchRollbackResult[] = [];
  let rolledPatchSetIds: readonly string[] = [];
  if (touchesWorkspace) {
    const rollback = rollbackWorkspaceToBoundary(ctx, sessionId, windowPatchSetIds);
    rollbackResults = rollback.results;
    rolledPatchSetIds = rollback.patchSetIds;
    if (rollback.failure) {
      return {
        ok: false,
        reason: "rollback_failed",
        trigger: "rewind",
        mode,
        summary,
        checkpoint: target,
        patchSetIds: rolledPatchSetIds,
        rollbackResults,
        error: rollback.failure.reason,
      };
    }
  }

  // Conversation lineage only forks when conversation state is in scope; a
  // code-only rewind leaves the reasoning lineage and its checkpoints untouched.
  const targetIndex = state.checkpoints.findIndex(
    (checkpoint) => checkpoint.checkpointId === target.checkpointId,
  );
  const abandonedCheckpointIds = touchesConversation
    ? state.checkpoints
        .slice(targetIndex + 1)
        .filter((checkpoint) => checkpoint.status === "active" || checkpoint.status === "redone")
        .map((checkpoint) => checkpoint.checkpointId)
    : [];

  // Build the reasoning re-anchor first so the completed receipt can reference it
  // (and so a crash leaves the re-anchor without a commit, never the reverse).
  let reasoningRevert: ReasoningRevertResult | undefined;
  let reasoningRevertEventId: string | undefined;
  if (touchesConversation) {
    const continuityText =
      typeof input.summaryHint === "string" && input.summaryHint.length > 0
        ? input.summaryHint
        : `Rewound to checkpoint ${target.checkpointId}.`;
    const continuityPacket = { schema: REWIND_CONTINUITY_SCHEMA, text: continuityText };
    reasoningRevert = { targetLeafEntryId: target.leafEntryId, continuityPacket };
    const revertEvent = ctx.emit(sessionId, REASONING_REVERT_EVENT_TYPE, {
      revertId: `revert:${target.checkpointId}`,
      toCheckpointId: target.reasoningCheckpointId || target.checkpointId,
      trigger: "rewind",
      targetLeafEntryId: target.leafEntryId,
      linkedRollbackReceiptIds: rolledPatchSetIds,
      continuityPacket,
    });
    reasoningRevertEventId = revertEvent.id;
  }

  // A one-sided rewind leaves the untouched plane ahead of the rewound one.
  let divergenceNote: Extract<SessionRewindResult, { ok: true }>["divergenceNote"];
  if (touchesWorkspace && !touchesConversation && rolledPatchSetIds.length > 0) {
    divergenceNote = {
      kind: "conversation_ahead",
      text: `Workspace rolled back ${rolledPatchSetIds.length} patch set(s); conversation lineage left in place.`,
      patchSetCount: rolledPatchSetIds.length,
      parentLeafEntryId: target.leafEntryId,
    };
  } else if (touchesConversation && !touchesWorkspace) {
    const aheadCount = windowPatchSetIds.length;
    if (aheadCount > 0) {
      divergenceNote = {
        kind: "workspace_ahead",
        text: `Conversation rewound; ${aheadCount} workspace patch set(s) left in place.`,
        patchSetCount: aheadCount,
        parentLeafEntryId: target.leafEntryId,
      };
    }
  }

  // Commit point: the coordination receipt is the last write and the single event
  // all projections key off (rewind-state for status, session store for the leaf).
  ctx.emit(sessionId, "session.rewind.completed", {
    ok: true,
    checkpointId: target.checkpointId,
    trigger: "rewind",
    mode,
    summary: summaryMode,
    abandonedCheckpointIds,
    patchSetIds: rolledPatchSetIds,
    returnLeafEntryId: target.leafEntryId,
    ...(reasoningRevertEventId ? { reasoningRevertEventId } : {}),
    ...(divergenceNote ? { divergenceNote } : {}),
  });

  return {
    ok: true,
    checkpoint: target,
    abandonedCheckpointIds,
    patchSetIds: rolledPatchSetIds,
    rollbackResults,
    returnLeafEntryId: target.leafEntryId,
    trigger: "rewind",
    mode,
    summary,
    ...(reasoningRevert ? { reasoningRevert } : {}),
    ...(divergenceNote ? { divergenceNote } : {}),
  };
}

// Redo reapplies a recorded, undone rewind window by re-anchoring reasoning forward
// to the redone checkpoint and recording a durable completion. A specific
// `checkpointId` may be requested; otherwise the most recent undone checkpoint is
// reused. It is unavailable when nothing is undone, the requested target is not
// redoable, or a later checkpoint has superseded the redo window.
export function executeRedo(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
  input?: SessionRedoInput,
): SessionRedoResult {
  const state = projectRewindState(sessionId, ctx.listEvents(sessionId));
  if (!state.redoAvailable) {
    return { ok: false, reason: "no_redo" };
  }
  const requestedId = input?.checkpointId;
  const target = requestedId
    ? state.checkpoints.find(
        (checkpoint) =>
          checkpoint.checkpointId === requestedId &&
          checkpoint.status === "undone" &&
          state.redoStack.some((entry) => entry.checkpointId === requestedId),
      )
    : state.nextRedoable;
  if (!target) {
    return { ok: false, reason: requestedId ? "checkpoint_not_redoable" : "no_redo" };
  }

  const revertEvent = ctx.emit(sessionId, REASONING_REVERT_EVENT_TYPE, {
    revertId: `redo:${target.checkpointId}`,
    toCheckpointId: target.reasoningCheckpointId || target.checkpointId,
    trigger: "redo",
    targetLeafEntryId: target.leafEntryId,
    continuityPacket: {
      schema: REWIND_CONTINUITY_SCHEMA,
      text: `Redone checkpoint ${target.checkpointId}.`,
    },
  });
  ctx.emit(sessionId, "session.redo.completed", {
    ok: true,
    checkpointId: target.checkpointId,
    mode: "conversation",
    summary: "none",
    patchSetIds: [],
    returnLeafEntryId: target.leafEntryId,
    reasoningRevertEventId: revertEvent.id,
  });

  return {
    ok: true,
    checkpoint: target,
    patchSetIds: [],
    redoResults: [],
    returnLeafEntryId: target.leafEntryId,
    reasoningCheckpoint: { checkpointId: target.reasoningCheckpointId || target.checkpointId },
  };
}

// Readonly preview of whether a workspace (`code`/`both`) rewind to the targeted
// checkpoint (or the latest rewindable one) can reverse its patch window — every
// window patch must still have valid rollback material. Shares the one tape-ordered
// window derivation the executor uses, so inspect's capability cannot disagree with
// what the engine would actually do.
export function previewWorkspaceRewind(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
  checkpointId?: string,
): WorkspaceRewindReadiness {
  const events = ctx.listEvents(sessionId);
  const state = projectRewindState(sessionId, events);
  const target = checkpointId
    ? state.checkpoints.find(
        (checkpoint) =>
          checkpoint.checkpointId === checkpointId &&
          (checkpoint.status === "active" || checkpoint.status === "redone"),
      )
    : state.latestRewindable;
  if (!target) {
    return { ready: false, windowSize: 0, blockedReason: "no_checkpoint" };
  }
  const checkpointEvent = events.find(
    (event) =>
      event.type === "session_rewind_checkpoint" &&
      (typeof event.payload?.checkpointId === "string" ? event.payload.checkpointId : event.id) ===
        target.checkpointId,
  );
  const window = derivePatchWindowAfterCheckpoint(ctx, sessionId, checkpointEvent?.id);
  const readiness = buildHostedPatchRollbackOps(ctx).previewWindowRollback(sessionId, window);
  return {
    ready: readiness.ready,
    windowSize: window.length,
    blockedReason: readiness.blockedReason,
  };
}
