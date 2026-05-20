import { MODEL_SELECT_EVENT_TYPE } from "@brewva/brewva-runtime/protocol";
import type {
  BrewvaAgentProtocolCustomMessage,
  BrewvaAgentProtocolEvent,
  BrewvaAgentProtocolMessage,
} from "@brewva/brewva-substrate/agent-protocol";
import type {
  BrewvaHostContext,
  BrewvaHostMessageVisibilityPatch,
  BrewvaHostPluginRunner,
} from "@brewva/brewva-substrate/host-api";
import {
  DEFAULT_CONTEXT_STATE,
  type BrewvaPromptSessionEvent,
  type ContextState,
  type SessionPhase,
} from "@brewva/brewva-substrate/session";

function applyMessageEndTransform(
  original: BrewvaAgentProtocolMessage,
  visibility: BrewvaHostMessageVisibilityPatch,
): BrewvaAgentProtocolMessage {
  return {
    ...original,
    ...(visibility.display !== undefined ? { display: visibility.display } : {}),
    ...(visibility.excludeFromContext !== undefined
      ? { excludeFromContext: visibility.excludeFromContext }
      : {}),
    ...(visibility.details !== undefined ? { details: visibility.details } : {}),
  };
}

function sameContextState(left: ContextState, right: ContextState): boolean {
  return (
    left.budgetPressure === right.budgetPressure &&
    left.promptStabilityFingerprint === right.promptStabilityFingerprint &&
    left.transientReductionActive === right.transientReductionActive &&
    left.historyBaselineAvailable === right.historyBaselineAvailable
  );
}

export interface ManagedSessionTurnEventState {
  turnIndex: number;
  turnStartTimestamp: number;
}

export interface ManagedSessionEventBridgeOptions {
  runner: BrewvaHostPluginRunner;
  createHostContext: () => BrewvaHostContext;
  emitToListeners: (event: BrewvaPromptSessionEvent) => void;
  appendMessage: (message: BrewvaAgentProtocolMessage) => void;
  appendCustomMessageEntry: (
    customType: string,
    content: string | Array<{ type: string } & Record<string, unknown>>,
    display: boolean,
    details?: unknown,
  ) => void;
  readContextState: () => ContextState | undefined;
  readTurnEventState: () => ManagedSessionTurnEventState;
  writeTurnEventState: (state: ManagedSessionTurnEventState) => void;
}

export class ManagedSessionEventBridge {
  readonly #runner: BrewvaHostPluginRunner;
  readonly #createHostContext: ManagedSessionEventBridgeOptions["createHostContext"];
  readonly #emitToListeners: ManagedSessionEventBridgeOptions["emitToListeners"];
  readonly #appendMessage: ManagedSessionEventBridgeOptions["appendMessage"];
  readonly #appendCustomMessageEntry: ManagedSessionEventBridgeOptions["appendCustomMessageEntry"];
  readonly #readContextState: ManagedSessionEventBridgeOptions["readContextState"];
  readonly #readTurnEventState: ManagedSessionEventBridgeOptions["readTurnEventState"];
  readonly #writeTurnEventState: ManagedSessionEventBridgeOptions["writeTurnEventState"];
  #contextState: ContextState = { ...DEFAULT_CONTEXT_STATE };

  constructor(options: ManagedSessionEventBridgeOptions) {
    this.#runner = options.runner;
    this.#createHostContext = options.createHostContext;
    this.#emitToListeners = options.emitToListeners;
    this.#appendMessage = options.appendMessage;
    this.#appendCustomMessageEntry = options.appendCustomMessageEntry;
    this.#readContextState = options.readContextState;
    this.#readTurnEventState = options.readTurnEventState;
    this.#writeTurnEventState = options.writeTurnEventState;
  }

