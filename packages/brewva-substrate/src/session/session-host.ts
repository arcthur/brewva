import type { SessionPhase } from "../contracts/session-phase.js";
import type { HostRuntimePlugin, HostRuntimePluginContext } from "../host-api/plugin.js";
import { advanceSessionPhaseResult, type SessionPhaseEvent } from "./phase-machine.js";
import type { BrewvaPromptContentPart } from "./prompt-content.js";

export interface BrewvaPromptEnvelope {
  promptId: string;
  parts: BrewvaPromptContentPart[];
  submittedAt: number;
}

export type BrewvaPromptQueueMode = "all" | "one-at-a-time";
export type BrewvaPromptKind = "prompt" | "steer" | "follow_up";

export interface BrewvaQueuedPrompt extends BrewvaPromptEnvelope {
  kind: BrewvaPromptKind;
}

export interface BrewvaSessionHost {
  getPhase(): SessionPhase;
  getQueuedPrompts(): readonly BrewvaQueuedPrompt[];
  submitPrompt(prompt: BrewvaPromptEnvelope): void;
  queueSteer(prompt: BrewvaPromptEnvelope): void;
  queueFollowUp(prompt: BrewvaPromptEnvelope): void;
  setSteeringMode(mode: BrewvaPromptQueueMode): void;
  setFollowUpMode(mode: BrewvaPromptQueueMode): void;
  releaseNextBatch(): readonly BrewvaQueuedPrompt[];
  shiftPrompt(): BrewvaPromptEnvelope | undefined;
  transition(event: SessionPhaseEvent): Promise<SessionPhase>;
}

export interface CreateInMemorySessionHostOptions {
  plugins?: readonly HostRuntimePlugin[];
  pluginContext: HostRuntimePluginContext;
}

class InMemorySessionHost implements BrewvaSessionHost {
  private phase: SessionPhase = { kind: "idle" };

  private readonly primaryQueue: BrewvaQueuedPrompt[] = [];

  private readonly steeringQueue: BrewvaQueuedPrompt[] = [];

  private readonly followUpQueue: BrewvaQueuedPrompt[] = [];

  private steeringMode: BrewvaPromptQueueMode = "one-at-a-time";

  private followUpMode: BrewvaPromptQueueMode = "one-at-a-time";

  constructor(
    private readonly plugins: readonly HostRuntimePlugin[],
    private readonly pluginContext: HostRuntimePluginContext,
  ) {}

  getPhase(): SessionPhase {
    return this.phase;
  }

  getQueuedPrompts(): readonly BrewvaQueuedPrompt[] {
    return [...this.primaryQueue, ...this.steeringQueue, ...this.followUpQueue];
  }

  submitPrompt(prompt: BrewvaPromptEnvelope): void {
    this.primaryQueue.push({ ...prompt, kind: "prompt" });
  }

  queueSteer(prompt: BrewvaPromptEnvelope): void {
    this.steeringQueue.push({ ...prompt, kind: "steer" });
  }

  queueFollowUp(prompt: BrewvaPromptEnvelope): void {
    this.followUpQueue.push({ ...prompt, kind: "follow_up" });
  }

  setSteeringMode(mode: BrewvaPromptQueueMode): void {
    this.steeringMode = mode;
  }

  setFollowUpMode(mode: BrewvaPromptQueueMode): void {
    this.followUpMode = mode;
  }

  releaseNextBatch(): readonly BrewvaQueuedPrompt[] {
    if (this.primaryQueue.length > 0) {
      const next = this.primaryQueue.shift();
      return next ? [next] : [];
    }
    if (this.steeringQueue.length > 0) {
      return this.drainQueue(this.steeringQueue, this.steeringMode);
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
}

export function createInMemorySessionHost(
  options: CreateInMemorySessionHostOptions,
): BrewvaSessionHost {
  return new InMemorySessionHost(options.plugins ?? [], options.pluginContext);
}
