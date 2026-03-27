import { randomUUID } from "node:crypto";
import type {
  PatchSet,
  ToolGovernanceDescriptor,
  ToolMutationReceipt,
  ToolMutationRollbackKind,
  ToolMutationStrategy,
} from "../contracts/index.js";
import {
  REVERSIBLE_MUTATION_PREPARED_EVENT_TYPE,
  REVERSIBLE_MUTATION_RECORDED_EVENT_TYPE,
} from "../events/event-types.js";
import { toolGovernanceCreatesRollbackAnchor } from "../governance/tool-governance.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import { normalizeToolName } from "../utils/tool-name.js";

interface PendingReversibleMutation {
  receipt: ToolMutationReceipt;
}

export interface RecordedReversibleMutation {
  receipt: ToolMutationReceipt;
  changed: boolean;
  rollbackRef?: string | null;
  patchSetId?: string | null;
}

export interface PrepareReversibleMutationInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
}

export interface RecordReversibleMutationInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  channelSuccess: boolean;
  verdict?: "pass" | "fail" | "inconclusive";
  patchSet?: PatchSet;
  metadata?: Record<string, unknown>;
}

export interface ReversibleMutationServiceOptions {
  getCurrentTurn: RuntimeKernelContext["getCurrentTurn"];
  recordEvent: RuntimeKernelContext["recordEvent"];
  resolveToolGovernanceDescriptor: (toolName: string) => ToolGovernanceDescriptor | undefined;
}

function resolveMutationStrategy(descriptor: ToolGovernanceDescriptor | undefined): {
  strategy: ToolMutationStrategy;
  rollbackKind: ToolMutationRollbackKind;
} | null {
  if (!descriptor || !toolGovernanceCreatesRollbackAnchor(descriptor)) {
    return null;
  }
  if (descriptor.effects.includes("workspace_write")) {
    return {
      strategy: "workspace_patchset",
      rollbackKind: "patchset",
    };
  }
  return null;
}

function buildReceipt(input: {
  toolCallId: string;
  toolName: string;
  descriptor: ToolGovernanceDescriptor | undefined;
  strategy: ToolMutationStrategy;
  rollbackKind: ToolMutationRollbackKind;
  turn: number;
  timestamp: number;
}): ToolMutationReceipt {
  return {
    id: [
      "mutation",
      normalizeToolName(input.toolName),
      input.toolCallId.trim() || randomUUID(),
      String(input.timestamp),
    ].join(":"),
    toolCallId: input.toolCallId.trim(),
    toolName: normalizeToolName(input.toolName),
    boundary: "effectful",
    strategy: input.strategy,
    rollbackKind: input.rollbackKind,
    effects: [...(input.descriptor?.effects ?? [])],
    turn: input.turn,
    timestamp: input.timestamp,
  };
}

export class ReversibleMutationService {
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly recordEvent: RuntimeKernelContext["recordEvent"];
  private readonly resolveToolGovernanceDescriptor: (
    toolName: string,
  ) => ToolGovernanceDescriptor | undefined;
  private readonly pendingBySession = new Map<string, Map<string, PendingReversibleMutation>>();
  private readonly recordedBySession = new Map<string, RecordedReversibleMutation[]>();
  private readonly rolledBackReceiptIdsBySession = new Map<string, Set<string>>();

  constructor(options: ReversibleMutationServiceOptions) {
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.recordEvent = (input) => options.recordEvent(input);
    this.resolveToolGovernanceDescriptor = (toolName) =>
      options.resolveToolGovernanceDescriptor(toolName);
  }

  prepare(input: PrepareReversibleMutationInput): ToolMutationReceipt | undefined {
    const descriptor = this.resolveToolGovernanceDescriptor(input.toolName);
    const resolved = resolveMutationStrategy(descriptor);
    if (!resolved) {
      return undefined;
    }
    const turn = this.getCurrentTurn(input.sessionId);
    const timestamp = Date.now();
    const receipt = buildReceipt({
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      descriptor,
      strategy: resolved.strategy,
      rollbackKind: resolved.rollbackKind,
      turn,
      timestamp,
    });
    const pending: PendingReversibleMutation = {
      receipt,
    };
    this.getPendingSession(input.sessionId).set(input.toolCallId, pending);
    this.recordEvent({
      sessionId: input.sessionId,
      type: REVERSIBLE_MUTATION_PREPARED_EVENT_TYPE,
      turn,
      timestamp,
      payload: {
        receipt,
      },
    });
    return receipt;
  }

