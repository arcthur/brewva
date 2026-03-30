import { randomUUID } from "node:crypto";
import type {
  BrewvaEventRecord,
  PatchSet,
  ToolMutationReceipt,
  ToolMutationRollbackKind,
  ToolMutationStrategy,
} from "../contracts/index.js";
import {
  REVERSIBLE_MUTATION_PREPARED_EVENT_TYPE,
  REVERSIBLE_MUTATION_RECORDED_EVENT_TYPE,
  REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE,
} from "../events/event-types.js";
import type { ResolvedToolAuthority } from "../governance/tool-governance.js";
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
  resolveToolAuthority: (toolName: string) => ResolvedToolAuthority;
}

function resolveMutationStrategy(authority: ResolvedToolAuthority): {
  strategy: ToolMutationStrategy;
  rollbackKind: ToolMutationRollbackKind;
} | null {
  if (!authority.rollbackable) {
    return null;
  }
  if (authority.descriptor?.effects.includes("workspace_write")) {
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
  authority: ResolvedToolAuthority;
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
    effects: [...(input.authority.descriptor?.effects ?? [])],
    turn: input.turn,
    timestamp: input.timestamp,
  };
}

function readObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readMutationReceipt(value: unknown): ToolMutationReceipt | null {
  const receipt = readObjectRecord(value);
  if (!receipt) {
    return null;
  }
  if (typeof receipt.id !== "string" || !receipt.id.trim()) {
    return null;
  }
  if (typeof receipt.toolCallId !== "string") {
    return null;
  }
  const toolName = typeof receipt.toolName === "string" ? normalizeToolName(receipt.toolName) : "";
  if (!toolName) {
    return null;
  }
  if (receipt.boundary !== "effectful") {
    return null;
  }
  if (receipt.strategy !== "workspace_patchset") {
    return null;
  }
  if (receipt.rollbackKind !== "patchset") {
    return null;
  }
  if (
    typeof receipt.turn !== "number" ||
    !Number.isFinite(receipt.turn) ||
    typeof receipt.timestamp !== "number" ||
    !Number.isFinite(receipt.timestamp)
  ) {
    return null;
  }
  const effects = Array.isArray(receipt.effects)
    ? receipt.effects.filter(
        (effect): effect is ToolMutationReceipt["effects"][number] => typeof effect === "string",
      )
    : [];
  return {
    id: receipt.id.trim(),
    toolCallId: receipt.toolCallId.trim(),
    toolName,
    boundary: "effectful",
    strategy: "workspace_patchset",
    rollbackKind: "patchset",
    effects,
    turn: Math.floor(receipt.turn),
    timestamp: Math.max(0, Math.floor(receipt.timestamp)),
  };
}

export class ReversibleMutationService {
  private readonly getCurrentTurn: (sessionId: string) => number;
  private readonly recordEvent: RuntimeKernelContext["recordEvent"];
  private readonly resolveToolAuthority: (toolName: string) => ResolvedToolAuthority;
  private readonly pendingBySession = new Map<string, Map<string, PendingReversibleMutation>>();
  private readonly recordedBySession = new Map<string, RecordedReversibleMutation[]>();
  private readonly rolledBackReceiptIdsBySession = new Map<string, Set<string>>();

  constructor(options: ReversibleMutationServiceOptions) {
    this.getCurrentTurn = (sessionId) => options.getCurrentTurn(sessionId);
    this.recordEvent = (input) => options.recordEvent(input);
    this.resolveToolAuthority = (toolName) => options.resolveToolAuthority(toolName);
  }

  prepare(input: PrepareReversibleMutationInput): ToolMutationReceipt | undefined {
    const authority = this.resolveToolAuthority(input.toolName);
    const resolved = resolveMutationStrategy(authority);
    if (!resolved) {
      return undefined;
    }
    const turn = this.getCurrentTurn(input.sessionId);
    const timestamp = Date.now();
    const receipt = buildReceipt({
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      authority,
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

  restoreFromEvents(sessionId: string, events: BrewvaEventRecord[]): void {
    this.pendingBySession.delete(sessionId);
    this.recordedBySession.delete(sessionId);
    this.rolledBackReceiptIdsBySession.delete(sessionId);

    const recorded: RecordedReversibleMutation[] = [];
    const rolledBack = new Set<string>();
    for (const event of events) {
      const payload = readObjectRecord(event.payload);
      if (event.type === REVERSIBLE_MUTATION_RECORDED_EVENT_TYPE) {
        const receipt = readMutationReceipt(payload?.receipt);
        if (!receipt) {
          continue;
        }
        const patchSetId =
          typeof payload?.patchSetId === "string" && payload.patchSetId.trim()
            ? payload.patchSetId.trim()
            : null;
        const rollbackRef =
          typeof payload?.rollbackRef === "string" && payload.rollbackRef.trim()
            ? payload.rollbackRef.trim()
            : null;
        recorded.push({
          receipt,
          changed: payload?.changed === true,
          patchSetId,
          rollbackRef,
        });
        continue;
      }

      if (event.type === REVERSIBLE_MUTATION_ROLLED_BACK_EVENT_TYPE) {
        const receiptId =
          typeof payload?.receiptId === "string" && payload.receiptId.trim()
            ? payload.receiptId.trim()
            : null;
        if (receiptId) {
          rolledBack.add(receiptId);
        }
      }
    }

    if (recorded.length > 0) {
      this.recordedBySession.set(
        sessionId,
        recorded.map((entry) => structuredClone(entry)),
      );
    }
    if (rolledBack.size > 0) {
      this.rolledBackReceiptIdsBySession.set(sessionId, new Set(rolledBack));
    }
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
