import {
  SESSION_CRASH_POINTS,
  SESSION_TERMINATION_REASONS,
  type BrewvaPromptSessionEvent,
  type SessionPhase,
  type ToolExecutionPhase,
} from "@brewva/brewva-substrate";
import {
  extractMessageError,
  readAssistantMessageEventPartial,
  readMessageRole,
  readMessageStopReason,
  readToolResultMessage,
} from "../../message-content.js";
import type { ShellCommitOptions } from "../shell-actions.js";
import type { CliShellAction } from "../state/index.js";
import {
  buildSeedTranscriptMessages,
  buildTextTranscriptMessage,
  buildTranscriptMessageFromMessage,
  upsertToolExecutionIntoTranscriptMessages,
  type CliShellTranscriptMessage,
  type CliShellTranscriptToolStatus,
} from "../transcript.js";
import {
  buildTrustLoopSessionProjection,
  buildTrustLoopToolProjection,
  isTrustLoopToolExecutionPhase,
  type TrustLoopToolProjection,
} from "../trust-loop/projection.js";
import type { CliShellUiPort } from "../types.js";

export interface ShellTranscriptProjectorContext {
  getMessages(): readonly CliShellTranscriptMessage[];
  getSessionId(): string;
  getTranscriptSeed(): unknown[];
  setMessages(messages: readonly CliShellTranscriptMessage[]): void;
  commit(action: CliShellAction, options?: ShellCommitOptions): void;
  getUi(): CliShellUiPort;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isSessionPhase(value: unknown): value is SessionPhase {
  const phase = asRecord(value);
  switch (phase?.kind) {
    case "idle":
      return true;
    case "model_streaming":
      return isString(phase.modelCallId) && isFiniteNumber(phase.turn);
    case "tool_executing":
      return isString(phase.toolCallId) && isString(phase.toolName) && isFiniteNumber(phase.turn);
    case "waiting_approval":
      return (
        isString(phase.requestId) &&
        isString(phase.toolCallId) &&
        isString(phase.toolName) &&
        isFiniteNumber(phase.turn)
      );
    case "recovering":
      return (
        isFiniteNumber(phase.turn) &&
        (phase.recoveryAnchor === undefined || isString(phase.recoveryAnchor))
      );
    case "crashed":
      return (
        isOneOf(phase.crashAt, SESSION_CRASH_POINTS) &&
        isFiniteNumber(phase.turn) &&
        (phase.modelCallId === undefined || isString(phase.modelCallId)) &&
        (phase.toolCallId === undefined || isString(phase.toolCallId)) &&
        (phase.recoveryAnchor === undefined || isString(phase.recoveryAnchor))
      );
    case "terminated":
      return isOneOf(phase.reason, SESSION_TERMINATION_REASONS);
    default:
      return false;
  }
}

function toolResultStatus(input: { result?: unknown; isError?: boolean }): "completed" | "error" {
  if (input.isError === true) {
    return "error";
  }
  const details = asRecord(asRecord(input.result)?.details);
  return details?.verdict === "fail" ? "error" : "completed";
}

export class ShellTranscriptProjector {
  #assistantEntryId: string | undefined;
  #correctionTranscriptMarkerSequence = 0;
  readonly #correctionTranscriptMarkersBySessionId = new Map<string, CliShellTranscriptMessage>();
  readonly #toolProjectionInputByCallId = new Map<string, ToolProjectionInputState>();
  readonly #toolTrustByCallId = new Map<string, TrustLoopToolProjection>();

  constructor(private readonly context: ShellTranscriptProjectorContext) {}

  resetAssistantDraft(): void {
    this.#assistantEntryId = undefined;
  }

  clearCorrectionMarker(sessionId: string): void {
    this.#correctionTranscriptMarkersBySessionId.delete(sessionId);
  }

  setCorrectionMarker(text: string): void {
    const sessionId = this.context.getSessionId();
    const message = buildTextTranscriptMessage({
      id: `correction:${sessionId}:${++this.#correctionTranscriptMarkerSequence}`,
      role: "custom",
      text,
    });
    if (!message) {
      return;
    }
    this.#correctionTranscriptMarkersBySessionId.set(sessionId, message);
  }

  buildMessagesFromSession(): CliShellTranscriptMessage[] {
    const messages = buildSeedTranscriptMessages(this.context.getTranscriptSeed());
    const correctionMarker = this.#correctionTranscriptMarkersBySessionId.get(
      this.context.getSessionId(),
    );
    return correctionMarker ? [...messages, correctionMarker] : messages;
  }

  refreshFromSession(): void {
    const messages = this.buildMessagesFromSession();
    this.rebuildToolTrustCache(messages);
    this.replaceMessages(messages);
  }

