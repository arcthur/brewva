import type { BrewvaPromptSessionEvent } from "@brewva/brewva-substrate/session";
import type { ToolExecutionPhase } from "@brewva/brewva-substrate/tools";
import {
  extractMessageError,
  readAssistantMessageEventPartial,
  readMessageRole,
  readMessageStopReason,
  readToolResultMessage,
} from "../../io/message-content.js";
import type { ShellCommitOptions } from "../domain/actions.js";
import {
  buildOperatorSafetyShellSessionView,
  buildOperatorSafetyShellToolView,
  isOperatorSafetyShellToolExecutionPhase,
  type OperatorSafetyShellToolView,
} from "../domain/operator-safety/shell-view.js";
import { isSessionPhase } from "../domain/session-phase.js";
import type { CliShellAction } from "../domain/state.js";
import {
  buildSeedTranscriptMessages,
  buildTextTranscriptMessage,
  buildTranscriptMessageFromMessage,
  upsertToolExecutionIntoTranscriptMessages,
  type CliShellTranscriptMessage,
  type CliShellTranscriptToolStatus,
} from "../domain/transcript.js";
import type { CliShellUiPort } from "../ports/ui-port.js";

export interface ShellTranscriptProjectorContext {
  getMessages(): readonly CliShellTranscriptMessage[];
  getSessionId(): string;
  getTranscriptSeed(): unknown[];
  setMessages(messages: readonly CliShellTranscriptMessage[], options?: ShellCommitOptions): void;
  commit(action: CliShellAction, options?: ShellCommitOptions): void;
  getUi(): CliShellUiPort;
}

