import {
  BrewvaCancelled,
  BrewvaEffect,
  BrewvaInterruptedError,
  runPromiseAtBoundary,
} from "@brewva/brewva-effect";
import type {
  ProviderCachePolicy,
  ProviderCacheRenderResult,
  ProviderPayloadMetadata,
  ResolvedFileContent,
} from "@brewva/brewva-provider-core/contracts";
import { providerRuntimeLayer } from "@brewva/brewva-provider-core/contracts";
import type { BrewvaRegisteredModel } from "../contracts/provider.js";
import {
  type BrewvaEventBus,
  type BrewvaEventBusController,
  createBrewvaEventBus,
} from "../execution/event-bus.js";
import { runBrewvaTurnLoop, type BrewvaTurnLoopConfig } from "./loop.js";
import type {
  BrewvaTurnEventScope,
  BrewvaTurnLoopController,
  BrewvaTurnLoopAfterToolCallContext,
  BrewvaTurnLoopBeforeToolCallContext,
  BrewvaTurnLoopContext,
  BrewvaTurnLoopEvent,
  BrewvaTurnLoopMessage,
  BrewvaTurnLoopResolveRequestAuth,
  BrewvaTurnLoopStopAfterToolResults,
  BrewvaTurnLoopStreamFunction,
  BrewvaTurnLoopThinkingBudgets,
  BrewvaTurnLoopThinkingLevel,
  BrewvaTurnLoopTool,
  BrewvaTurnLoopTransport,
} from "./types.js";

type QueueMode = "all" | "one-at-a-time";

interface MutableTurnLoopState {
  systemPrompt: string;
  model: BrewvaRegisteredModel | undefined;
  thinkingLevel: BrewvaTurnLoopThinkingLevel;
  tools: BrewvaTurnLoopTool[];
  messages: BrewvaTurnLoopMessage[];
  isStreaming: boolean;
  errorMessage?: string;
}

type ActiveRun = {
  promise: Promise<void>;
  resolve: () => void;
  abortController: AbortController;
};

function excludeTransientAssistantFailure(message: BrewvaTurnLoopMessage): BrewvaTurnLoopMessage {
  if (
    message.role !== "assistant" ||
    (message.stopReason !== "error" && message.stopReason !== "aborted")
  ) {
    return message;
  }
  return {
    ...message,
    excludeFromContext: true,
  };
}

function excludeTransientFailureFromEvent(event: BrewvaTurnLoopEvent): BrewvaTurnLoopEvent {
  switch (event.type) {
    case "message_start":
    case "message_update":
    case "message_end":
      return {
        ...event,
        message: excludeTransientAssistantFailure(event.message),
      };
    case "turn_end":
      return {
        ...event,
        message: excludeTransientAssistantFailure(event.message),
      };
    case "agent_end":
      return {
        ...event,
        messages: event.messages.map(excludeTransientAssistantFailure),
      };
    default:
      return event;
  }
}

function isAbortedRunFailure(error: unknown, signalAborted: boolean): boolean {
  return (
    signalAborted || error instanceof BrewvaCancelled || error instanceof BrewvaInterruptedError
  );
}

class PendingMessageQueue {
  readonly #messages: BrewvaTurnLoopMessage[] = [];

  constructor(public mode: QueueMode) {}

  enqueue(message: BrewvaTurnLoopMessage): void {
    this.#messages.push(message);
  }

  hasItems(): boolean {
    return this.#messages.length > 0;
  }

  remove(message: BrewvaTurnLoopMessage): boolean {
    const index = this.#messages.indexOf(message);
    if (index < 0) {
      return false;
    }
    this.#messages.splice(index, 1);
    return true;
  }

