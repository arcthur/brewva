import type { SessionPhase } from "../contracts/session-phase.js";
import type {
  InternalSessionHostPlugin,
  InternalSessionHostPluginContext,
} from "../host-api/plugin.js";
import type { BrewvaPromptContentPart } from "../prompt/content.js";
import { advanceSessionPhaseResult, type SessionPhaseEvent } from "./phase-machine.js";

export interface BrewvaPromptEnvelope {
  promptId: string;
  parts: BrewvaPromptContentPart[];
  submittedAt: number;
}

export type BrewvaPromptQueueMode = "all" | "one-at-a-time";
export type BrewvaPromptKind = "prompt" | "queue" | "follow_up";

export interface BrewvaQueuedPrompt extends BrewvaPromptEnvelope {
  kind: BrewvaPromptKind;
}

export interface BrewvaSessionHost {
  getPhase(): SessionPhase;
  getQueuedPrompts(): readonly BrewvaQueuedPrompt[];
  removeQueuedPrompt(promptId: string): boolean;
  submitPrompt(prompt: BrewvaPromptEnvelope): void;
  queuePrompt(prompt: BrewvaPromptEnvelope): void;
  queueFollowUp(prompt: BrewvaPromptEnvelope): void;
  setQueueMode(mode: BrewvaPromptQueueMode): void;
  setFollowUpMode(mode: BrewvaPromptQueueMode): void;
  releaseNextBatch(): readonly BrewvaQueuedPrompt[];
  shiftPrompt(): BrewvaPromptEnvelope | undefined;
  transition(event: SessionPhaseEvent): Promise<SessionPhase>;
}

export interface CreateInMemorySessionHostOptions {
  plugins?: readonly InternalSessionHostPlugin[];
  pluginContext: InternalSessionHostPluginContext;
}

class InMemorySessionHost implements BrewvaSessionHost {
  private phase: SessionPhase = { kind: "idle" };

  private readonly primaryQueue: BrewvaQueuedPrompt[] = [];

  private readonly queuedPromptQueue: BrewvaQueuedPrompt[] = [];

  private readonly followUpQueue: BrewvaQueuedPrompt[] = [];

  private queueMode: BrewvaPromptQueueMode = "one-at-a-time";

  private followUpMode: BrewvaPromptQueueMode = "one-at-a-time";

  constructor(
    private readonly plugins: readonly InternalSessionHostPlugin[],
    private readonly pluginContext: InternalSessionHostPluginContext,
  ) {}

  getPhase(): SessionPhase {
    return this.phase;
  }

  getQueuedPrompts(): readonly BrewvaQueuedPrompt[] {
    return [...this.primaryQueue, ...this.queuedPromptQueue, ...this.followUpQueue];
  }

  removeQueuedPrompt(promptId: string): boolean {
    // Hosted gateway sessions remove queued prompts through the substrate turn loop.
    // This in-memory host path exists for direct substrate-backed session flows.
    return (
      this.removeFromQueue(this.primaryQueue, promptId) ||
      this.removeFromQueue(this.queuedPromptQueue, promptId) ||
      this.removeFromQueue(this.followUpQueue, promptId)
    );
  }

  submitPrompt(prompt: BrewvaPromptEnvelope): void {
    this.primaryQueue.push({ ...prompt, kind: "prompt" });
  }

  queuePrompt(prompt: BrewvaPromptEnvelope): void {
    this.queuedPromptQueue.push({ ...prompt, kind: "queue" });
  }

  queueFollowUp(prompt: BrewvaPromptEnvelope): void {
    this.followUpQueue.push({ ...prompt, kind: "follow_up" });
  }

  setQueueMode(mode: BrewvaPromptQueueMode): void {
    this.queueMode = mode;
  }

  setFollowUpMode(mode: BrewvaPromptQueueMode): void {
    this.followUpMode = mode;
  }

  releaseNextBatch(): readonly BrewvaQueuedPrompt[] {
    if (this.primaryQueue.length > 0) {
      const next = this.primaryQueue.shift();
      return next ? [next] : [];
    }
    if (this.queuedPromptQueue.length > 0) {
      return this.drainQueue(this.queuedPromptQueue, this.queueMode);
    }
    if (this.followUpQueue.length > 0) {
      return this.drainQueue(this.followUpQueue, this.followUpMode);
    }
    return [];
  }

  shiftPrompt(): BrewvaPromptEnvelope | undefined {
    const [next] = this.releaseNextBatch();
    if (!next) {
      return undefined;
    }
    return {
      promptId: next.promptId,
      parts: next.parts,
      submittedAt: next.submittedAt,
    };
  }

  async transition(event: SessionPhaseEvent): Promise<SessionPhase> {
    const next = advanceSessionPhaseResult(this.phase, event);
    if (!next.ok) {
      throw new Error(next.error);
    }
    this.phase = next.phase;
    for (const plugin of this.plugins) {
      await plugin.onSessionPhaseChange?.(this.phase, this.pluginContext);
    }
    return this.phase;
  }

  private drainQueue(
    queue: BrewvaQueuedPrompt[],
    mode: BrewvaPromptQueueMode,
  ): BrewvaQueuedPrompt[] {
    if (queue.length === 0) {
      return [];
    }
    if (mode === "all") {
      return queue.splice(0, queue.length);
    }
    const next = queue.shift();
    return next ? [next] : [];
  }

  private removeFromQueue(queue: BrewvaQueuedPrompt[], promptId: string): boolean {
    const index = queue.findIndex((entry) => entry.promptId === promptId);
    if (index < 0) {
      return false;
    }
    queue.splice(index, 1);
    return true;
  }
}

export function createInMemorySessionHost(
  options: CreateInMemorySessionHostOptions,
): BrewvaSessionHost {
  return new InMemorySessionHost(options.plugins ?? [], options.pluginContext);
}