  appendMessage(message: CliShellTranscriptMessage | null): void {
    if (!message) {
      return;
    }
    this.replaceMessages([...this.context.getMessages(), message]);
  }

  handleSessionEvent(event: BrewvaPromptSessionEvent): void {
    if (event.type === "message_update") {
      const assistantPartialMessage =
        readMessageRole(event.message) === "assistant"
          ? event.message
          : readMessageRole(readAssistantMessageEventPartial(event.assistantMessageEvent)) ===
              "assistant"
            ? readAssistantMessageEventPartial(event.assistantMessageEvent)
            : undefined;
      if (assistantPartialMessage) {
        this.upsertAssistantMessage(assistantPartialMessage, "streaming");
        return;
      }

      const delta = asRecord(event.assistantMessageEvent)?.delta;
      if (typeof delta === "string" && delta.length > 0) {
        const id = this.#assistantEntryId ?? `assistant:${Date.now()}`;
        this.#assistantEntryId = id;
        this.upsertMessage(
          buildTextTranscriptMessage({
            id,
            role: "assistant",
            text: `${this.readText(this.findMessage(id))}${delta}`,
            renderMode: "streaming",
          }),
        );
      }
      return;
    }

    if (event.type === "message_end") {
      const role = readMessageRole(event.message);
      const errorMessage =
        role === "assistant" && readMessageStopReason(event.message) === "error"
          ? extractMessageError(event.message)
          : undefined;
      if (errorMessage) {
        this.context.getUi().notify(errorMessage, "error");
      }

      const toolResult = readToolResultMessage(event.message);
      if (toolResult) {
        this.upsertToolExecution({
          toolCallId: toolResult.toolCallId,
          toolName: toolResult.toolName,
          result: toolResult,
          status: toolResultStatus({ result: toolResult, isError: toolResult.isError }),
          renderMode: "stable",
          fallbackMessageId: `tool:result:${toolResult.toolCallId}`,
        });
        return;
      }

      if (role === "assistant") {
        if (asRecord(event.message)?.display === false) {
          if (this.#assistantEntryId) {
            this.removeMessage(this.#assistantEntryId);
          }
          this.#assistantEntryId = undefined;
          return;
        }
        if (this.#assistantEntryId) {
          this.upsertAssistantMessage(event.message, "stable");
          this.#assistantEntryId = undefined;
          return;
        }
        this.appendMessage(
          buildTranscriptMessageFromMessage(event.message, {
            id: `assistant:end:${Date.now()}`,
            renderMode: "stable",
          }),
        );
        this.#assistantEntryId = undefined;
        return;
      }

      if (role === "user") {
        this.#assistantEntryId = undefined;
        return;
      }

      this.appendMessage(
        buildTranscriptMessageFromMessage(event.message, {
          id: `${role ?? "message"}:end:${Date.now()}`,
          renderMode: "stable",
        }),
      );
      this.#assistantEntryId = undefined;
      return;
    }

    if (event.type === "tool_execution_start") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
      this.upsertToolExecution({
        toolCallId,
        toolName,
        args: event.args,
        status: "running",
        renderMode: "streaming",
      });
      return;
    }

    if (event.type === "tool_execution_update") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
      this.upsertToolExecution({
        toolCallId,
        toolName,
        args: event.args,
        partialResult: event.partialResult,
        status: "running",
        renderMode: "streaming",
      });
      return;
    }

