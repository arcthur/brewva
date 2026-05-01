import { asBrewvaSessionId } from "../../core/identifiers.js";
import {
  SESSION_REWIND_CHECKPOINT_RECORDED_EVENT_TYPE,
  SESSION_REWIND_COMPLETED_EVENT_TYPE,
  SESSION_REWIND_REDO_COMPLETED_EVENT_TYPE,
  SESSION_REWIND_SUPERSEDED_EVENT_TYPE,
} from "../../events/registry.js";
import type { BrewvaEventStore } from "../../events/store.js";
import type { BrewvaEventRecord } from "../../events/types.js";
import type { ResolvedToolAuthority } from "../governance/api.js";
import type { FileChangeService } from "../patching/api.js";
import type { RedoResult, RollbackResult } from "../patching/api.js";
import {
  buildSessionRewindCheckpointId,
  buildSessionRewindProjection,
  buildSessionRewindState,
  cloneSessionRewindPromptSnapshot,
  collectSessionRewindAbandonedCheckpointIds,
  collectSessionRewindActiveCheckpointEventIds,
  isSessionRewindCheckpointSelectable,
  listSessionRewindPatchSetIdsAfterCheckpoint,
  listSessionRewindTargets,
  type SessionRewindProjection,
} from "../projection/api.js";
import type { ReasoningService } from "../reasoning/api.js";
import { REASONING_CONTINUITY_SCHEMA } from "../reasoning/types.js";
import type {
  RecordSessionRewindCheckpointInput,
  SessionRedoFailureReason,
  SessionRedoInput,
  SessionRedoResult,
  SessionRewindCheckpointRecord,
  SessionRewindDivergenceNote,
  SessionRewindFailureReason,
  SessionRewindInput,
  SessionRewindMode,
  SessionRewindRecord,
  SessionRewindResult,
  SessionRewindState,
  SessionRewindSummary,
  SessionRewindTargetView,
  SessionRewindTrigger,
} from "./types.js";
import {
  SESSION_REDO_SCHEMA,
  SESSION_REWIND_CHECKPOINT_SCHEMA,
  SESSION_REWIND_SCHEMA,
  SESSION_SUPERSEDE_SCHEMA,
} from "./types.js";

export interface SessionRewindServiceOptions {
  eventStore: BrewvaEventStore;
  reasoningService: Pick<
    ReasoningService,
    "recordCheckpoint" | "revert" | "canRevertTo" | "getActiveState"
  >;
  fileChangeService: Pick<FileChangeService, "rollbackPatchSet" | "redoPatchSet">;
  getCurrentTurn(sessionId: string): number;
  recordEvent(input: {
    sessionId: string;
    type: string;
    turn?: number;
    payload?: object;
    timestamp?: number;
    skipTapeCheckpoint?: boolean;
  }): BrewvaEventRecord | undefined;
  getSessionLifecycleSnapshot?(sessionId: string): {
    execution: {
      kind: string;
    };
  };
  resolveToolAuthority?: (
    toolName: string,
    args?: Record<string, unknown>,
  ) => ResolvedToolAuthority;
}

interface CachedRewindTargetProjection {
  cacheKey: string;
  targets: readonly SessionRewindTargetView[];
}

