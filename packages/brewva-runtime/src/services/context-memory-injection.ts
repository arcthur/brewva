import { readIdentityProfile } from "../context/identity.js";
import type { ContextInjectionRegisterResult } from "../context/injection.js";
import { CONTEXT_SOURCES } from "../context/sources.js";
import { MemoryEngine } from "../memory/engine.js";
import type { BrewvaConfig, BrewvaEventRecord, ContextBudgetUsage } from "../types.js";
import type { RuntimeCallback } from "./callback.js";

interface ContextMemoryInjectionServiceOptions {
  workspaceRoot: string;
  agentId: string;
  config: BrewvaConfig;
  memory: MemoryEngine;
  sanitizeInput: RuntimeCallback<[text: string], string>;
  registerContextInjection: RuntimeCallback<
    [
      sessionId: string,
      input: {
        source: string;
        id: string;
        content: string;
        estimatedTokens?: number;
        oncePerSession?: boolean;
      },
    ],
    ContextInjectionRegisterResult
  >;
  recordEvent: RuntimeCallback<
    [
      input: {
        sessionId: string;
        type: string;
        turn?: number;
        payload?: Record<string, unknown>;
        timestamp?: number;
        skipTapeCheckpoint?: boolean;
      },
    ],
    BrewvaEventRecord | undefined
  >;
}

export class ContextMemoryInjectionService {
  private readonly workspaceRoot: string;
  private readonly agentId: string;
  private readonly config: BrewvaConfig;
  private readonly memory: MemoryEngine;
  private readonly sanitizeInput: ContextMemoryInjectionServiceOptions["sanitizeInput"];
  private readonly registerContextInjection: ContextMemoryInjectionServiceOptions["registerContextInjection"];
  private readonly recordEvent: ContextMemoryInjectionServiceOptions["recordEvent"];

  constructor(options: ContextMemoryInjectionServiceOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.agentId = options.agentId;
    this.config = options.config;
    this.memory = options.memory;
    this.sanitizeInput = options.sanitizeInput;
    this.registerContextInjection = options.registerContextInjection;
    this.recordEvent = options.recordEvent;
  }

  registerIdentityContextInjection(sessionId: string): void {
    let profile: ReturnType<typeof readIdentityProfile>;
    try {
      profile = readIdentityProfile({
        workspaceRoot: this.workspaceRoot,
        agentId: this.agentId,
      });
    } catch (error) {
      this.recordEvent({
        sessionId,
        type: "identity_parse_warning",
        payload: {
          agentId: this.agentId,
          reason: error instanceof Error ? error.message : "unknown_error",
        },
      });
      return;
    }
    if (!profile) return;

    const content = profile.content.trim();
    if (!content) return;
    this.registerContextInjection(sessionId, {
      source: CONTEXT_SOURCES.identity,
      id: `identity-${profile.agentId}`,
      content,
      oncePerSession: true,
    });
  }

  async registerMemoryContextInjection(
    sessionId: string,
    _prompt: string,
    _usage?: ContextBudgetUsage,
  ): Promise<void> {
    if (!this.config.memory.enabled) return;

    this.memory.refreshIfNeeded({ sessionId });

    const working = this.memory.getWorkingMemory(sessionId);
    const workingContent = this.sanitizeInput(working?.content ?? "").trim();
    if (!workingContent) return;

    this.registerContextInjection(sessionId, {
      source: CONTEXT_SOURCES.memoryWorking,
      id: "memory-working",
      content: workingContent,
    });
  }
}