  drain(): BrewvaTurnLoopMessage[] {
    if (this.mode === "all") {
      const drained = [...this.#messages];
      this.#messages.length = 0;
      return drained;
    }

    const first = this.#messages[0];
    if (!first) {
      return [];
    }
    this.#messages.splice(0, 1);
    return [first];
  }

  clear(): void {
    this.#messages.length = 0;
  }
}

class BrewvaTurnLoopControllerImpl implements BrewvaTurnLoopController {
  readonly #events: BrewvaEventBus<BrewvaTurnLoopEvent, BrewvaTurnEventScope>;
  readonly #eventController: BrewvaEventBusController<BrewvaTurnLoopEvent, BrewvaTurnEventScope>;
  readonly #queuedPromptQueue: PendingMessageQueue;
  readonly #followUpQueue: PendingMessageQueue;
  readonly #streamFn: BrewvaTurnLoopStreamFunction;
  readonly #resolveRequestAuth: BrewvaTurnLoopResolveRequestAuth | undefined;
  readonly #sessionId: string | undefined;
  readonly #cachePolicy: ProviderCachePolicy | undefined;
  readonly #transport: BrewvaTurnLoopTransport;
  readonly #thinkingBudgets: BrewvaTurnLoopThinkingBudgets | undefined;
  readonly #maxRetryDelayMs: number | undefined;
  readonly #beforeToolCall:
    | ((
        input: BrewvaTurnLoopBeforeToolCallContext,
      ) => Promise<{ block?: boolean; reason?: string } | undefined>)
    | undefined;
  readonly #afterToolCall:
    | ((input: BrewvaTurnLoopAfterToolCallContext) => Promise<
        | {
            content?: Array<
              { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
            >;
            details?: unknown;
            isError?: boolean;
          }
        | undefined
      >)
    | undefined;
  readonly #onPayload: (
    payload: unknown,
    model: BrewvaRegisteredModel,
    metadata?: ProviderPayloadMetadata,
  ) => unknown;
  readonly #onCacheRender:
    | ((render: ProviderCacheRenderResult, model: BrewvaRegisteredModel) => void | Promise<void>)
    | undefined;
  readonly #transformContext: (
    messages: BrewvaTurnLoopMessage[],
  ) => Promise<BrewvaTurnLoopMessage[]>;
  readonly #shouldStopAfterToolResults: BrewvaTurnLoopStopAfterToolResults | undefined;
  readonly #resolveFile:
    | ((
        part: import("./types.js").BrewvaTurnLoopFileContent,
        model: BrewvaRegisteredModel,
      ) => ResolvedFileContent | undefined)
    | undefined;

  #state: MutableTurnLoopState;
  #activeRun: ActiveRun | undefined;
  #pendingSteer: string | undefined;

  constructor(input: {
    initialModel: BrewvaRegisteredModel | undefined;
    initialThinkingLevel: BrewvaTurnLoopThinkingLevel;
    queueMode: QueueMode | undefined;
    followUpMode: QueueMode | undefined;
    transport: BrewvaTurnLoopTransport;
    thinkingBudgets: BrewvaTurnLoopThinkingBudgets | undefined;
    maxRetryDelayMs: number | undefined;
    sessionId: string | undefined;
    cachePolicy: ProviderCachePolicy | undefined;
    beforeToolCall:
      | ((
          input: BrewvaTurnLoopBeforeToolCallContext,
        ) => Promise<{ block?: boolean; reason?: string } | undefined>)
      | undefined;
    afterToolCall:
      | ((input: BrewvaTurnLoopAfterToolCallContext) => Promise<
          | {
              content?: Array<
                { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
              >;
              details?: unknown;
              isError?: boolean;
            }
          | undefined
        >)
      | undefined;
    onPayload: (
      payload: unknown,
      model: BrewvaRegisteredModel,
      metadata?: ProviderPayloadMetadata,
    ) => unknown;
    onCacheRender:
      | ((render: ProviderCacheRenderResult, model: BrewvaRegisteredModel) => void | Promise<void>)
      | undefined;
    transformContext: (messages: BrewvaTurnLoopMessage[]) => Promise<BrewvaTurnLoopMessage[]>;
    shouldStopAfterToolResults: BrewvaTurnLoopStopAfterToolResults | undefined;
    resolveRequestAuth: BrewvaTurnLoopResolveRequestAuth | undefined;
    resolveFile:
      | ((
          part: import("./types.js").BrewvaTurnLoopFileContent,
          model: BrewvaRegisteredModel,
        ) => ResolvedFileContent | undefined)
      | undefined;
    streamFn: BrewvaTurnLoopStreamFunction;
  }) {
    const events = createBrewvaEventBus<BrewvaTurnLoopEvent, BrewvaTurnEventScope>({
      normalizeEvent: excludeTransientFailureFromEvent,
      acceptReturnedEvent: ({ current, returned }) => returned.type === current.type,
    });
    this.#events = events.bus;
    this.#eventController = events.controller;
    this.#state = {
      systemPrompt: "",
      model: input.initialModel,
      thinkingLevel: input.initialThinkingLevel,
      tools: [],
      messages: [],
      isStreaming: false,
      errorMessage: undefined,
    };
    this.#queuedPromptQueue = new PendingMessageQueue(input.queueMode ?? "one-at-a-time");
    this.#followUpQueue = new PendingMessageQueue(input.followUpMode ?? "one-at-a-time");
    this.#streamFn = input.streamFn;
    this.#resolveRequestAuth = input.resolveRequestAuth;
    this.#sessionId = input.sessionId;
    this.#cachePolicy = input.cachePolicy;
    this.#transport = input.transport;
    this.#thinkingBudgets = input.thinkingBudgets;
    this.#maxRetryDelayMs = input.maxRetryDelayMs;
    this.#beforeToolCall = input.beforeToolCall;
    this.#afterToolCall = input.afterToolCall;
    this.#onPayload = input.onPayload;
    this.#onCacheRender = input.onCacheRender;
    this.#transformContext = input.transformContext;
    this.#shouldStopAfterToolResults = input.shouldStopAfterToolResults;
    this.#resolveFile = input.resolveFile;
  }

