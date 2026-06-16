import { randomUUID } from "node:crypto";
import type { BrewvaAgentProtocolMessage } from "@brewva/brewva-substrate/agent-protocol";
import type {
  BrewvaHostCommandContext,
  BrewvaHostContext,
  BrewvaHostCustomMessage,
  BrewvaHostCustomMessageDelivery,
  BrewvaHostRegisteredCommand,
} from "@brewva/brewva-substrate/host-api";
import {
  buildBrewvaPromptText,
  cloneBrewvaPromptContentParts,
  type BrewvaPromptContentPart,
} from "@brewva/brewva-substrate/prompt";
import type {
  BrewvaPromptOptions,
  BrewvaPromptQueueBehavior,
  BrewvaQueuedPromptView,
} from "@brewva/brewva-substrate/session";
import {
  promptPartsFromCustomMessage,
  toTurnLoopCustomMessage,
} from "./session-prompt-dispatch.js";

export type QueuedUserMessage = Extract<BrewvaAgentProtocolMessage, { role: "user" }>;

export interface QueuedPromptEntry {
  view: BrewvaQueuedPromptView;
  message: QueuedUserMessage;
  parts: BrewvaPromptContentPart[];
}

export type PendingQueuedItem =
  | {
      kind: "user";
      parts: BrewvaPromptContentPart[];
    }
  | { kind: "custom"; message: BrewvaHostCustomMessage };

function toAgentUserContent(
  parts: readonly BrewvaPromptContentPart[],
): Extract<BrewvaAgentProtocolMessage, { role: "user" }>["content"] {
  return parts.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    if (part.type === "image") {
      return {
        type: "image",
        data: part.data,
        mimeType: part.mimeType,
      };
    }
    return {
      type: "file",
      uri: part.uri,
      name: part.name,
      mimeType: part.mimeType,
      displayText: part.displayText,
    };
  });
}

export class ManagedSessionDeferredTurnState {
  readonly #queuedPrompts: QueuedPromptEntry[] = [];
  readonly #queuedPromptIdsByMessage = new WeakMap<QueuedUserMessage, string>();
  readonly #pendingNextTurnMessages: Array<
    Extract<BrewvaAgentProtocolMessage, { role: "custom" }>
  > = [];

  getQueuedPromptViews(): readonly BrewvaQueuedPromptView[] {
    return this.#queuedPrompts.map((entry) => entry.view);
  }

  enqueueStreamingUserPrompt(
    parts: readonly BrewvaPromptContentPart[],
    behavior: BrewvaPromptQueueBehavior,
  ): QueuedPromptEntry {
    const submittedAt = Date.now();
    const promptId = randomUUID();
    const message: QueuedUserMessage = {
      role: "user",
      content: toAgentUserContent(parts),
      timestamp: submittedAt,
    };
    const view: BrewvaQueuedPromptView = Object.freeze({
      promptId,
      text: buildBrewvaPromptText(parts),
      submittedAt,
      behavior,
    });
    this.#queuedPromptIdsByMessage.set(message, promptId);
    const entry = { view, message, parts: cloneBrewvaPromptContentParts(parts) };
    this.#queuedPrompts.push(entry);
    return entry;
  }

  removeQueuedPrompt(
    promptId: string,
    removeFromAgent: (message: QueuedUserMessage, behavior: BrewvaPromptQueueBehavior) => boolean,
  ): boolean {
    const index = this.#queuedPrompts.findIndex((entry) => entry.view.promptId === promptId);
    if (index < 0) {
      return false;
    }
    const entry = this.#queuedPrompts[index];
    if (!entry || !removeFromAgent(entry.message, entry.view.behavior)) {
      return false;
    }
    this.#queuedPrompts.splice(index, 1);
    this.#queuedPromptIdsByMessage.delete(entry.message);
    return true;
  }

  acknowledgeStartedQueuedUser(message: QueuedUserMessage): boolean {
    const promptId = this.#queuedPromptIdsByMessage.get(message);
    if (!promptId) {
      return false;
    }
    const index = this.#queuedPrompts.findIndex((entry) => entry.view.promptId === promptId);
    if (index < 0) {
      this.#queuedPromptIdsByMessage.delete(message);
      return false;
    }
    this.#queuedPrompts.splice(index, 1);
    this.#queuedPromptIdsByMessage.delete(message);
    return true;
  }

  pushNextTurnMessage(message: Extract<BrewvaAgentProtocolMessage, { role: "custom" }>): void {
    this.#pendingNextTurnMessages.push(message);
  }

  consumeNextTurnMessages(): readonly Extract<BrewvaAgentProtocolMessage, { role: "custom" }>[] {
    const messages = [...this.#pendingNextTurnMessages];
    this.#pendingNextTurnMessages.length = 0;
    return messages;
  }

  consumeQueuedPrompt(): QueuedPromptEntry | null {
    const entry = this.#queuedPrompts.shift() ?? null;
    if (entry) {
      this.#queuedPromptIdsByMessage.delete(entry.message);
    }
    return entry;
  }

  hasPending(agentHasQueuedMessages: boolean): boolean {
    return agentHasQueuedMessages || this.#pendingNextTurnMessages.length > 0;
  }
}

/**
 * Bounds dispatch re-entrancy during command handling. While a command handler
 * runs, the gate buffers handler-triggered user/custom messages instead of
 * re-entering dispatch synchronously; the buffered back-edge is replayed later
 * via `flushCommandDispatchBuffer`, so the recursion into `dispatchPrompt`
 * stays bounded rather than unwinding inline within the active handler.
 */
export class ManagedSessionCommandDispatchGate {
  #buffer: PendingQueuedItem[] | null = null;

