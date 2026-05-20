import type {
  BrewvaAgentProtocolController,
  BrewvaAgentProtocolMessage,
  BrewvaAgentProtocolTool,
} from "@brewva/brewva-substrate/agent-protocol";

export interface ManagedSessionLiveTranscriptOptions {
  agent: BrewvaAgentProtocolController;
  clearProviderCacheSessionState: () => Promise<void>;
}

export class ManagedSessionLiveTranscript {
  readonly #agent: BrewvaAgentProtocolController;
  readonly #clearProviderCacheSessionState: () => Promise<void>;

  constructor(options: ManagedSessionLiveTranscriptOptions) {
    this.#agent = options.agent;
    this.#clearProviderCacheSessionState = options.clearProviderCacheSessionState;
  }

  appendCommittedMessage(message: BrewvaAgentProtocolMessage): void {
    this.#agent.appendMessage(message);
  }

  async replacePersistedMessages(messages: unknown): Promise<void> {
    if (!Array.isArray(messages)) {
      throw new Error("replaceMessages expects an array of messages.");
    }
    await this.#clearProviderCacheSessionState();
    this.#agent.replaceMessages([...messages] as BrewvaAgentProtocolMessage[]);
  }

  applyBaseContext(input: { systemPrompt: string; tools: BrewvaAgentProtocolTool[] }): void {
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