  record(input: RecordReversibleMutationInput): void {
    const pendingSession = this.pendingBySession.get(input.sessionId);
    const pending = pendingSession?.get(input.toolCallId);
    if (!pending) {
      return;
    }
    pendingSession?.delete(input.toolCallId);
    if (pendingSession && pendingSession.size === 0) {
      this.pendingBySession.delete(input.sessionId);
    }

    const basePayload: Record<string, unknown> = {
      receipt: pending.receipt,
      channelSuccess: input.channelSuccess,
      verdict: input.verdict ?? null,
      changed: false,
    };
    const recorded: RecordedReversibleMutation = {
      receipt: structuredClone(pending.receipt),
      changed: false,
    };

    if (pending.receipt.strategy === "workspace_patchset") {
      const patchSet = input.patchSet;
      basePayload.changed = Boolean(patchSet);
      basePayload.patchSetId = patchSet?.id ?? null;
      basePayload.rollbackRef = patchSet ? `patchset://${patchSet.id}` : null;
      recorded.changed = Boolean(patchSet);
      recorded.patchSetId = patchSet?.id ?? null;
      recorded.rollbackRef = patchSet ? `patchset://${patchSet.id}` : null;
      basePayload.patchChanges =
        patchSet?.changes.map((change) => ({
          path: change.path,
          action: change.action,
        })) ?? [];
    } else {
      basePayload.rollbackRef = null;
      recorded.rollbackRef = null;
    }

    const sessionHistory = this.recordedBySession.get(input.sessionId) ?? [];
    sessionHistory.push(recorded);
    this.recordedBySession.set(input.sessionId, sessionHistory);
    this.recordEvent({
      sessionId: input.sessionId,
      type: REVERSIBLE_MUTATION_RECORDED_EVENT_TYPE,
      turn: this.getCurrentTurn(input.sessionId),
      payload: basePayload,
    });
  }

  clear(sessionId: string): void {
    this.pendingBySession.delete(sessionId);
    this.recordedBySession.delete(sessionId);
    this.rolledBackReceiptIdsBySession.delete(sessionId);
  }

  getLatestRollbackCandidate(sessionId: string): RecordedReversibleMutation | undefined {
    const history = this.recordedBySession.get(sessionId);
    if (!history || history.length === 0) {
      return undefined;
    }
    const rolledBack = this.rolledBackReceiptIdsBySession.get(sessionId);
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const candidate = history[index];
      if (!candidate) {
        continue;
      }
      if (rolledBack?.has(candidate.receipt.id)) {
        continue;
      }
      if (!candidate.changed) {
        continue;
      }
      return structuredClone(candidate);
    }
    return undefined;
  }

  markRolledBack(sessionId: string, receiptId: string): void {
    const normalizedReceiptId = receiptId.trim();
    if (!normalizedReceiptId) {
      return;
    }
    const existing = this.rolledBackReceiptIdsBySession.get(sessionId) ?? new Set<string>();
    existing.add(normalizedReceiptId);
    this.rolledBackReceiptIdsBySession.set(sessionId, existing);
  }

  markWorkspacePatchSetRolledBack(sessionId: string, patchSetId: string): string | undefined {
    const normalizedPatchSetId = patchSetId.trim();
    if (!normalizedPatchSetId) {
      return undefined;
    }
    const history = this.recordedBySession.get(sessionId);
    if (!history || history.length === 0) {
      return undefined;
    }
    const rolledBack = this.rolledBackReceiptIdsBySession.get(sessionId) ?? new Set<string>();
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const candidate = history[index];
      if (!candidate) {
        continue;
      }
      if (candidate.receipt.strategy !== "workspace_patchset") {
        continue;
      }
      if (candidate.patchSetId !== normalizedPatchSetId) {
        continue;
      }
      if (rolledBack.has(candidate.receipt.id)) {
        return candidate.receipt.id;
      }
      rolledBack.add(candidate.receipt.id);
      this.rolledBackReceiptIdsBySession.set(sessionId, rolledBack);
      return candidate.receipt.id;
    }
    return undefined;
  }

  private getPendingSession(sessionId: string): Map<string, PendingReversibleMutation> {
    const existing = this.pendingBySession.get(sessionId);
    if (existing) {
      return existing;
    }
    const created = new Map<string, PendingReversibleMutation>();
    this.pendingBySession.set(sessionId, created);
    return created;
  }
}
