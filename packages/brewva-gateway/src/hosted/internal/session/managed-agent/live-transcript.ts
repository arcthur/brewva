import type {
  BrewvaTurnLoopController,
  BrewvaTurnLoopMessage,
  BrewvaTurnLoopTool,
} from "@brewva/brewva-substrate/turn";

export interface ManagedSessionLiveTranscriptOptions {
  agent: BrewvaTurnLoopController;
  clearProviderCacheSessionState: () => Promise<void>;
}

export class ManagedSessionLiveTranscript {
  readonly #agent: BrewvaTurnLoopController;
  readonly #clearProviderCacheSessionState: () => Promise<void>;

  constructor(options: ManagedSessionLiveTranscriptOptions) {
    this.#agent = options.agent;
    this.#clearProviderCacheSessionState = options.clearProviderCacheSessionState;
  }

  appendCommittedMessage(message: BrewvaTurnLoopMessage): void {
    this.#agent.appendMessage(message);
  }

  async replacePersistedMessages(messages: unknown): Promise<void> {
    if (!Array.isArray(messages)) {
      throw new Error("replaceMessages expects an array of messages.");
    }
    await this.#clearProviderCacheSessionState();
    this.#agent.replaceMessages([...messages] as BrewvaTurnLoopMessage[]);
  }

  applyBaseContext(input: { systemPrompt: string; tools: BrewvaTurnLoopTool[] }): void {
    this.#agent.setTools(input.tools);
    this.#agent.setSystemPrompt(input.systemPrompt);
  }

  applyBaseSystemPrompt(systemPrompt: string): void {
    this.#agent.setSystemPrompt(systemPrompt);
  }

  applyPromptOverlay(systemPrompt: string): void {
    this.#agent.setSystemPrompt(systemPrompt);
  }
}