  get state() {
    return {
      model: this.#state.model
        ? {
            provider: this.#state.model.provider,
            id: this.#state.model.id,
          }
        : undefined,
      thinkingLevel: this.#state.thinkingLevel,
      isStreaming: this.#state.isStreaming,
      systemPrompt: this.#state.systemPrompt,
      tools: this.#state.tools.map((tool) => ({ name: tool.name })),
    };
  }

  get signal(): AbortSignal | undefined {
    return this.#activeRun?.abortController.signal;
  }

  subscribe(
    listener: (
      event: BrewvaTurnLoopEvent,
      scope: BrewvaTurnEventScope | undefined,
      signal: AbortSignal | undefined,
    ) => Promise<BrewvaTurnLoopEvent | void> | BrewvaTurnLoopEvent | void,
  ): () => void {
    return this.#events.subscribe(listener);
  }

  async prompt(message: BrewvaTurnLoopMessage | BrewvaTurnLoopMessage[]): Promise<void> {
    if (this.#activeRun) {
      throw new Error(
        "Agent is already processing a prompt. Use queue() or followUp() to queue messages, or wait for completion.",
      );
    }
    const messages = Array.isArray(message) ? [...message] : [message];
    await this.#runPromptMessages(messages);
  }

  waitForIdle(): Promise<void> {
    return this.#activeRun?.promise ?? Promise.resolve();
  }

  setModel(model: BrewvaRegisteredModel): void {
    this.#state.model = model;
  }

  setThinkingLevel(level: BrewvaTurnLoopThinkingLevel): void {
    this.#state.thinkingLevel = level;
  }

  replaceMessages(messages: BrewvaTurnLoopMessage[]): void {
    this.#state.messages = [...messages];
  }

  abort(): void {
    this.#activeRun?.abortController.abort();
  }

  setTools(tools: BrewvaTurnLoopTool[]): void {
    this.#state.tools = [...tools];
  }

  setSystemPrompt(prompt: string): void {
    this.#state.systemPrompt = prompt;
  }

  followUp(message: BrewvaTurnLoopMessage): void {
    this.#followUpQueue.enqueue(message);
  }

  queue(message: BrewvaTurnLoopMessage): void {
    this.#queuedPromptQueue.enqueue(message);
  }

  removeQueuedMessage(message: BrewvaTurnLoopMessage, queue: "queue" | "followUp"): boolean {
    return queue === "followUp"
      ? this.#followUpQueue.remove(message)
      : this.#queuedPromptQueue.remove(message);
  }

  steer(text: string): boolean {
    if (!this.#activeRun) {
      return false;
    }
    const cleaned = text.trim();
    if (!cleaned) {
      return false;
    }
    this.#pendingSteer = this.#pendingSteer ? `${this.#pendingSteer}\n${cleaned}` : cleaned;
    return true;
  }

  hasPendingSteer(): boolean {
    return typeof this.#pendingSteer === "string" && this.#pendingSteer.length > 0;
  }

