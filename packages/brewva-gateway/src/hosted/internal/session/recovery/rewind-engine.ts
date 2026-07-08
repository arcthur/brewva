import { isRecord } from "@brewva/brewva-std/unknown";
import type {
  WorkspaceRewindReadiness,
  WorldRewindAvailability,
} from "@brewva/brewva-tools/contracts";
import {
  buildWorldCheckpointBlock,
  createWorkspaceWorldStore,
  type WorkspaceWorldStore,
} from "@brewva/brewva-tools/world-store";
import {
  REASONING_CHECKPOINT_EVENT_TYPE,
  REASONING_REVERT_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/iteration";
import {
  parseWorldCheckpointBlock,
  SESSION_REWIND_CHECKPOINT_EVENT_TYPE,
  type SessionRedoInput,
  type SessionWorldRestoreRecord,
  type SessionRedoResult,
  type SessionRewindInput,
  type SessionRewindResult,
} from "@brewva/brewva-vocabulary/session";
import {
  deriveAppliedPatchSetIds,
  ROLLBACK_EVENT_TYPE,
  ROLLBACK_STARTED_EVENT_TYPE,
  SOURCE_PATCH_APPLIED_EVENT_TYPE,
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

// The world store exists only while `worlds.enabled`; every world touchpoint in
// this engine flows through here so enable/disable stays one switch.
function worldStoreFor(ctx: HostedRuntimeOpsContext): WorkspaceWorldStore | undefined {
  const config = ctx.runtime.config.worlds;
  if (!config.enabled) {
    return undefined;
  }
  return createWorkspaceWorldStore({
    workspaceRoot: ctx.runtime.identity.workspaceRoot,
    dir: config.dir,
    retainPerSession: config.retainPerSession,
  });
}

// Honest availability of the world lane for one checkpoint event: parses the
// durable block the checkpoint recorded and checks the store still holds the
// world's manifest. This is deliberately the shallow check — the preview runs
// on the cockpit-sync hot path several times per turn, so per-blob
// verification stays with the restore preflight (deep `verifyWorld`), which is
// fail-closed anyway.
function projectWorldAvailability(
  store: WorkspaceWorldStore,
  checkpointPayload: Record<string, unknown> | undefined,
): WorldRewindAvailability {
  const block = parseWorldCheckpointBlock(checkpointPayload?.world);
  if (!block) {
    return { status: "not_captured" };
  }
  if (!block.ok) {
    return { status: "capture_failed" };
  }
  return store.hasWorld(block.worldId)
    ? { status: "available", worldId: block.worldId }
    : { status: "missing_artifacts", worldId: block.worldId };
}

// One find-by-checkpointId predicate for the executor and the preview, so the
// two can never target different checkpoint events for the same id.
function findCheckpointEvent(
  events: readonly ReturnType<HostedRuntimeOpsContext["listEvents"]>[number][],
  checkpointId: string,
) {
  return events.find(
    (event) =>
      event.type === SESSION_REWIND_CHECKPOINT_EVENT_TYPE &&
      (typeof event.payload?.checkpointId === "string" ? event.payload.checkpointId : event.id) ===
        checkpointId,
  );
}

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
  // Strip any caller-supplied `world` immediately: the key is engine-owned in
  // BOTH config states, so a forwarding caller can never smuggle a
  // well-formed block into the durable payload while the lane is disabled.
  const { world: _callerWorld, ...fields } = isRecord(input) ? input : {};
  let turn = 0;
  let seq = 0;
  for (const event of ctx.listEvents(sessionId)) {
    if (event.type === "turn.started") turn += 1;
    else if (event.type === SESSION_REWIND_CHECKPOINT_EVENT_TYPE) seq += 1;
  }
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
  // A world snapshot is captured BEFORE the checkpoint event is committed, so
  // a durable checkpoint can only ever reference a world that already exists
  // in the store (persist-before-reference). Capture failure is recorded on
  // the checkpoint rather than blocking it: the conversation checkpoint stays
  // usable and the narrowed workspace promise is durable and visible.
  const worldStore = worldStoreFor(ctx);
  const world = worldStore
    ? buildWorldCheckpointBlock(worldStore.capture({ sessionId, turn }))
    : undefined;
  // The workspace window a later rewind reverses is derived from tape order (the
  // patch sets applied after this checkpoint), so the checkpoint needs no
  // high-water snapshot — tape order, not a captured id, is authoritative.
  return ctx.emit(sessionId, SESSION_REWIND_CHECKPOINT_EVENT_TYPE, {
    ...fields,
    reasoningCheckpointId,
    turn,
    ...(world ? { world } : {}),
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
  events: readonly ReturnType<HostedRuntimeOpsContext["listEvents"]>[number][],
  checkpointEventId: string | undefined,
): string[] {
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

interface WorkspaceRestoreOutcome {
  readonly ok: boolean;
  readonly rollbackResults: readonly PatchRollbackResult[];
  readonly rolledPatchSetIds: readonly string[];
  readonly worldRestore?: SessionWorldRestoreRecord;
  readonly error?: string;
}

type RuntimeEvents = readonly ReturnType<HostedRuntimeOpsContext["listEvents"]>[number][];

// Split the checkpoint window by restore coverage: a patch set is superseded
// by the world restore only when EVERY path its applied receipts touched is
// governed by the restore scope. A patch that also wrote out-of-scope paths
// (gitignored files, excluded roots) keeps its applied status — its surviving
// mutations must stay reachable by the patch lane instead of being receipt-
// marked reverted while alive on disk.
function splitWindowByRestoreCoverage(
  events: RuntimeEvents,
  windowPatchSetIds: readonly string[],
  governedPaths: ReadonlySet<string>,
  workspaceRoot: string,
): { readonly covered: readonly string[]; readonly outOfScope: readonly string[] } {
  const window = new Set(windowPatchSetIds);
  const pathsById = new Map<string, string[]>();
  const seenById = new Set<string>();
  for (const event of events) {
    if (event.type !== SOURCE_PATCH_APPLIED_EVENT_TYPE) continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    if (payload.ok !== true || typeof payload.patchSetId !== "string") continue;
    if (!window.has(payload.patchSetId)) continue;
    seenById.add(payload.patchSetId);
    const paths = Array.isArray(payload.appliedPaths)
      ? payload.appliedPaths.filter((path): path is string => typeof path === "string")
      : undefined;
    if (paths === undefined) continue;
    const bucket = pathsById.get(payload.patchSetId) ?? [];
    bucket.push(...paths);
    pathsById.set(payload.patchSetId, bucket);
  }
  const normalizedRoot = `${workspaceRoot.replaceAll("\\", "/")}/`;
  const covered: string[] = [];
  const outOfScope: string[] = [];
  for (const patchSetId of windowPatchSetIds) {
    const rawPaths = pathsById.get(patchSetId);
    if (!seenById.has(patchSetId) || rawPaths === undefined) {
      // No applied-path evidence: conservatively keep it applied.
      outOfScope.push(patchSetId);
      continue;
    }
    const allGoverned = rawPaths.every((raw) => {
      const normalized = raw.replaceAll("\\", "/");
      const relative = normalized.startsWith(normalizedRoot)
        ? normalized.slice(normalizedRoot.length)
        : normalized;
      return !relative.startsWith("/") && governedPaths.has(relative);
    });
    (allGoverned ? covered : outOfScope).push(patchSetId);
  }
  return { covered, outOfScope };
}

// Workspace restore, world lane first: when the boundary checkpoint carries a
// world the store still holds, materialize it and mark the FULLY-COVERED
// window patch sets rolled back under the same receipt spelling the patch
// executor uses (`method: "world_restore"`), so every applied-patch projection
// stays coherent without new event types. A store-level restore guard spans
// the whole verify→pre-capture→materialize composite so no sweep (including
// the pre-capture's own trim-triggered maintenance) can collect the target
// world mid-flight. The patch lane remains the fallback for checkpoints with
// no usable world and for non-mutating world-lane preflight failures — each
// downgrade leaves a durable ok:false receipt; a mid-flight restore error
// fails closed with NO patch fallback — the workspace is visibly partial, the
// pre-restore world id is durable on the started receipt, and the restore is
// re-runnable.
function restoreWorkspaceToBoundary(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
  events: RuntimeEvents,
  checkpointPayload: Record<string, unknown> | undefined,
  windowPatchSetIds: readonly string[],
): WorkspaceRestoreOutcome {
  const store = worldStoreFor(ctx);
  // One "is the world lane available?" predicate, shared with the preview
  // (previewWorkspaceRewind), so the executor can never take a lane the preview
  // did not promise or vice versa.
  const availability = store ? projectWorldAvailability(store, checkpointPayload) : undefined;
  if (store && availability?.status === "available" && availability.worldId) {
    const worldId = availability.worldId;
    const releaseGuard = store.holdRestoreGuard(worldId);
    try {
      // Pre-restore capture: the current state becomes a world of its own
      // before being overwritten — a restore is a new edge, never a rewrite.
      const preCapture = store.capture({ sessionId });
      if (!preCapture.ok) {
        // Non-mutating downgrade; durable evidence, then the patch lane.
        ctx.emit(sessionId, ROLLBACK_EVENT_TYPE, {
          ok: false,
          method: "world_restore",
          worldId: worldId,
          reason: `precapture_${preCapture.reason}`,
          ...(preCapture.detail ? { detail: preCapture.detail } : {}),
        });
      } else if (preCapture.worldId === worldId) {
        // The workspace already IS the target world: nothing starts, nothing
        // mutates, no self-edge receipts — only the netted-out window patches
        // are marked superseded so the applied-set projection matches disk.
        const manifest = store.readManifest(worldId);
        const governedPaths = new Set(manifest?.files.map((entry) => entry.path) ?? []);
        const { covered } = splitWindowByRestoreCoverage(
          events,
          windowPatchSetIds,
          governedPaths,
          ctx.runtime.identity.workspaceRoot,
        );
        emitWorldSupersedeReceipts(ctx, sessionId, worldId, covered);
        return {
          ok: true,
          rollbackResults: [],
          rolledPatchSetIds: covered,
          worldRestore: {
            worldId: worldId,
            fromWorldId: preCapture.worldId,
            wroteFileCount: 0,
            deletedFileCount: 0,
            unchangedFileCount: manifest?.files.length ?? 0,
          },
        };
      } else {
        ctx.emit(sessionId, ROLLBACK_STARTED_EVENT_TYPE, {
          method: "world_restore",
          worldId: worldId,
          fromWorldId: preCapture.worldId,
          patchSetCount: windowPatchSetIds.length,
        });
        const restore = store.materialize(worldId);
        if (restore.ok) {
          const { covered, outOfScope } = splitWindowByRestoreCoverage(
            events,
            windowPatchSetIds,
            restore.governedPaths,
            ctx.runtime.identity.workspaceRoot,
          );
          emitWorldSupersedeReceipts(ctx, sessionId, worldId, covered);
          // World-level completion receipt: ok:true with NO patchSetId, so
          // the applied-patch fold skips it while tree-mutation folds (review
          // staleness) correctly observe that files changed — the empty-window
          // exec-damage restore would otherwise mutate the tree receipt-free.
          if (restore.wroteFileCount + restore.deletedFileCount > 0) {
            ctx.emit(sessionId, ROLLBACK_EVENT_TYPE, {
              ok: true,
              method: "world_restore",
              worldId: worldId,
              fromWorldId: preCapture.worldId,
              wroteFileCount: restore.wroteFileCount,
              deletedFileCount: restore.deletedFileCount,
              sparedFileCount: restore.sparedFileCount,
              supersededPatchSetIds: covered,
              ...(outOfScope.length > 0 ? { outOfScopePatchSetIds: outOfScope } : {}),
            });
          }
          return {
            ok: true,
            rollbackResults: [],
            rolledPatchSetIds: covered,
            worldRestore: {
              worldId: worldId,
              fromWorldId: preCapture.worldId,
              wroteFileCount: restore.wroteFileCount,
              deletedFileCount: restore.deletedFileCount,
              unchangedFileCount: restore.unchangedFileCount,
            },
          };
        }
        ctx.emit(sessionId, ROLLBACK_EVENT_TYPE, {
          ok: false,
          method: "world_restore",
          worldId: worldId,
          reason: restore.reason,
          ...(restore.detail ? { detail: restore.detail } : {}),
        });
        if (restore.reason === "restore_io_error") {
          return { ok: false, rollbackResults: [], rolledPatchSetIds: [], error: restore.reason };
        }
        // Preflight-class failures never mutated anything; fall through to
        // the patch lane, which brings its own fail-closed preflights.
      }
    } finally {
      releaseGuard();
    }
  }
  const rollback = rollbackWorkspaceToBoundary(ctx, sessionId, windowPatchSetIds);
  if (rollback.failure) {
    return {
      ok: false,
      rollbackResults: rollback.results,
      rolledPatchSetIds: rollback.patchSetIds,
      error: rollback.failure.reason,
    };
  }
  return { ok: true, rollbackResults: rollback.results, rolledPatchSetIds: rollback.patchSetIds };
}

// Mark superseded window patches rolled back with the patch executor's own
// receipt spelling, so deriveAppliedPatchSetIds and every downstream applied-
// patch projection stay coherent.
function emitWorldSupersedeReceipts(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
  worldId: string,
  patchSetIds: readonly string[],
): void {
  for (const patchSetId of patchSetIds) {
    ctx.emit(sessionId, ROLLBACK_EVENT_TYPE, {
      patchSetId,
      ok: true,
      method: "world_restore",
      worldId,
      restoredPaths: [],
      failedPaths: [],
    });
  }
}

// One rewind transaction owner. Conversation-only rewind is a compensation-free
// fork (re-anchor reasoning, no file mutation). Workspace (`code`/`both`) rewind
// restores the checkpoint's captured world when one is available (superseding
// the patch window under world_restore receipts) and otherwise rolls patch sets
// back through the receipt-bearing rollback capability; a failed or
// materially-incomplete restore stops with a visible result that blocks
// continuation rather than compensating silently. The reasoning re-anchor is
// emitted as a canonical `reasoning.revert` so the live session store and a
// cold hydration converge on the same conversation leaf, and the result carries
// the same `reasoningRevert` so the interactive shell switches the in-memory
// leaf immediately.
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

  const checkpointEvent = findCheckpointEvent(events, target.checkpointId);

  // One tape-ordered window drives both the workspace rollback and the
  // conversation-only divergence count, so the two can never disagree.
  const windowPatchSetIds = derivePatchWindowAfterCheckpoint(events, checkpointEvent?.id);

  let rollbackResults: readonly PatchRollbackResult[] = [];
  let rolledPatchSetIds: readonly string[] = [];
  let worldRestore: WorkspaceRestoreOutcome["worldRestore"];
  if (touchesWorkspace) {
    const outcome = restoreWorkspaceToBoundary(
      ctx,
      sessionId,
      events,
      isRecord(checkpointEvent?.payload) ? checkpointEvent.payload : undefined,
      windowPatchSetIds,
    );
    rollbackResults = outcome.rollbackResults;
    rolledPatchSetIds = outcome.rolledPatchSetIds;
    worldRestore = outcome.worldRestore;
    if (!outcome.ok) {
      return {
        ok: false,
        reason: "rollback_failed",
        trigger: "rewind",
        mode,
        summary,
        checkpoint: target,
        patchSetIds: rolledPatchSetIds,
        rollbackResults,
        ...(outcome.error ? { error: outcome.error } : {}),
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
  const worldTouchedFiles =
    (worldRestore?.wroteFileCount ?? 0) + (worldRestore?.deletedFileCount ?? 0);
  let divergenceNote: Extract<SessionRewindResult, { ok: true }>["divergenceNote"];
  if (
    touchesWorkspace &&
    !touchesConversation &&
    (rolledPatchSetIds.length > 0 || worldTouchedFiles > 0)
  ) {
    divergenceNote = {
      kind: "conversation_ahead",
      text: worldRestore
        ? `Workspace restored to the checkpoint world (${worldRestore.wroteFileCount} written, ${worldRestore.deletedFileCount} deleted, ${rolledPatchSetIds.length} patch set(s) superseded); conversation lineage left in place.`
        : `Workspace rolled back ${rolledPatchSetIds.length} patch set(s); conversation lineage left in place.`,
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
    ...(worldRestore ? { worldRestore } : {}),
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
    ...(worldRestore ? { worldRestore } : {}),
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
  const worldStore = worldStoreFor(ctx);
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
    // With the lane enabled, absence of a checkpoint still reports the world
    // lane explicitly, so `world`-field absence keeps meaning exactly
    // "worlds store disabled".
    return {
      ready: false,
      windowSize: 0,
      blockedReason: "no_checkpoint",
      ...(worldStore ? { world: { status: "not_captured" as const } } : {}),
    };
  }
  const checkpointEvent = findCheckpointEvent(events, target.checkpointId);
  const window = derivePatchWindowAfterCheckpoint(events, checkpointEvent?.id);
  const readiness = buildHostedPatchRollbackOps(ctx).previewWindowRollback(sessionId, window);
  const world = worldStore
    ? projectWorldAvailability(
        worldStore,
        isRecord(checkpointEvent?.payload) ? checkpointEvent.payload : undefined,
      )
    : undefined;
  // An available world makes the rewind ready even when patch material is
  // missing — the executor prefers the world lane and only falls back to
  // patches for non-mutating preflight failures.
  const worldReady = world?.status === "available";
  return {
    ready: worldReady || readiness.ready,
    windowSize: window.length,
    blockedReason: worldReady ? null : readiness.blockedReason,
    ...(world ? { world } : {}),
  };
}
