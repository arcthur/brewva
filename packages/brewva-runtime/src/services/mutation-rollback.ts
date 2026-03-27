import type { ToolMutationRollbackResult } from "../contracts/index.js";
import { REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE } from "../events/event-types.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import type { FileChangeService } from "./file-change.js";
import type {
  RecordedReversibleMutation,
  ReversibleMutationService,
} from "./reversible-mutation.js";

export interface MutationRollbackServiceOptions {
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  recordEvent: RuntimeKernelContext["recordEvent"];
  reversibleMutationService: ReversibleMutationService;
  fileChangeService: Pick<FileChangeService, "rollbackPatchSet">;
}

function buildBaseResult(
  mutation: RecordedReversibleMutation,
  overrides: Partial<ToolMutationRollbackResult> = {},
): ToolMutationRollbackResult {
  return {
    ok: false,
    receiptId: mutation.receipt.id,
    patchSetId: mutation.patchSetId ?? undefined,
    toolName: mutation.receipt.toolName,
    strategy: mutation.receipt.strategy,
    rollbackKind: mutation.receipt.rollbackKind,
    restoredPaths: [],
    failedPaths: [],
    reason: "no_patchset",
    ...overrides,
  };
}

export class MutationRollbackService {
  private readonly getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  private readonly recordEvent: RuntimeKernelContext["recordEvent"];
  private readonly reversibleMutationService: ReversibleMutationService;
  private readonly rollbackPatchSet: (
    sessionId: string,
    patchSetId?: string,
  ) => ReturnType<FileChangeService["rollbackPatchSet"]>;

  constructor(options: MutationRollbackServiceOptions) {
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.recordEvent = (input) => options.recordEvent(input);
    this.reversibleMutationService = options.reversibleMutationService;
    this.rollbackPatchSet = (sessionId, patchSetId) =>
      options.fileChangeService.rollbackPatchSet(sessionId, patchSetId);
  }

  rollbackLast(sessionId: string): ToolMutationRollbackResult {
    const mutation = this.reversibleMutationService.getLatestRollbackCandidate(sessionId);
    if (!mutation) {
      return {
        ok: false,
        restoredPaths: [],
        failedPaths: [],
        reason: "no_mutation_receipt",
      };
    }

    let result: ToolMutationRollbackResult;
    if (!mutation.patchSetId) {
      result = buildBaseResult(mutation, {
        ok: false,
        restoredPaths: [],
        failedPaths: [],
        reason: "no_patchset",
      });
    } else {
      const rollback = this.rollbackPatchSet(sessionId, mutation.patchSetId);
      result = buildBaseResult(mutation, {
        ok: rollback.ok,
        patchSetId: mutation.patchSetId ?? undefined,
        restoredPaths: [...rollback.restoredPaths],
        failedPaths: [...rollback.failedPaths],
        reason: rollback.reason,
      });
    }

    if (result.ok) {
      this.reversibleMutationService.markRolledBack(sessionId, mutation.receipt.id);
    }

    this.recordEvent({
      sessionId,
      type: REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE,
      turn: this.getCurrentTurn(sessionId),
      payload: {
        receiptId: mutation.receipt.id,
        toolName: mutation.receipt.toolName,
        strategy: mutation.receipt.strategy,
        rollbackKind: mutation.receipt.rollbackKind,
        ok: result.ok,
        restoredPaths: [...result.restoredPaths],
        failedPaths: [...result.failedPaths],
        reason: result.reason ?? null,
      },
    });

    return result;
  }
}