  appendMessage(message: BrewvaTurnLoopMessage): void {
    this.#state.messages.push(message);
  }

  hasQueuedMessages(): boolean {
    return this.#queuedPromptQueue.hasItems() || this.#followUpQueue.hasItems();
  }

  async #runPromptMessages(messages: BrewvaTurnLoopMessage[]): Promise<void> {
    this.#requireModel();
    await this.#runWithLifecycle(async (signal) => {
      await runPromiseAtBoundary(
        runBrewvaTurnLoop(
          messages,
          this.#createContextSnapshot(),
          this.#createLoopConfig(),
          (event, scope) => this.#processEvents(event, scope),
          signal,
        ).pipe(BrewvaEffect.provide(providerRuntimeLayer)),
        { signal },
      );
    });
  }

  #createContextSnapshot(): BrewvaTurnLoopContext {
    return {
      systemPrompt: this.#state.systemPrompt,
      messages: [...this.#state.messages],
      tools: [...this.#state.tools],
    };
  }

  #createLoopConfig(): BrewvaTurnLoopConfig {
    const model = this.#requireModel();
    return {
      model,
      reasoning: this.#state.thinkingLevel === "off" ? undefined : this.#state.thinkingLevel,
      sessionId: this.#sessionId,
      cachePolicy: this.#cachePolicy,
      onCacheRender: this.#onCacheRender,
      onPayload: this.#onPayload,
      transport: this.#transport,
      thinkingBudgets: this.#thinkingBudgets,
      maxRetryDelayMs: this.#maxRetryDelayMs,
      streamFn: this.#streamFn,
      beforeToolCall: this.#beforeToolCall,
      afterToolCall: this.#afterToolCall as BrewvaTurnLoopConfig["afterToolCall"],
      transformContext: this.#transformContext,
      getQueuedMessagesEffect: () => BrewvaEffect.sync(() => this.#queuedPromptQueue.drain()),
      getFollowUpMessagesEffect: () => BrewvaEffect.sync(() => this.#followUpQueue.drain()),
      consumePendingSteerEffect: () => BrewvaEffect.sync(() => this.#consumePendingSteer()),
      getCurrentContext: () => ({
        systemPrompt: this.#state.systemPrompt,
        tools: [...this.#state.tools],
      }),
      resolveRequestAuth: this.#resolveRequestAuth,
      resolveFile: this.#resolveFile,
      toolExecution: "parallel",
      shouldStopAfterToolResults: this.#shouldStopAfterToolResults,
    };
  }

  async #runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.#activeRun) {
      throw new Error("Agent is already processing.");
    }

    const runMessageStartIndex = this.#state.messages.length;
    const abortController = new AbortController();
    let resolvePromise: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    this.#activeRun = {
      promise,
      resolve: resolvePromise,
      abortController,
    };

    this.#state.isStreaming = true;
    this.#state.errorMessage = undefined;

    try {
      await executor(abortController.signal);
    } catch (error) {
      await this.#handleRunFailure(error, abortController.signal.aborted, runMessageStartIndex);
    } finally {
      this.#finishRun();
    }
  }

  async #handleRunFailure(
    error: unknown,
    aborted: boolean,
    runMessageStartIndex: number,
  ): Promise<void> {
    // runBrewvaTurnLoop handles the normal stopReason === "error" | "aborted"
    // return path itself and drains pendingSteer there. This method only runs
    // when runBrewvaTurnLoop throws an uncaught error, so the two paths are
    // mutually exclusive and cannot emit steer_dropped twice.
    const runWasAborted = isAbortedRunFailure(error, aborted);
    const pendingSteer = this.#consumePendingSteer();
    if (pendingSteer) {
      await this.#processEvents({
        type: "steer_dropped",
        text: pendingSteer,
        reason: runWasAborted ? "aborted" : "failed",
      });
    }
    const model = this.#requireModel();
    const failureMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: runWasAborted ? "aborted" : "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    } as BrewvaTurnLoopMessage;
    await this.#processEvents({ type: "message_start", message: failureMessage });
    const messageEnd = await this.#processEvents({ type: "message_end", message: failureMessage });
    const committedFailure =
      messageEnd.type === "message_end" ? messageEnd.message : failureMessage;
    await this.#processEvents({ type: "turn_end", message: committedFailure, toolResults: [] });
    await this.#processEvents({
      type: "agent_end",
      messages: this.#state.messages.slice(runMessageStartIndex),
    });
  }

  #requireModel(): BrewvaRegisteredModel {
    const model = this.#state.model;
    if (!model) {
      throw new Error(
        "Brewva turn loop requires a model before prompt(). Pass initialModel or call setModel().",
      );
    }
    return model;
  }

  #consumePendingSteer(): string | undefined {
    const text = this.#pendingSteer;
    this.#pendingSteer = undefined;
    return text;
  }

  #finishRun(): void {
    this.#state.isStreaming = false;
    this.#activeRun?.resolve();
    this.#activeRun = undefined;
  }

  async #processEvents(
    event: BrewvaTurnLoopEvent,
    scope?: BrewvaTurnEventScope,
    signal?: AbortSignal,
  ): Promise<BrewvaTurnLoopEvent> {
    const currentEvent = await this.#eventController.emit(event, scope, signal);

    switch (currentEvent.type) {
      case "message_end":
        this.#state.messages.push(currentEvent.message);
        break;
      case "turn_end":
        if (currentEvent.message.role === "assistant" && currentEvent.message.errorMessage) {
          this.#state.errorMessage = currentEvent.message.errorMessage;
        }
        break;
      case "agent_end":
        break;
      default:
        break;
    }

    return currentEvent;
  }
}