  begin(): void {
    this.#buffer = [];
  }

  isActive(): boolean {
    return this.#buffer !== null;
  }

  bufferUser(parts: readonly BrewvaPromptContentPart[]): boolean {
    if (!this.#buffer) {
      return false;
    }
    this.#buffer.push({
      kind: "user",
      parts: cloneBrewvaPromptContentParts(parts),
    });
    return true;
  }

  bufferTriggeredCustom(message: BrewvaHostCustomMessage): boolean {
    if (!this.#buffer) {
      return false;
    }
    this.#buffer.push({ kind: "custom", message });
    return true;
  }

  finishAfterCommand(): void {
    if (this.#buffer?.length === 0) {
      this.#buffer = null;
    }
  }

  consumeBufferedItems(): readonly PendingQueuedItem[] {
    const buffer = this.#buffer;
    this.#buffer = null;
    return buffer ?? [];
  }
}

export interface ManagedSessionCommandMessageRouterDeps {
  readonly commandDispatchGate: ManagedSessionCommandDispatchGate;
  readonly deferredTurnState: ManagedSessionDeferredTurnState;
  readonly isStreaming: () => boolean;
  readonly dispatchPrompt: (
    parts: readonly BrewvaPromptContentPart[],
    options?: BrewvaPromptOptions,
  ) => Promise<void>;
  readonly getRegisteredCommands: () => ReadonlyMap<string, BrewvaHostRegisteredCommand>;
  readonly appendPassiveCustomMessage: (
    customMessage: Extract<BrewvaAgentProtocolMessage, { role: "custom" }>,
    options?: { transcript?: boolean },
  ) => Promise<void>;
  readonly createHostContext: () => BrewvaHostContext;
  readonly waitForIdle: () => Promise<void>;
  readonly reload: () => Promise<void>;
}

export class ManagedSessionCommandMessageRouter {
  readonly #deps: ManagedSessionCommandMessageRouterDeps;
  readonly #commandUnsupported = async (): Promise<{ cancelled: boolean }> => ({ cancelled: true });

  constructor(deps: ManagedSessionCommandMessageRouterDeps) {
    this.#deps = deps;
  }

  async tryExecuteRegisteredCommand(name: string, args: string): Promise<boolean> {
    const command = this.#deps.getRegisteredCommands().get(name);
    if (!command) {
      return false;
    }
    this.#deps.commandDispatchGate.begin();
    try {
      await command.handler(args, this.createCommandContext());
      return true;
    } finally {
      this.#deps.commandDispatchGate.finishAfterCommand();
    }
  }

  async flushCommandDispatchBuffer(): Promise<void> {
    const buffer = this.#deps.commandDispatchGate.consumeBufferedItems();
    if (buffer.length === 0) {
      return;
    }
    for (const item of buffer) {
      if (item.kind === "user") {
        await this.#deps.dispatchPrompt(item.parts, {
          expandPromptTemplates: false,
          source: "extension",
        });
        continue;
      }
      await this.sendCustomMessage(item.message, { triggerTurn: true });
    }
  }

  async sendCustomMessage(
    message: BrewvaHostCustomMessage,
    options?: { triggerTurn?: boolean; deliverAs?: BrewvaHostCustomMessageDelivery },
  ): Promise<void> {
    const customMessage = toTurnLoopCustomMessage(message);

    if (options?.deliverAs === "nextTurn") {
      this.#deps.deferredTurnState.pushNextTurnMessage(customMessage);
      return;
    }

    if (options?.deliverAs === "transcript") {
      await this.#deps.appendPassiveCustomMessage(customMessage, { transcript: true });
      return;
    }

    if (
      !this.#deps.isStreaming() &&
      options?.triggerTurn &&
      this.#deps.commandDispatchGate.bufferTriggeredCustom(message)
    ) {
      return;
    }

    if (this.#deps.isStreaming()) {
      this.#deps.deferredTurnState.pushNextTurnMessage(customMessage);
      return;
    }

    if (options?.triggerTurn) {
      this.#deps.deferredTurnState.pushNextTurnMessage(customMessage);
      await this.#deps.dispatchPrompt(promptPartsFromCustomMessage(message), {
        expandPromptTemplates: false,
        source: "extension",
      });
      return;
    }

    await this.#deps.appendPassiveCustomMessage(customMessage);
  }

  async sendUserMessage(
    content: BrewvaPromptContentPart[],
    options?: { deliverAs?: "queue" | "followUp" },
  ): Promise<void> {
    if (!this.#deps.isStreaming() && this.#deps.commandDispatchGate.bufferUser(content)) {
      return;
    }

    await this.#deps.dispatchPrompt(content, {
      expandPromptTemplates: false,
      streamingBehavior: options?.deliverAs,
      source: "extension",
    });
  }

  private createCommandContext(): BrewvaHostCommandContext {
    const hostContext = this.#deps.createHostContext();
    return {
      ...hostContext,
      waitForIdle: () => this.#deps.waitForIdle(),
      newSession: this.#commandUnsupported,
      fork: this.#commandUnsupported,
      navigateTree: this.#commandUnsupported,
      switchSession: this.#commandUnsupported,
      reload: () => this.#deps.reload(),
    };
  }
}
