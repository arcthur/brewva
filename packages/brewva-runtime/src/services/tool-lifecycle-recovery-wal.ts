import type { RecoveryWalStore } from "../channels/recovery-wal.js";
import { buildTurnEnvelope } from "../channels/turn.js";
import {
  SESSION_SHUTDOWN_EVENT_TYPE,
  TOOL_EXECUTION_END_EVENT_TYPE,
  TOOL_EXECUTION_START_EVENT_TYPE,
} from "../events/event-types.js";
import type { EventPipelineService } from "./event-pipeline.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readToolCallPayload(payload: unknown): { toolCallId: string; toolName: string } | null {
  if (!isRecord(payload)) {
    return null;
  }
  const toolCallId = readNonEmptyString(payload.toolCallId);
  const toolName = readNonEmptyString(payload.toolName);
  if (!toolCallId || !toolName) {
    return null;
  }
  return {
    toolCallId,
    toolName,
  };
}

function buildToolLifecycleWalDedupeKey(sessionId: string, toolCallId: string): string {
  return `tool:${sessionId}:${toolCallId}`;
}

export interface ToolLifecycleRecoveryWalServiceOptions {
  recoveryWalStore: RecoveryWalStore;
  eventPipeline: Pick<EventPipelineService, "subscribeEvents">;
}

export class ToolLifecycleRecoveryWalService {
  private readonly walIdsBySession = new Map<string, Map<string, string>>();

  constructor(private readonly options: ToolLifecycleRecoveryWalServiceOptions) {
    options.eventPipeline.subscribeEvents((event) => {
      this.observeEvent(event);
    });
  }

  clearSession(sessionId: string): void {
    this.walIdsBySession.delete(sessionId);
  }

  private observeEvent(event: {
    sessionId: string;
    type: string;
    timestamp: number;
    turn?: number;
    payload?: unknown;
  }): void {
    if (event.type === TOOL_EXECUTION_START_EVENT_TYPE) {
      this.handleToolExecutionStart(event);
      return;
    }
    if (event.type === TOOL_EXECUTION_END_EVENT_TYPE) {
      this.handleToolExecutionEnd(event);
      return;
    }
    if (event.type === SESSION_SHUTDOWN_EVENT_TYPE) {
      this.clearSession(event.sessionId);
    }
  }

  private handleToolExecutionStart(event: {
    sessionId: string;
    timestamp: number;
    turn?: number;
    payload?: unknown;
  }): void {
    const payload = readToolCallPayload(event.payload);
    if (!payload) {
      return;
    }
    const envelope = buildTurnEnvelope({
      kind: "tool",
      sessionId: event.sessionId,
      turnId: `tool:${payload.toolCallId}`,
      channel: "tool_lifecycle",
      conversationId: event.sessionId,
      timestamp: event.timestamp,
      parts: [`${payload.toolName} (${payload.toolCallId})`],
      meta: {
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        ...(typeof event.turn === "number" && Number.isFinite(event.turn)
          ? { turn: Math.max(0, Math.floor(event.turn)) }
          : {}),
      },
    });
    const row = this.options.recoveryWalStore.appendPending(envelope, "tool", {
      dedupeKey: buildToolLifecycleWalDedupeKey(event.sessionId, payload.toolCallId),
    });
    this.options.recoveryWalStore.markInflight(row.walId);
    this.setWalId(event.sessionId, payload.toolCallId, row.walId);
  }

  private handleToolExecutionEnd(event: { sessionId: string; payload?: unknown }): void {
    const payload = readToolCallPayload(event.payload);
    if (!payload) {
      return;
    }
    const walId = this.resolveWalId(event.sessionId, payload.toolCallId);
    if (!walId) {
      return;
    }
    this.options.recoveryWalStore.markDone(walId);
    this.deleteWalId(event.sessionId, payload.toolCallId);
  }

  private resolveWalId(sessionId: string, toolCallId: string): string | undefined {
    const cached = this.walIdsBySession.get(sessionId)?.get(toolCallId);
    if (cached) {
      return cached;
    }
    const row = this.options.recoveryWalStore.listPending().find((candidate) => {
      if (candidate.source !== "tool" || candidate.sessionId !== sessionId) {
        return false;
      }
      const meta = isRecord(candidate.envelope.meta) ? candidate.envelope.meta : null;
      return readNonEmptyString(meta?.toolCallId) === toolCallId;
    });
    if (!row) {
      return undefined;
    }
    this.setWalId(sessionId, toolCallId, row.walId);
    return row.walId;
  }

  private setWalId(sessionId: string, toolCallId: string, walId: string): void {
    const existing = this.walIdsBySession.get(sessionId);
    if (existing) {
      existing.set(toolCallId, walId);
      return;
    }
    this.walIdsBySession.set(sessionId, new Map([[toolCallId, walId]]));
  }

  private deleteWalId(sessionId: string, toolCallId: string): void {
    const sessionWalIds = this.walIdsBySession.get(sessionId);
    if (!sessionWalIds) {
      return;
    }
    sessionWalIds.delete(toolCallId);
    if (sessionWalIds.size === 0) {
      this.walIdsBySession.delete(sessionId);
    }
  }
}
