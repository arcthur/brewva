import type {
  BrewvaTurnEventScope,
  BrewvaAgentProtocolController,
  BrewvaAgentProtocolEvent,
  BrewvaAgentProtocolMessage,
  BrewvaAgentProtocolThinkingLevel,
  BrewvaAgentProtocolTool,
} from "@brewva/brewva-substrate/agent-protocol";
import type { BrewvaRegisteredModel } from "@brewva/brewva-substrate/provider";

type RuntimeTurnListener = (
  event: BrewvaAgentProtocolEvent,
  scope: BrewvaTurnEventScope | undefined,
  signal: AbortSignal | undefined,
) => Promise<BrewvaAgentProtocolEvent | void> | BrewvaAgentProtocolEvent | void;

interface RuntimeTurnState {
  systemPrompt: string;
  model: BrewvaRegisteredModel | undefined;
  thinkingLevel: BrewvaAgentProtocolThinkingLevel;
  tools: BrewvaAgentProtocolTool[];
  messages: BrewvaAgentProtocolMessage[];
}

export interface ManagedRuntimeTurnLease {
  readonly signal: AbortSignal;
  complete(): void;
}

export class ManagedRuntimeSessionController implements BrewvaAgentProtocolController {
  readonly #listeners = new Set<RuntimeTurnListener>();
  #activeAbortController: AbortController | null = null;
  #activeResolve: (() => void) | null = null;
  #activePromise: Promise<void> | null = null;
  #pendingSteer: string | undefined;
  #state: RuntimeTurnState;

  constructor(input: {
    readonly initialModel: BrewvaRegisteredModel | undefined;
    readonly initialThinkingLevel: BrewvaAgentProtocolThinkingLevel;
  }) {
    this.#state = {
      systemPrompt: "",
      model: input.initialModel,
      thinkingLevel: input.initialThinkingLevel,
      tools: [],
      messages: [],
    };
  }

  get state(): BrewvaAgentProtocolController["state"] {
    return {
      model: this.#state.model
        ? {
            provider: this.#state.model.provider,
            id: this.#state.model.id,
          }
        : undefined,
      thinkingLevel: this.#state.thinkingLevel,
      isStreaming: this.isRuntimeTurnActive(),
      systemPrompt: this.#state.systemPrompt,
      tools: this.#state.tools.map((tool) => ({ name: tool.name })),
    };
  }

  get signal(): AbortSignal | undefined {
    return this.#activeAbortController?.signal;
  }

  subscribe(listener: RuntimeTurnListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async prompt(): Promise<void> {
    throw new Error("managed_session_runtime_turn_required");
  }

  waitForIdle(): Promise<void> {
    return this.#activePromise ?? Promise.resolve();
  }

  setModel(model: BrewvaRegisteredModel): void {
    this.#state.model = model;
  }

  setThinkingLevel(level: BrewvaAgentProtocolThinkingLevel): void {
    this.#state.thinkingLevel = level;
  }

  replaceMessages(messages: BrewvaAgentProtocolMessage[]): void {
    this.#state.messages = [...messages];
  }

  abort(): void {
    this.#activeAbortController?.abort();
  }

  setTools(tools: BrewvaAgentProtocolTool[]): void {
    this.#state.tools = [...tools];
  }

  setSystemPrompt(prompt: string): void {
    this.#state.systemPrompt = prompt;
  }

  steer(text: string): boolean {
    if (!this.isRuntimeTurnActive()) {
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

  appendMessage(message: BrewvaAgentProtocolMessage): void {
    this.#state.messages.push(message);
  }

  isRuntimeTurnActive(): boolean {
    return this.#activeAbortController !== null;
  }

  beginRuntimeTurn(): ManagedRuntimeTurnLease {
    if (this.#activeAbortController) {
      throw new Error("managed_session_runtime_turn_already_active");
    }
    const abortController = new AbortController();
    this.#activeAbortController = abortController;
    this.#activePromise = new Promise<void>((resolve) => {
      this.#activeResolve = resolve;
    });
    let completed = false;
    return {
      signal: abortController.signal,
      complete: () => {
        if (completed) {
          return;
        }
        completed = true;
        this.#activeAbortController = null;
        this.#activeResolve?.();
        this.#activeResolve = null;
        this.#activePromise = null;
      },
    };
  }
}
