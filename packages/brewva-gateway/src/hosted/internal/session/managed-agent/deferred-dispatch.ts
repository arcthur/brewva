import { randomUUID } from "node:crypto";
import { toJsonValue } from "@brewva/brewva-std/json";
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
import type { SteeringSidecarStore } from "./steering-sidecar.js";

export interface QueuedPromptEntry {
  view: BrewvaQueuedPromptView;
  parts: BrewvaPromptContentPart[];
}

type PromptQueueMode = "all" | "one-at-a-time";

export interface ManagedSessionDeferredTurnStateOptions {
  readonly queueMode?: PromptQueueMode;
  readonly followUpMode?: PromptQueueMode;
  /** When present, in-session injections are persisted to a per-session sidecar. */
  readonly store?: SteeringSidecarStore;
}

export type PendingQueuedItem =
  | {
      kind: "user";
      parts: BrewvaPromptContentPart[];
    }
  | { kind: "custom"; message: BrewvaHostCustomMessage };

type NextTurnMessage = Extract<BrewvaAgentProtocolMessage, { role: "custom" }>;

export class ManagedSessionDeferredTurnState {
  readonly #queuedPrompts: QueuedPromptEntry[] = [];
  readonly #followUpPrompts: QueuedPromptEntry[] = [];
  readonly #pendingNextTurnMessages: NextTurnMessage[] = [];
  readonly #queueMode: PromptQueueMode;
  readonly #followUpMode: PromptQueueMode;
  readonly #store: SteeringSidecarStore | undefined;

  constructor(options: ManagedSessionDeferredTurnStateOptions = {}) {
    this.#queueMode = options.queueMode ?? "one-at-a-time";
    this.#followUpMode = options.followUpMode ?? "one-at-a-time";
    this.#store = options.store;
  }