export function createBrewvaTurnLoopController(input: {
  initialModel?: BrewvaRegisteredModel;
  initialThinkingLevel: BrewvaTurnLoopThinkingLevel;
  sessionId: string;
  cachePolicy?: ProviderCachePolicy;
  queueMode: "all" | "one-at-a-time" | undefined;
  followUpMode: "all" | "one-at-a-time" | undefined;
  transport: BrewvaTurnLoopTransport;
  thinkingBudgets: BrewvaTurnLoopThinkingBudgets | undefined;
  maxRetryDelayMs: number | undefined;
  beforeToolCall: (
    input: BrewvaTurnLoopBeforeToolCallContext,
  ) => Promise<{ block?: boolean; reason?: string } | undefined>;
  afterToolCall: (input: BrewvaTurnLoopAfterToolCallContext) => Promise<
    | {
        content?: Array<
          { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
        >;
        details?: unknown;
        isError?: boolean;
      }
    | undefined
  >;
  onPayload: (
    payload: unknown,
    model: BrewvaRegisteredModel,
    metadata?: ProviderPayloadMetadata,
  ) => unknown;
  onCacheRender?: (
    render: ProviderCacheRenderResult,
    model: BrewvaRegisteredModel,
  ) => void | Promise<void>;
  transformContext: (messages: BrewvaTurnLoopMessage[]) => Promise<BrewvaTurnLoopMessage[]>;
  shouldStopAfterToolResults?: BrewvaTurnLoopStopAfterToolResults;
  resolveRequestAuth?: BrewvaTurnLoopResolveRequestAuth;
  resolveFile?: (
    part: import("./types.js").BrewvaTurnLoopFileContent,
    model: BrewvaRegisteredModel,
  ) => ResolvedFileContent | undefined;
  streamFn: BrewvaTurnLoopStreamFunction;
}): BrewvaTurnLoopController {
  return new BrewvaTurnLoopControllerImpl({
    initialModel: input.initialModel,
    initialThinkingLevel: input.initialThinkingLevel,
    queueMode: input.queueMode,
    followUpMode: input.followUpMode,
    transport: input.transport,
    thinkingBudgets: input.thinkingBudgets,
    maxRetryDelayMs: input.maxRetryDelayMs,
    sessionId: input.sessionId,
    cachePolicy: input.cachePolicy,
    beforeToolCall: input.beforeToolCall,
    afterToolCall: input.afterToolCall,
    onPayload: input.onPayload,
    onCacheRender: input.onCacheRender,
    transformContext: input.transformContext,
    shouldStopAfterToolResults: input.shouldStopAfterToolResults,
    resolveRequestAuth: input.resolveRequestAuth,
    resolveFile: input.resolveFile,
    streamFn: input.streamFn,
  });
}