    if (event.type === "tool_execution_end") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
      this.upsertToolExecution({
        toolCallId,
        toolName,
        result: event.result,
        status: toolResultStatus({ result: event.result, isError: event.isError === true }),
        renderMode: "stable",
        fallbackMessageId: toolCallId ? `tool:end:${toolCallId}` : undefined,
      });
      return;
    }

    if (event.type === "tool_execution_phase_change") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
      this.upsertToolExecution({
        toolCallId,
        toolName,
        args: event.args,
        phase: isTrustLoopToolExecutionPhase(event.phase) ? event.phase : undefined,
        status: event.phase === "cleanup" ? "completed" : "running",
        renderMode: "streaming",
      });
      return;
    }

    if (event.type === "session_phase_change") {
      const phase = asRecord(event.phase);
      this.context.commit({
        type: "status.set",
        key: "phase",
        text: typeof phase?.kind === "string" ? phase.kind : undefined,
      });
      if (isSessionPhase(event.phase)) {
        this.context.commit({
          type: "status.setTrust",
          trust: buildTrustLoopSessionProjection({
            phase: event.phase,
            activeTool: this.findToolTrustProjection(
              typeof phase?.toolCallId === "string" ? phase.toolCallId : undefined,
            ),
          }),
        });
      }
      return;
    }

    if (event.type === "context_state_change") {
      const contextState = asRecord(event.state);
      this.context.commit({
        type: "status.set",
        key: "pressure",
        text:
          typeof contextState?.budgetPressure === "string"
            ? contextState.budgetPressure
            : undefined,
      });
    }
  }

  private replaceMessages(messages: readonly CliShellTranscriptMessage[]): void {
    this.context.setMessages([...messages]);
  }

  private findMessage(id: string): CliShellTranscriptMessage | undefined {
    return this.context.getMessages().find((message) => message.id === id);
  }

  private removeMessage(id: string): void {
    const current = this.context.getMessages();
    const nextMessages = current.filter((message) => message.id !== id);
    if (nextMessages.length === current.length) {
      return;
    }
    this.replaceMessages(nextMessages);
  }

  private upsertMessage(message: CliShellTranscriptMessage | null): void {
    if (!message) {
      return;
    }
    const current = this.context.getMessages();
    const existingIndex = current.findIndex((candidate) => candidate.id === message.id);
    if (existingIndex < 0) {
      this.appendMessage(message);
      return;
    }
    this.replaceMessages([
      ...current.slice(0, existingIndex),
      message,
      ...current.slice(existingIndex + 1),
    ]);
  }

  private readText(message: CliShellTranscriptMessage | undefined): string {
    if (!message) {
      return "";
    }
    return message.parts
      .filter(
        (part): part is Extract<CliShellTranscriptMessage["parts"][number], { type: "text" }> =>
          part.type === "text",
      )
      .map((part) => part.text)
      .join("");
  }

  private upsertAssistantMessage(message: unknown, renderMode: "stable" | "streaming"): void {
    const id = this.#assistantEntryId ?? `assistant:${Date.now()}`;
    this.#assistantEntryId = id;
    const nextMessage = buildTranscriptMessageFromMessage(message, {
      id,
      renderMode,
      previousMessage: this.findMessage(id),
    });
    this.upsertMessage(nextMessage);
  }

  private upsertToolExecution(update: {
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
    phase?: ToolExecutionPhase;
    partialResult?: unknown;
    result?: unknown;
    status?: CliShellTranscriptToolStatus;
    renderMode?: "stable" | "streaming";
    fallbackMessageId?: string;
  }): void {
    const toolCallId = update.toolCallId;
    if (typeof toolCallId !== "string" || toolCallId.length === 0) {
      return;
    }
    this.updateToolTrustCache({ ...update, toolCallId });
    this.replaceMessages(
      upsertToolExecutionIntoTranscriptMessages(this.context.getMessages(), {
        toolCallId,
        toolName: update.toolName,
        args: update.args,
        phase: update.phase,
        partialResult: update.partialResult,
        result: update.result,
        status: update.status,
        renderMode: update.renderMode,
        fallbackMessageId: update.fallbackMessageId,
      }),
    );
  }

  private findToolTrustProjection(
    toolCallId: string | undefined,
  ): TrustLoopToolProjection | undefined {
    return toolCallId ? this.#toolTrustByCallId.get(toolCallId) : undefined;
  }

  private updateToolTrustCache(update: {
    toolCallId: string;
    toolName?: string;
    args?: unknown;
    phase?: ToolExecutionPhase;
    status?: CliShellTranscriptToolStatus;
  }): void {
    const previous = this.#toolProjectionInputByCallId.get(update.toolCallId);
    const toolName = update.toolName ?? previous?.toolName;
    if (!toolName) {
      return;
    }
    const next: ToolProjectionInputState = {
      toolName,
      args: update.args ?? previous?.args,
      executionPhase: update.phase ?? previous?.executionPhase,
      status: update.status ?? previous?.status,
    };
    this.#toolProjectionInputByCallId.set(update.toolCallId, next);
    this.#toolTrustByCallId.set(update.toolCallId, buildTrustLoopToolProjection(next));
  }

  private rebuildToolTrustCache(messages: readonly CliShellTranscriptMessage[]): void {
    this.#toolProjectionInputByCallId.clear();
    this.#toolTrustByCallId.clear();
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type !== "tool") {
          continue;
        }
        this.#toolProjectionInputByCallId.set(part.toolCallId, {
          toolName: part.toolName,
          args: part.args,
          executionPhase: part.phase,
          status: part.status,
        });
        this.#toolTrustByCallId.set(part.toolCallId, part.trust);
      }
    }
  }
}

interface ToolProjectionInputState {
  toolName: string;
  args?: unknown;
  executionPhase?: ToolExecutionPhase;
  status?: CliShellTranscriptToolStatus;
}