  getQueuedPromptViews(): readonly BrewvaQueuedPromptView[] {
    return [...this.#queuedPrompts, ...this.#followUpPrompts].map((entry) => entry.view);
  }

  enqueueStreamingUserPrompt(
    parts: readonly BrewvaPromptContentPart[],
    behavior: BrewvaPromptQueueBehavior,
  ): QueuedPromptEntry {
    const submittedAt = Date.now();
    const promptId = randomUUID();
    const view: BrewvaQueuedPromptView = Object.freeze({
      promptId,
      text: buildBrewvaPromptText(parts),
      submittedAt,
      behavior,
    });
    const entry = { view, parts: cloneBrewvaPromptContentParts(parts) };
    // Durable commit point: persist before the in-memory queue moves.
    this.#store?.appendInjection({
      id: promptId,
      channel: behavior,
      payload: toJsonValue(entry.parts),
      submittedAt,
    });
    const queue = behavior === "followUp" ? this.#followUpPrompts : this.#queuedPrompts;
    queue.push(entry);
    return entry;
  }

  removeQueuedPrompt(promptId: string): boolean {
    const queue = this.#queueContainingPrompt(promptId);
    const index = queue.findIndex((entry) => entry.view.promptId === promptId);
    if (index < 0) {
      return false;
    }
    const entry = queue[index];
    if (!entry) {
      return false;
    }
    this.#store?.markConsumed(promptId);
    queue.splice(index, 1);
    return true;
  }

  pushNextTurnMessage(message: NextTurnMessage): void {
    // Next-turn custom messages are advisory, transient turn context (injected
    // into the next provider call, never a tape event of their own), so they are
    // held in memory only and not persisted to the steering sidecar.
    this.#pendingNextTurnMessages.push(message);
  }

  consumeNextTurnMessages(): readonly NextTurnMessage[] {
    const messages = [...this.#pendingNextTurnMessages];
    this.#pendingNextTurnMessages.length = 0;
    return messages;
  }

  consumeNextPromptBatch(): readonly QueuedPromptEntry[] {
    return this.#queuedPrompts.length > 0
      ? this.#drainPromptQueue(this.#queuedPrompts, this.#queueMode)
      : this.#drainPromptQueue(this.#followUpPrompts, this.#followUpMode);
  }

  restoreUnattemptedPromptBatch(entries: readonly QueuedPromptEntry[]): void {
    const queued = entries.filter((entry) => entry.view.behavior === "queue");
    const followUps = entries.filter((entry) => entry.view.behavior === "followUp");
    this.#queuedPrompts.unshift(...queued);
    this.#followUpPrompts.unshift(...followUps);
  }

  #drainPromptQueue(queue: QueuedPromptEntry[], mode: PromptQueueMode): QueuedPromptEntry[] {
    const count = mode === "all" ? queue.length : Math.min(queue.length, 1);
    return queue.splice(0, count);
  }

  #queueContainingPrompt(promptId: string): QueuedPromptEntry[] {
    return this.#queuedPrompts.some((entry) => entry.view.promptId === promptId)
      ? this.#queuedPrompts
      : this.#followUpPrompts;
  }

  hasPending(): boolean {
    return (
      this.#queuedPrompts.length > 0 ||
      this.#followUpPrompts.length > 0 ||
      this.#pendingNextTurnMessages.length > 0
    );
  }

  /**
   * Durably retire a prompt once its turn has succeeded. The consume loop calls
   * this after the attempt commits, not at drain time: a crash inside the
   * enqueue->consume window must re-enqueue the prompt on restart, not lose it.
   */
  markPromptConsumed(promptId: string): void {
    this.#store?.markConsumed(promptId);
  }

  /**
   * Rebuild the in-memory queues from the durable sidecar after a restart. Each
   * surviving row replays into its channel with its original id, so consume and
   * remove keep addressing it. A no-op when no store is attached.
   */
  restoreFromSidecar(): void {
    if (!this.#store) {
      return;
    }
    for (const record of this.#store.loadPending()) {
      const parts = cloneBrewvaPromptContentParts(
        record.payload as unknown as BrewvaPromptContentPart[],
      );
      const view: BrewvaQueuedPromptView = Object.freeze({
        promptId: record.id,
        text: buildBrewvaPromptText(parts),
        submittedAt: record.submittedAt,
        behavior: record.channel,
      });
      const entry = { view, parts };
      (record.channel === "followUp" ? this.#followUpPrompts : this.#queuedPrompts).push(entry);
    }
  }
}

export interface DeferredPromptDrainDeps {
  readonly deferredTurnState: ManagedSessionDeferredTurnState;
  readonly isStreaming: () => boolean;
  readonly runAttempt: (
    parts: readonly BrewvaPromptContentPart[],
    source: BrewvaPromptOptions["source"],
  ) => Promise<"completed" | "stopped">;
  readonly onQueueChanged: () => void;
  readonly restoreUnattempted: (entries: readonly QueuedPromptEntry[]) => void;
}

/**
 * Drain queued / follow-up prompts one batch at a time, running each through
 * `runAttempt`. Shared by the post-dispatch loop and restart recovery so the two
 * paths are identical and the drain is independently testable. A prompt is retired
 * (`markPromptConsumed`) only after its attempt returns, so a crash mid-turn
 * (runAttempt never resolves) leaves it pending to re-enqueue — at_least_once.
 */
export async function drainDeferredPromptQueue(
  deps: DeferredPromptDrainDeps,
  source: BrewvaPromptOptions["source"],
): Promise<void> {
  while (!deps.isStreaming()) {
    const batch = deps.deferredTurnState.consumeNextPromptBatch();
    if (batch.length === 0) {
      break;
    }
    deps.onQueueChanged();
    for (const [index, queued] of batch.entries()) {
      try {
        const status = await deps.runAttempt(queued.parts, source);
        deps.deferredTurnState.markPromptConsumed(queued.view.promptId);
        if (status === "stopped") {
          deps.restoreUnattempted(batch.slice(index + 1));
          return;
        }
      } catch (error) {
        deps.deferredTurnState.markPromptConsumed(queued.view.promptId);
        deps.restoreUnattempted(batch.slice(index + 1));
        throw error;
      }
    }
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