function normalizeTurn(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeRollbackMutationReceiptId(result: RollbackResult): string | undefined {
  return typeof result.mutationReceiptId === "string" && result.mutationReceiptId.trim().length > 0
    ? result.mutationReceiptId.trim()
    : undefined;
}

function buildCarryContinuity(
  checkpoint: SessionRewindCheckpointRecord,
  summaryHint: string | undefined,
): string {
  const normalizedHint = summaryHint?.trim();
  if (normalizedHint) {
    return normalizedHint;
  }
  const prompt = checkpoint.prompt?.text.trim();
  return prompt
    ? `Operator session undo restored the session before this prompt: ${prompt.slice(0, 900)}`
    : "Operator session undo restored the session to the selected checkpoint.";
}

function buildCleanForkContinuity(input: {
  checkpoint: SessionRewindCheckpointRecord;
  mode: SessionRewindMode;
  summaryHint?: string;
}): string {
  const normalizedHint = input.summaryHint?.trim();
  if (normalizedHint) {
    return normalizedHint;
  }
  const prompt = input.checkpoint.prompt?.text.trim();
  const promptFragment = prompt
    ? `Resume from the checkpoint before this prompt: ${prompt.slice(0, 240)}.`
    : "Resume from the selected checkpoint.";
  return `${promptFragment} Treat the abandoned branch as discarded unless the operator explicitly reintroduces it. Rewind mode: ${input.mode}.`;
}

function buildWorkspaceDivergenceNote(input: {
  checkpoint: SessionRewindCheckpointRecord;
  patchSetIds: readonly string[];
}): SessionRewindDivergenceNote {
  return {
    kind: "workspace_ahead",
    text: `Workspace divergence: ${input.patchSetIds.length} receipt-tracked patch set(s) remain applied after the conversation fork from turn ${input.checkpoint.turn}. Assume the workspace is ahead of the conversation until the operator reconciles it.`,
    patchSetCount: input.patchSetIds.length,
    parentLeafEntryId: input.checkpoint.leafEntryId,
  };
}

function buildConversationDivergenceNote(input: {
  checkpoint: SessionRewindCheckpointRecord;
  patchSetIds: readonly string[];
  returnLeafEntryId: string | null;
}): SessionRewindDivergenceNote {
  return {
    kind: "conversation_ahead",
    text: `Conversation divergence: ${input.patchSetIds.length} receipt-tracked patch set(s) were rewound after turn ${input.checkpoint.turn}, but the conversation branch stayed in place. Assume the workspace is behind the conversation until the operator replays or revises the branch.`,
    patchSetCount: input.patchSetIds.length,
    parentLeafEntryId: input.returnLeafEntryId,
  };
}

export class SessionRewindService {
  private readonly eventStore: BrewvaEventStore;
  private readonly reasoningService: SessionRewindServiceOptions["reasoningService"];
  private readonly fileChangeService: SessionRewindServiceOptions["fileChangeService"];
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly recordEvent: SessionRewindServiceOptions["recordEvent"];
  private readonly getSessionLifecycleSnapshot?: SessionRewindServiceOptions["getSessionLifecycleSnapshot"];
  private readonly resolveToolAuthority?: SessionRewindServiceOptions["resolveToolAuthority"];
  // In-process advisory guard; cross-process session serialization belongs to the host.
  private readonly activeMutations = new Set<string>();
  private readonly rewindTargetProjectionCache = new Map<string, CachedRewindTargetProjection>();

  constructor(options: SessionRewindServiceOptions) {
    this.eventStore = options.eventStore;
    this.reasoningService = options.reasoningService;
    this.fileChangeService = options.fileChangeService;
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.recordEvent = (input) => options.recordEvent(input);
    this.getSessionLifecycleSnapshot = options.getSessionLifecycleSnapshot
      ? (sessionId) => options.getSessionLifecycleSnapshot!(sessionId)
      : undefined;
    this.resolveToolAuthority = options.resolveToolAuthority
      ? (toolName, args) => options.resolveToolAuthority!(toolName, args)
      : undefined;
  }

  recordCheckpoint(
    sessionId: string,
    input: RecordSessionRewindCheckpointInput = {},
  ): SessionRewindCheckpointRecord {
    if (this.activeMutations.has(sessionId)) {
      throw new Error("cannot record session rewind checkpoint while a rewind mutation is active");
    }
    const projection = this.buildProjection(sessionId);
    const supersededCheckpointIds = projection.redoStack.map((entry) => entry.checkpointId);
    if (supersededCheckpointIds.length > 0) {
      const superseded = this.recordEvent({
        sessionId,
        type: SESSION_REWIND_SUPERSEDED_EVENT_TYPE,
        turn: this.getCurrentTurn(sessionId),
        payload: {
          schema: SESSION_SUPERSEDE_SCHEMA,
          checkpointIds: supersededCheckpointIds,
        },
      });
      if (!superseded) {
        throw new Error(
          `failed to supersede session rewind checkpoint(s) ${supersededCheckpointIds.join(",")}`,
        );
      }
    }

    const reasoningCheckpoint = this.reasoningService.recordCheckpoint(sessionId, {
      boundary: "operator_marker",
      leafEntryId: input.leafEntryId ?? null,
    });
    const sequence = projection.checkpoints.length + 1;
    const checkpointId = buildSessionRewindCheckpointId(sequence);
    const turn = this.getCurrentTurn(sessionId);
    const turnId = input.turnId?.trim() || `rewind-turn-${turn}-${sequence}`;
    const prompt = cloneSessionRewindPromptSnapshot(input.prompt);
    const recorded = this.recordEvent({
      sessionId,
      type: SESSION_REWIND_CHECKPOINT_RECORDED_EVENT_TYPE,
      turn,
      payload: {
        schema: SESSION_REWIND_CHECKPOINT_SCHEMA,
        checkpointId,
        turnId,
        reasoningCheckpointId: reasoningCheckpoint.checkpointId,
        leafEntryId: reasoningCheckpoint.leafEntryId,
        prompt: prompt ?? null,
      },
    });
    if (!recorded) {
      throw new Error(`failed to record session rewind checkpoint ${checkpointId}`);
    }
    return {
      checkpointId,
      sessionId: asBrewvaSessionId(sessionId),
      turnId,
      reasoningCheckpointId: reasoningCheckpoint.checkpointId,
      leafEntryId: reasoningCheckpoint.leafEntryId,
      ...(prompt ? { prompt } : {}),
      turn: normalizeTurn(recorded.turn),
      eventId: recorded.id,
      timestamp: recorded.timestamp,
      status: "active",
    };
  }

  rewind(sessionId: string, input: SessionRewindInput = {}): SessionRewindResult {
    const trigger: SessionRewindTrigger = input.checkpointId ? "rewind" : "undo";
    const mode = input.mode ?? "both";
    const summary = input.summary ?? (trigger === "undo" ? "carry" : "none");
    const policyDenial = this.authorizeRewindMode(mode);
    if (policyDenial) {
      return {
        ok: false,
        reason: "policy_denied",
        error: policyDenial,
        trigger,
        mode,
        summary,
      };
    }
    if (this.isSessionStreaming(sessionId)) {
      return { ok: false, reason: "streaming", trigger, mode, summary };
    }
    if (this.activeMutations.has(sessionId)) {
      return { ok: false, reason: "conflict", trigger, mode, summary };
    }
    this.activeMutations.add(sessionId);
    try {
      return this.applyRewind(sessionId, { input, trigger, mode, summary });
    } finally {
      this.activeMutations.delete(sessionId);
    }
  }

  private applyRewind(
    sessionId: string,
    args: {
      input: SessionRewindInput;
      trigger: SessionRewindTrigger;
      mode: SessionRewindMode;
      summary: SessionRewindSummary;
    },
  ): SessionRewindResult {
    const { input, trigger, mode, summary } = args;
    const projection = this.buildProjection(sessionId);
    const state = buildSessionRewindState(projection);
    const target = this.resolveRewindCheckpoint(sessionId, state, input.checkpointId);
    if (!target) {
      return {
        ok: false,
        reason: state.checkpoints.length === 0 ? "no_checkpoint" : "checkpoint_not_rewindable",
        trigger,
        mode,
        summary,
      };
    }

    const activeReasoningCheckpointIds = projection.activeReasoningCheckpointIds;
    const abandonedCheckpointIds = collectSessionRewindAbandonedCheckpointIds(
      state.checkpoints,
      activeReasoningCheckpointIds,
      target.reasoningCheckpointId,
    );
    const activeCheckpointEventIds = collectSessionRewindActiveCheckpointEventIds(
      state.checkpoints,
      new Set(activeReasoningCheckpointIds),
    );
    const ignoredPatchSetIds = new Set(projection.redoStack.flatMap((entry) => entry.patchSetIds));
    const patchSetIds = listSessionRewindPatchSetIdsAfterCheckpoint(target, {
      activeCheckpointEventIds,
      ignoredPatchSetIds,
      onlyCurrentlyApplied: true,
      patchProjection: projection.patchProjection,
    });
    const rollbackResults: RollbackResult[] = [];
    const rolledBackPatchSetIds: string[] = [];
    if (mode !== "conversation") {
      for (const patchSetId of patchSetIds.toReversed()) {
        const rollback = this.fileChangeService.rollbackPatchSet(sessionId, patchSetId);
        rollbackResults.push(rollback);
        if (!rollback.ok) {
          const compensationRedoResults = this.compensateRolledBackPatchSets(
            sessionId,
            rolledBackPatchSetIds,
          );
          this.recordRewindFailure(sessionId, target, patchSetIds, rollbackResults, {
            trigger,
            mode,
            summary,
            reason: "rollback_failed",
            error: rollback.reason,
            compensationRedoResults,
          });
          return {
            ok: false,
            reason: "rollback_failed",
            checkpoint: target,
            patchSetIds,
            rollbackResults,
            compensationRedoResults,
            error: rollback.reason,
            trigger,
            mode,
            summary,
          };
        }
        rolledBackPatchSetIds.push(patchSetId);
      }
    }

    const returnLeafEntryId = input.returnLeafEntryId ?? null;
    let reasoningRevert: SessionRewindRecord["reasoningRevert"] | undefined;
    if (mode !== "code") {
      try {
        const continuityText =
          summary === "carry"
            ? buildCarryContinuity(target, input.summaryHint)
            : buildCleanForkContinuity({
                checkpoint: target,
                mode,
                summaryHint: input.summaryHint,
              });
        reasoningRevert = this.reasoningService.revert(sessionId, {
          toCheckpointId: target.reasoningCheckpointId,
          trigger: "operator_request",
          continuity: {
            schema: REASONING_CONTINUITY_SCHEMA,
            text: continuityText,
          },
          linkedRollbackReceiptIds: rollbackResults
            .map((result) => normalizeRollbackMutationReceiptId(result))
            .filter((value): value is string => typeof value === "string"),
        });
      } catch (error) {
        const message = normalizeError(error);
        const compensationRedoResults = this.compensateRolledBackPatchSets(
          sessionId,
          rolledBackPatchSetIds,
        );
        this.recordRewindFailure(sessionId, target, patchSetIds, rollbackResults, {
          trigger,
          mode,
          summary,
          reason: "reasoning_revert_failed",
          error: message,
          compensationRedoResults,
        });
        return {
          ok: false,
          reason: "reasoning_revert_failed",
          checkpoint: target,
          patchSetIds,
          rollbackResults,
          compensationRedoResults,
          error: message,
          trigger,
          mode,
          summary,
        };
      }
    }

    const divergenceNote =
      mode === "conversation"
        ? buildWorkspaceDivergenceNote({ checkpoint: target, patchSetIds })
        : mode === "code"
          ? buildConversationDivergenceNote({
              checkpoint: target,
              patchSetIds,
              returnLeafEntryId,
            })
          : undefined;
    const recorded = this.recordEvent({
      sessionId,
      type: SESSION_REWIND_COMPLETED_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      payload: {
        schema: SESSION_REWIND_SCHEMA,
        ok: true,
        checkpointId: target.checkpointId,
        trigger,
        mode,
        summary,
        reasoningRevertId: reasoningRevert?.revertId ?? null,
        reasoningRevertEventId: reasoningRevert?.eventId ?? null,
        divergenceNote: divergenceNote ?? null,
        abandonedCheckpointIds,
        patchSetIds,
        rollbackResults,
        returnLeafEntryId,
      },
    });
    if (!recorded) {
      throw new Error(`failed to record session rewind for ${target.checkpointId}`);
    }
    return {
      ok: true,
      checkpoint: {
        ...target,
        status: "undone",
        undoneAt: recorded.timestamp,
        patchSetIds,
        returnLeafEntryId,
      },
      ...(reasoningRevert ? { reasoningRevert } : {}),
      ...(divergenceNote ? { divergenceNote } : {}),
      abandonedCheckpointIds,
      patchSetIds,
      rollbackResults,
      restoredPrompt: cloneSessionRewindPromptSnapshot(target.prompt),
      returnLeafEntryId,
      trigger,
      mode,
      summary,
    };
  }

  redo(sessionId: string, input: SessionRedoInput = {}): SessionRedoResult {
    if (this.isSessionStreaming(sessionId)) {
      return { ok: false, reason: "streaming" };
    }
    if (this.activeMutations.has(sessionId)) {
      return { ok: false, reason: "conflict" };
    }
    this.activeMutations.add(sessionId);
    try {
      return this.applyRedo(sessionId, input);
    } finally {
      this.activeMutations.delete(sessionId);
    }
  }

  private applyRedo(sessionId: string, input: SessionRedoInput): SessionRedoResult {
    const state = this.buildProjection(sessionId);
    const target = this.resolveRedoEntry(state, input.checkpointId);
    if (!target) {
      return {
        ok: false,
        reason: input.checkpointId ? "checkpoint_not_redoable" : "no_redo",
      };
    }
    const policyDenial = this.authorizeRewindMode(target.mode);
    if (policyDenial) {
      this.recordRedoFailure(sessionId, target, [], {
        reason: "policy_denied",
        error: policyDenial,
      });
      return {
        ok: false,
        reason: "policy_denied",
        checkpoint: state.byId.get(target.checkpointId),
        patchSetIds: target.patchSetIds,
        redoResults: [],
        error: policyDenial,
      };
    }

    const redoResults: RedoResult[] = [];
    const redonePatchSetIds: string[] = [];
    if (target.mode !== "conversation") {
      for (const patchSetId of target.patchSetIds) {
        const redo = this.fileChangeService.redoPatchSet(sessionId, patchSetId);
        redoResults.push(redo);
        if (!redo.ok) {
          const compensationRollbackResults = this.compensateRedonePatchSets(
            sessionId,
            redonePatchSetIds,
          );
          this.recordRedoFailure(sessionId, target, redoResults, {
            reason: "redo_failed",
            error: redo.reason,
            compensationRollbackResults,
          });
          return {
            ok: false,
            reason: "redo_failed",
            checkpoint: state.byId.get(target.checkpointId),
            patchSetIds: target.patchSetIds,
            redoResults,
            compensationRollbackResults,
            error: redo.reason,
          };
        }
        redonePatchSetIds.push(patchSetId);
      }
    }

    const checkpoint = state.byId.get(target.checkpointId);
    const returnLeafEntryId = input.returnLeafEntryId ?? target.returnLeafEntryId;
    try {
      const reasoningCheckpoint =
        target.mode === "code"
          ? undefined
          : this.reasoningService.recordCheckpoint(sessionId, {
              boundary: "operator_marker",
              leafEntryId: returnLeafEntryId,
            });
      const recorded = this.recordEvent({
        sessionId,
        type: SESSION_REWIND_REDO_COMPLETED_EVENT_TYPE,
        turn: this.getCurrentTurn(sessionId),
        payload: {
          schema: SESSION_REDO_SCHEMA,
          ok: true,
          checkpointId: target.checkpointId,
          mode: target.mode,
          patchSetIds: target.patchSetIds,
          redoResults,
          returnLeafEntryId,
          reasoningCheckpointId: reasoningCheckpoint?.checkpointId ?? null,
          reasoningCheckpointEventId: reasoningCheckpoint?.eventId ?? null,
        },
      });
      if (!recorded) {
        throw new Error(`failed to record session rewind redo for ${target.checkpointId}`);
      }
      if (!checkpoint && !reasoningCheckpoint) {
        throw new Error(
          `session rewind redo for ${target.checkpointId} cannot synthesize checkpoint metadata without a reasoning checkpoint`,
        );
      }
      const resolvedCheckpoint =
        checkpoint ??
        ({
          checkpointId: target.checkpointId,
          sessionId: sessionId,
          turnId: target.checkpointId,
          reasoningCheckpointId: reasoningCheckpoint!.checkpointId,
          leafEntryId: returnLeafEntryId,
          turn: this.getCurrentTurn(sessionId),
          eventId: recorded.id,
          timestamp: recorded.timestamp,
          status: "redone",
          patchSetIds: target.patchSetIds,
          returnLeafEntryId,
        } satisfies SessionRewindCheckpointRecord);
      return {
        ok: true,
        checkpoint: checkpoint
          ? {
              ...resolvedCheckpoint,
              status: "redone",
              redoneAt: recorded.timestamp,
              patchSetIds: target.patchSetIds,
              returnLeafEntryId,
            }
          : resolvedCheckpoint,
        patchSetIds: target.patchSetIds,
        redoResults,
        restoredPrompt: cloneSessionRewindPromptSnapshot(checkpoint?.prompt),
        returnLeafEntryId,
        ...(reasoningCheckpoint ? { reasoningCheckpoint } : {}),
      };
    } catch (error) {
      const message = normalizeError(error);
      const compensationRollbackResults = this.compensateRedonePatchSets(
        sessionId,
        redonePatchSetIds,
      );
      this.recordRedoFailure(sessionId, target, redoResults, {
        reason: "reasoning_checkpoint_failed",
        error: message,
        compensationRollbackResults,
      });
      return {
        ok: false,
        reason: "reasoning_checkpoint_failed",
        checkpoint,
        patchSetIds: target.patchSetIds,
        redoResults,
        compensationRollbackResults,
        error: message,
      };
    }
  }

  getRewindState(sessionId: string): SessionRewindState {
    return buildSessionRewindState(this.buildProjection(sessionId));
  }

  listRewindTargets(sessionId: string): SessionRewindTargetView[] {
    return this.getRewindTargetProjection(sessionId).map((target) => ({
      checkpointId: target.checkpointId,
      turn: target.turn,
      timestamp: target.timestamp,
      promptPreview: target.promptPreview,
      patchSetCountAfter: target.patchSetCountAfter,
      fileSummary: {
        added: target.fileSummary.added,
        modified: target.fileSummary.modified,
        deleted: target.fileSummary.deleted,
      },
      lineage:
        target.lineage.kind === "abandoned"
          ? {
              kind: "abandoned",
              rewoundBy: target.lineage.rewoundBy,
              rewoundAt: target.lineage.rewoundAt,
            }
          : { kind: "active" },
    }));
  }

  private authorizeRewindMode(mode: SessionRewindMode): string | undefined {
    const authority = this.resolveToolAuthority?.("session_rewind", { mode });
    if (!authority) {
      return "session_rewind requires an exact action policy";
    }
    if (authority.source !== "exact" && authority.source !== "registry") {
      return `session_rewind requires an exact action policy; resolved=${authority.source}`;
    }
    if (!authority.descriptor) {
      return "session_rewind requires a governance descriptor";
    }
    if (authority.effectiveAdmission !== "allow") {
      return `session_rewind admission is ${authority.effectiveAdmission ?? "missing"}`;
    }
    const effects = new Set(authority.descriptor.effects);
    if (!effects.has("control_state_mutation")) {
      return "session_rewind requires session.write governance";
    }
    if (mode !== "conversation" && !effects.has("workspace_write")) {
      return "session_rewind code and both modes require workspace.write governance";
    }
    return undefined;
  }

  private isSessionStreaming(sessionId: string): boolean {
    const snapshot = this.getSessionLifecycleSnapshot?.(sessionId);
    if (!snapshot) {
      return false;
    }
    return snapshot.execution.kind !== "idle";
  }

  private resolveRewindCheckpoint(
    sessionId: string,
    state: SessionRewindState,
    checkpointId: string | undefined,
  ): SessionRewindCheckpointRecord | undefined {
    const normalized = checkpointId?.trim();
    if (!normalized) {
      return state.latestRewindable;
    }
    const checkpoint = state.checkpoints.find((entry) => entry.checkpointId === normalized);
    if (!checkpoint) {
      return undefined;
    }
    return isSessionRewindCheckpointSelectable(
      new Set(this.reasoningService.getActiveState(sessionId).activeLineageCheckpointIds),
      checkpoint,
    ) && this.reasoningService.canRevertTo(sessionId, checkpoint.reasoningCheckpointId)
      ? checkpoint
      : undefined;
  }

  private resolveRedoEntry(
    state: SessionRewindProjection,
    checkpointId: string | undefined,
  ): SessionRewindProjection["redoStack"][number] | undefined {
    const normalized = checkpointId?.trim();
    const latest = state.redoStack.at(-1);
    if (!normalized) {
      return latest;
    }
    if (!latest || latest.checkpointId !== normalized) {
      return undefined;
    }
    return latest;
  }

  private buildProjection(sessionId: string): SessionRewindProjection {
    const events = this.eventStore.list(sessionId);
    return buildSessionRewindProjection({
      sessionId,
      events,
      activeReasoningCheckpointIds:
        this.reasoningService.getActiveState(sessionId).activeLineageCheckpointIds,
    });
  }

  private getRewindTargetProjection(sessionId: string): readonly SessionRewindTargetView[] {
    const events = this.eventStore.list(sessionId);
    const activeReasoningCheckpointIds =
      this.reasoningService.getActiveState(sessionId).activeLineageCheckpointIds;
    const latestEventId = events.at(-1)?.id ?? "none";
    const cacheKey = [latestEventId, activeReasoningCheckpointIds.join(",")].join("::");
    const cached = this.rewindTargetProjectionCache.get(sessionId);
    if (cached?.cacheKey === cacheKey) {
      return cached.targets;
    }
    const projection = buildSessionRewindProjection({
      sessionId,
      events,
      activeReasoningCheckpointIds,
    });
    const targets = listSessionRewindTargets(projection);
    this.rewindTargetProjectionCache.set(sessionId, { cacheKey, targets });
    return targets;
  }

  private compensateRolledBackPatchSets(
    sessionId: string,
    rolledBackPatchSetIds: readonly string[],
  ): RedoResult[] {
    return rolledBackPatchSetIds
      .toReversed()
      .map((patchSetId) => this.fileChangeService.redoPatchSet(sessionId, patchSetId));
  }

  private compensateRedonePatchSets(
    sessionId: string,
    redonePatchSetIds: readonly string[],
  ): RollbackResult[] {
    return redonePatchSetIds
      .toReversed()
      .map((patchSetId) => this.fileChangeService.rollbackPatchSet(sessionId, patchSetId));
  }

  private recordRewindFailure(
    sessionId: string,
    checkpoint: SessionRewindCheckpointRecord,
    patchSetIds: string[],
    rollbackResults: RollbackResult[],
    input: {
      trigger: SessionRewindTrigger;
      mode: SessionRewindMode;
      summary: SessionRewindSummary;
      reason: SessionRewindFailureReason;
      error?: string;
      compensationRedoResults?: RedoResult[];
    },
  ): void {
    this.recordEvent({
      sessionId,
      type: SESSION_REWIND_COMPLETED_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      payload: {
        schema: SESSION_REWIND_SCHEMA,
        ok: false,
        checkpointId: checkpoint.checkpointId,
        trigger: input.trigger,
        mode: input.mode,
        summary: input.summary,
        patchSetIds,
        rollbackResults,
        compensationRedoResults: input.compensationRedoResults ?? [],
        reason: input.reason,
        error: input.error ?? null,
      },
    });
  }

  private recordRedoFailure(
    sessionId: string,
    target: SessionRewindProjection["redoStack"][number],
    redoResults: RedoResult[],
    input: {
      reason: SessionRedoFailureReason;
      error?: string;
      compensationRollbackResults?: RollbackResult[];
    },
  ): void {
    this.recordEvent({
      sessionId,
      type: SESSION_REWIND_REDO_COMPLETED_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      payload: {
        schema: SESSION_REDO_SCHEMA,
        ok: false,
        checkpointId: target.checkpointId,
        mode: target.mode,
        patchSetIds: target.patchSetIds,
        redoResults,
        compensationRollbackResults: input.compensationRollbackResults ?? [],
        reason: input.reason,
        error: input.error ?? null,
      },
    });
  }
}