  getContextState(): ContextState {
    return { ...this.#contextState };
  }

  async syncContextState(): Promise<void> {
    const next = this.#readContextState() ?? DEFAULT_CONTEXT_STATE;
    if (sameContextState(this.#contextState, next)) {
      return;
    }
    const previousState = this.#contextState;
    this.#contextState = { ...next };
    await this.#runner.emit(
      "context_state_change",
      {
        type: "context_state_change",
        state: this.getContextState(),
        previousState,
      },
      this.#createHostContext(),
    );
    this.#emitToListeners({
      type: "context_state_change",
      state: this.getContextState(),
      previousState,
    });
  }

  async emitSessionStart(): Promise<void> {
    await this.#runner.emit(
      "session_start",
      { type: "session_start", reason: "startup" },
      this.#createHostContext(),
    );
  }

  emitSessionShutdown(): void {
    void this.#runner.emit(
      "session_shutdown",
      { type: "session_shutdown" },
      this.#createHostContext(),
    );
  }

  async emitModelSelect(input: {
    model: { provider: string; id: string };
    previousModel?: { provider: string; id: string };
    source: "preset" | "set";
  }): Promise<void> {
    await this.#runner.emit(
      MODEL_SELECT_EVENT_TYPE,
      {
        type: MODEL_SELECT_EVENT_TYPE,
        model: input.model,
        previousModel: input.previousModel,
        source: input.source,
      },
      this.#createHostContext(),
    );
  }

  emitThinkingLevelSelect(input: {
    thinkingLevel: string;
    previousThinkingLevel: string;
    source: "set";
  }): void {
    void this.#runner
      .emit(
        "thinking_level_select",
        {
          type: "thinking_level_select",
          thinkingLevel: input.thinkingLevel,
          previousThinkingLevel: input.previousThinkingLevel,
          source: input.source,
        },
        this.#createHostContext(),
      )
      .catch(() => undefined);
  }

  async emitSessionPhaseChange(input: {
    phase: SessionPhase;
    previousPhase: SessionPhase;
  }): Promise<void> {
    await this.#runner.emit(
      "session_phase_change",
      {
        type: "session_phase_change",
        phase: input.phase,
        previousPhase: input.previousPhase,
      },
      this.#createHostContext(),
    );
    this.#emitToListeners({
      type: "session_phase_change",
      phase: input.phase,
      previousPhase: input.previousPhase,
    });
  }

  async emitTurnLoopEvent(event: BrewvaAgentProtocolEvent): Promise<BrewvaAgentProtocolEvent> {
    const ctx = this.#createHostContext();
    switch (event.type) {
      case "agent_start":
        await this.#runner.emit("agent_start", { type: "agent_start" }, ctx);
        return event;
      case "agent_end":
        await this.#runner.emit("agent_end", { type: "agent_end", messages: event.messages }, ctx);
        return event;
      case "turn_start": {
        const state = this.#readTurnEventState();
        const nextState = {
          turnIndex: state.turnIndex + 1,
          turnStartTimestamp: Date.now(),
        };
        this.#writeTurnEventState(nextState);
        await this.#runner.emit(
          "turn_start",
          {
            type: "turn_start",
            turnIndex: nextState.turnIndex,
            timestamp: nextState.turnStartTimestamp,
          },
          ctx,
        );
        return event;
      }
      case "turn_end": {
        const state = this.#readTurnEventState();
        await this.#runner.emit(
          "turn_end",
          {
            type: "turn_end",
            turnIndex: state.turnIndex,
            message: event.message,
            toolResults: event.toolResults,
          },
          ctx,
        );
        return event;
      }
      case "message_start":
        await this.#runner.emit(
          "message_start",
          { type: "message_start", message: event.message },
          ctx,
        );
        return event;
      case "message_update":
        await this.#runner.emit(
          "message_update",
          {
            type: "message_update",
            message: event.message,
            assistantMessageEvent: event.assistantMessageEvent,
          },
          ctx,
        );
        return event;
      case "message_end": {
        const result = await this.#runner.emitMessageEnd(
          { type: "message_end", message: event.message },
          ctx,
        );
        if (result?.visibility === undefined) {
          return event;
        }
        return {
          ...event,
          message: applyMessageEndTransform(event.message, result.visibility),
        };
      }
      case "tool_execution_start":
        await this.#runner.emit(
          "tool_execution_start",
          {
            type: "tool_execution_start",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          },
          ctx,
        );
        return event;
      case "tool_execution_update":
        await this.#runner.emit(
          "tool_execution_update",
          {
            type: "tool_execution_update",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            partialResult: event.partialResult,
          },
          ctx,
        );
        return event;
      case "tool_execution_end":
        await this.#runner.emit(
          "tool_execution_end",
          {
            type: "tool_execution_end",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: event.result,
            isError: event.isError,
          },
          ctx,
        );
        return event;
      case "tool_execution_phase_change":
        await this.#runner.emit(
          "tool_execution_phase_change",
          {
            type: "tool_execution_phase_change",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            phase: event.phase,
            previousPhase: event.previousPhase,
            args: event.args,
          },
          ctx,
        );
        return event;
      default:
        return event;
    }
  }

  async appendPassiveCustomMessage(
    customMessage: BrewvaAgentProtocolCustomMessage,
    options?: { transcript?: boolean },
  ): Promise<void> {
    const persistedMessage = options?.transcript
      ? { ...customMessage, excludeFromContext: true }
      : customMessage;
    const messageStartEvent = { type: "message_start" as const, message: persistedMessage };
    const messageEndEvent = { type: "message_end" as const, message: persistedMessage };

    if (options?.transcript || this.#runner.hasHandlers("message_end")) {
      const transformedStart = await this.emitTurnLoopEvent(messageStartEvent);
      const transformedEnd = await this.emitTurnLoopEvent(messageEndEvent);
      const committedMessage =
        transformedEnd.type === "message_end" && transformedEnd.message.role === "custom"
          ? transformedEnd.message
          : persistedMessage;
      this.#appendMessage(committedMessage);
      this.#emitToListeners(transformedStart);
      this.#emitToListeners(transformedEnd);
      await this.syncContextState();
      return;
    }

    this.#appendMessage(persistedMessage);
    this.#appendCustomMessageEntry(
      customMessage.customType,
      customMessage.content as string | Array<{ type: string } & Record<string, unknown>>,
      customMessage.display,
      customMessage.details,
    );
    this.#emitToListeners(messageStartEvent);
    this.#emitToListeners(messageEndEvent);
    await this.syncContextState();
  }
}