const STREAMING_TRANSCRIPT_COMMIT_OPTIONS: ShellCommitOptions = {
  debounceStatus: false,
  emitChange: false,
  refreshCompletions: false,
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
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
  #assistantEntrySequence = 0;
  #rewindTranscriptMarkerSequence = 0;
  readonly #rewindTranscriptMarkersBySessionId = new Map<string, CliShellTranscriptMessage>();
  readonly #toolProjectionInputByCallId = new Map<string, ToolProjectionInputState>();
  readonly #toolSafetyByCallId = new Map<string, OperatorSafetyShellToolView>();

  constructor(private readonly context: ShellTranscriptProjectorContext) {}

  resetAssistantDraft(): void {
    this.#assistantEntryId = undefined;
  }

  clearRewindMarker(sessionId: string): void {
    this.#rewindTranscriptMarkersBySessionId.delete(sessionId);
  }

  setRewindMarker(text: string): void {
    const sessionId = this.context.getSessionId();
    const message = buildTextTranscriptMessage({
      id: `rewind:${sessionId}:${++this.#rewindTranscriptMarkerSequence}`,
      role: "custom",
      text,
    });
    if (!message) {
      return;
    }
    this.#rewindTranscriptMarkersBySessionId.set(sessionId, message);
  }

  private buildMessagesFromSession(): CliShellTranscriptMessage[] {
    const messages = buildSeedTranscriptMessages(
      this.context.getTranscriptSeed(),
      this.context.getSessionId(),
    );
    const rewindMarker = this.#rewindTranscriptMarkersBySessionId.get(this.context.getSessionId());
    return rewindMarker ? [...messages, rewindMarker] : messages;
  }

  /**
   * Build seed transcript messages and rebuild derived projector caches (tool safety) in one pass.
   * Shared by the initial state composition (runtime.initializeState) and live re-seeding
   * (refreshFromSession) so cache hydration cannot drift from message hydration. Returns the
   * messages so callers can route them through the appropriate sink (action pipeline or
   * direct replaceMessages).
   */
  composeSeedTranscript(): CliShellTranscriptMessage[] {
    const messages = this.buildMessagesFromSession();
    this.rebuildToolSafetyCache(messages);
    return messages;
  }

  refreshFromSession(): void {
    this.replaceMessages(this.composeSeedTranscript());
  }

  appendMessage(message: CliShellTranscriptMessage | null, options?: ShellCommitOptions): void {
    if (!message) {
      return;
    }
    this.replaceMessages([...this.context.getMessages(), message], options);
  }

  handleSessionEvent(event: BrewvaPromptSessionEvent): boolean {
    if (event.type === "message_update") {
      const assistantPartialMessage =
        readMessageRole(event.message) === "assistant"
          ? event.message
          : readMessageRole(readAssistantMessageEventPartial(event.assistantMessageEvent)) ===
              "assistant"
            ? readAssistantMessageEventPartial(event.assistantMessageEvent)
            : undefined;
      if (assistantPartialMessage) {
        this.upsertAssistantMessage(
          assistantPartialMessage,
          "streaming",
          STREAMING_TRANSCRIPT_COMMIT_OPTIONS,
        );
        return true;
      }

      const delta = asRecord(event.assistantMessageEvent)?.delta;
      if (typeof delta === "string" && delta.length > 0) {
        const id = this.#assistantEntryId ?? this.nextAssistantEntryId("assistant");
        this.#assistantEntryId = id;
        this.upsertMessage(
          buildTextTranscriptMessage({
            id,
            role: "assistant",
            text: `${this.readText(this.findMessage(id))}${delta}`,
            renderMode: "streaming",
          }),
          STREAMING_TRANSCRIPT_COMMIT_OPTIONS,
        );
        return true;
      }
      return false;
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
        return true;
      }

      if (role === "assistant") {
        if (asRecord(event.message)?.display === false) {
          if (this.#assistantEntryId) {
            this.removeMessage(this.#assistantEntryId);
          }
          this.#assistantEntryId = undefined;
          return true;
        }
        if (this.#assistantEntryId) {
          this.upsertAssistantMessage(event.message, "stable");
          this.#assistantEntryId = undefined;
          return true;
        }
        this.appendMessage(
          buildTranscriptMessageFromMessage(event.message, {
            id: this.nextAssistantEntryId("assistant:end"),
            renderMode: "stable",
          }),
        );
        this.#assistantEntryId = undefined;
        return true;
      }

      if (role === "user") {
        this.#assistantEntryId = undefined;
        return false;
      }

      this.appendMessage(
        buildTranscriptMessageFromMessage(event.message, {
          id: `${role ?? "message"}:end:${Date.now()}`,
          renderMode: "stable",
        }),
      );
      this.#assistantEntryId = undefined;
      return true;
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
      return true;
    }

    if (event.type === "tool_execution_update") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
      this.upsertToolExecution(
        {
          toolCallId,
          toolName,
          args: event.args,
          partialResult: event.partialResult,
          status: "running",
          renderMode: "streaming",
        },
        STREAMING_TRANSCRIPT_COMMIT_OPTIONS,
      );
      return true;
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
      return true;
    }

    if (event.type === "tool_execution_phase_change") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
      this.upsertToolExecution({
        toolCallId,
        toolName,
        args: event.args,
        phase: isOperatorSafetyShellToolExecutionPhase(event.phase) ? event.phase : undefined,
        status: event.phase === "cleanup" ? "completed" : "running",
        renderMode: "streaming",
      });
      return true;
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
          type: "status.setSafety",
          safety: buildOperatorSafetyShellSessionView({
            phase: event.phase,
            activeTool: this.findToolSafetyProjection(
              typeof phase?.toolCallId === "string" ? phase.toolCallId : undefined,
            ),
          }),
        });
      }
      return false;
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
      return false;
    }
    return false;
  }

  private replaceMessages(
    messages: readonly CliShellTranscriptMessage[],
    options?: ShellCommitOptions,
  ): void {
    this.context.setMessages([...messages], options);
  }

  private findMessage(id: string): CliShellTranscriptMessage | undefined {
    return this.context.getMessages().find((message) => message.id === id);
  }

  private removeMessage(id: string, options?: ShellCommitOptions): void {
    const current = this.context.getMessages();
    const nextMessages = current.filter((message) => message.id !== id);
    if (nextMessages.length === current.length) {
      return;
    }
    this.replaceMessages(nextMessages, options);
  }

  private upsertMessage(
    message: CliShellTranscriptMessage | null,
    options?: ShellCommitOptions,
  ): void {
    if (!message) {
      return;
    }
    const current = this.context.getMessages();
    const existingIndex = current.findIndex((candidate) => candidate.id === message.id);
    if (existingIndex < 0) {
      this.appendMessage(message, options);
      return;
    }
    this.replaceMessages(
      [...current.slice(0, existingIndex), message, ...current.slice(existingIndex + 1)],
      options,
    );
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

  private nextAssistantEntryId(prefix: string): string {
    this.#assistantEntrySequence += 1;
    return `${prefix}:${this.context.getSessionId()}:${this.#assistantEntrySequence}`;
  }

  private upsertAssistantMessage(
    message: unknown,
    renderMode: "stable" | "streaming",
    options?: ShellCommitOptions,
  ): void {
    const id = this.#assistantEntryId ?? this.nextAssistantEntryId("assistant");
    this.#assistantEntryId = id;
    const nextMessage = buildTranscriptMessageFromMessage(message, {
      id,
      renderMode,
      previousMessage: this.findMessage(id),
    });
    this.upsertMessage(nextMessage, options);
  }

  private upsertToolExecution(
    update: {
      toolCallId?: string;
      toolName?: string;
      args?: unknown;
      phase?: ToolExecutionPhase;
      partialResult?: unknown;
      result?: unknown;
      status?: CliShellTranscriptToolStatus;
      renderMode?: "stable" | "streaming";
      fallbackMessageId?: string;
    },
    options?: ShellCommitOptions,
  ): void {
    const toolCallId = update.toolCallId;
    if (typeof toolCallId !== "string" || toolCallId.length === 0) {
      return;
    }
    this.updateToolSafetyCache({ ...update, toolCallId });
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
      options,
    );
  }

  private findToolSafetyProjection(
    toolCallId: string | undefined,
  ): OperatorSafetyShellToolView | undefined {
    return toolCallId ? this.#toolSafetyByCallId.get(toolCallId) : undefined;
  }

  private updateToolSafetyCache(update: {
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
    this.#toolSafetyByCallId.set(update.toolCallId, buildOperatorSafetyShellToolView(next));
  }

  private rebuildToolSafetyCache(messages: readonly CliShellTranscriptMessage[]): void {
    this.#toolProjectionInputByCallId.clear();
    this.#toolSafetyByCallId.clear();
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
        this.#toolSafetyByCallId.set(part.toolCallId, part.safety);
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
