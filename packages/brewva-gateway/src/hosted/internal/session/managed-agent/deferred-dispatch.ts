import { randomUUID } from "node:crypto";
import type { BrewvaHostCustomMessage } from "@brewva/brewva-substrate/host-api";
import {
  buildBrewvaPromptText,
  cloneBrewvaPromptContentParts,
  type BrewvaPromptContentPart,
} from "@brewva/brewva-substrate/prompt";
import type {
  BrewvaPromptQueueBehavior,
  BrewvaQueuedPromptView,
} from "@brewva/brewva-substrate/session";
import type { BrewvaTurnLoopMessage } from "@brewva/brewva-substrate/turn";

export type QueuedUserMessage = Extract<BrewvaTurnLoopMessage, { role: "user" }>;

export interface QueuedPromptEntry {
  view: BrewvaQueuedPromptView;
  message: QueuedUserMessage;
}

export type PendingQueuedItem =
  | {
      kind: "user";
      parts: BrewvaPromptContentPart[];
    }
  | { kind: "custom"; message: BrewvaHostCustomMessage };

function toAgentUserContent(
  parts: readonly BrewvaPromptContentPart[],
): Extract<BrewvaTurnLoopMessage, { role: "user" }>["content"] {
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
  readonly #pendingNextTurnMessages: Array<Extract<BrewvaTurnLoopMessage, { role: "custom" }>> = [];

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
    const entry = { view, message };
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

  pushNextTurnMessage(message: Extract<BrewvaTurnLoopMessage, { role: "custom" }>): void {
    this.#pendingNextTurnMessages.push(message);
  }

  consumeNextTurnMessages(): readonly Extract<BrewvaTurnLoopMessage, { role: "custom" }>[] {
    const messages = [...this.#pendingNextTurnMessages];
    this.#pendingNextTurnMessages.length = 0;
    return messages;
  }

  hasPending(agentHasQueuedMessages: boolean): boolean {
    return agentHasQueuedMessages || this.#pendingNextTurnMessages.length > 0;
  }
}

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
