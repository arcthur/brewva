import { resolveBrewvaToolExecutionTraits } from "@brewva/brewva-tools";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";

type WaitMode = "shared" | "exclusive";

interface SessionExecutionWaiter {
  mode: WaitMode;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  dispose?: () => void;
}

interface SessionExecutionState {
  activeShared: number;
  activeExclusive: boolean;
  queue: SessionExecutionWaiter[];
}

function createAbortError(): Error {
  return new Error("tool_execution_aborted_before_start");
}

function getSessionId(ctx: ExtensionContext): string {
  const sessionId = ctx.sessionManager.getSessionId();
  return sessionId.trim().length > 0 ? sessionId.trim() : "__anonymous__";
}

function createSessionExecutionState(): SessionExecutionState {
  return {
    activeShared: 0,
    activeExclusive: false,
    queue: [],
  };
}

function canGrantImmediately(state: SessionExecutionState, mode: WaitMode): boolean {
  if (mode === "exclusive") {
    return !state.activeExclusive && state.activeShared === 0;
  }
  return !state.activeExclusive && !state.queue.some((entry) => entry.mode === "exclusive");
}

function removeWaiter(state: SessionExecutionState, waiter: SessionExecutionWaiter): void {
  const index = state.queue.indexOf(waiter);
  if (index >= 0) {
    state.queue.splice(index, 1);
  }
}

export interface HostedToolExecutionCoordinator {
  acquire(
    sessionId: string,
    mode: WaitMode,
    options?: {
      signal?: AbortSignal;
      honorAbort?: boolean;
    },
  ): Promise<() => void>;
}

class SessionScopedExecutionCoordinator implements HostedToolExecutionCoordinator {
  private readonly stateBySession = new Map<string, SessionExecutionState>();

  private getState(sessionId: string): SessionExecutionState {
    const existing = this.stateBySession.get(sessionId);
    if (existing) {
      return existing;
    }
    const created = createSessionExecutionState();
    this.stateBySession.set(sessionId, created);
    return created;
  }

  private cleanupSession(sessionId: string, state: SessionExecutionState): void {
    if (state.activeShared === 0 && !state.activeExclusive && state.queue.length === 0) {
      this.stateBySession.delete(sessionId);
    }
  }

  private grant(sessionId: string, state: SessionExecutionState, mode: WaitMode): () => void {
    if (mode === "exclusive") {
      state.activeExclusive = true;
    } else {
      state.activeShared += 1;
    }

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (mode === "exclusive") {
        state.activeExclusive = false;
      } else {
        state.activeShared = Math.max(0, state.activeShared - 1);
      }
      this.drain(sessionId, state);
      this.cleanupSession(sessionId, state);
    };
  }

  private drain(sessionId: string, state: SessionExecutionState): void {
    if (state.activeExclusive || state.queue.length === 0) {
      return;
    }

    const first = state.queue[0];
    if (!first) {
      return;
    }

    if (first.mode === "exclusive") {
      if (state.activeShared > 0) {
        return;
      }
      state.queue.shift();
      first.dispose?.();
      first.resolve(this.grant(sessionId, state, "exclusive"));
      return;
    }

    while (state.queue.length > 0) {
      const next = state.queue[0];
      if (!next || next.mode === "exclusive" || state.activeExclusive) {
        break;
      }
      state.queue.shift();
      next.dispose?.();
      next.resolve(this.grant(sessionId, state, "shared"));
    }
  }

  async acquire(
    sessionId: string,
    mode: WaitMode,
    options: {
      signal?: AbortSignal;
      honorAbort?: boolean;
    } = {},
  ): Promise<() => void> {
    const state = this.getState(sessionId);
    if (canGrantImmediately(state, mode)) {
      return this.grant(sessionId, state, mode);
    }

    if (options.honorAbort === true && options.signal?.aborted) {
      throw createAbortError();
    }

    return await new Promise<() => void>((resolve, reject) => {
      const waiter: SessionExecutionWaiter = {
        mode,
        resolve,
        reject,
      };

      if (options.honorAbort === true && options.signal) {
        const onAbort = () => {
          waiter.dispose?.();
          removeWaiter(state, waiter);
          this.cleanupSession(sessionId, state);
          reject(createAbortError());
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        waiter.dispose = () => {
          options.signal?.removeEventListener("abort", onAbort);
        };
      }

      state.queue.push(waiter);
      this.drain(sessionId, state);
    });
  }
}

function copyToolMetadataProperties(
  source: ToolDefinition,
  target: ToolDefinition,
): ToolDefinition {
  for (const propertyName of [
    "brewva",
    "brewvaExecutionTraits",
    "brewvaAgentParameters",
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(source, propertyName);
    if (descriptor) {
      Object.defineProperty(target, propertyName, descriptor);
    }
  }
  return target;
}

export function createHostedToolExecutionCoordinator(): HostedToolExecutionCoordinator {
  return new SessionScopedExecutionCoordinator();
}

export function wrapToolDefinitionWithHostedExecutionTraits<T extends ToolDefinition>(
  tool: T,
  coordinator: HostedToolExecutionCoordinator,
): T {
  const wrapped = {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const traits = resolveBrewvaToolExecutionTraits(tool, {
        toolName: tool.name,
        args: params,
        cwd: ctx.cwd,
      });
      const mode: WaitMode = traits.concurrencySafe ? "shared" : "exclusive";
      const release = await coordinator.acquire(getSessionId(ctx), mode, {
        signal,
        honorAbort: traits.interruptBehavior === "cancel",
      });

      const executionSignal = traits.interruptBehavior === "cancel" ? signal : undefined;

      try {
        return await tool.execute(toolCallId, params, executionSignal, onUpdate, ctx);
      } finally {
        release();
      }
    },
  } satisfies ToolDefinition;

  return copyToolMetadataProperties(tool, wrapped as ToolDefinition) as T;
}

export function wrapToolDefinitionsWithHostedExecutionTraits<T extends ToolDefinition>(
  tools: readonly T[] | undefined,
  coordinator: HostedToolExecutionCoordinator,
): T[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => wrapToolDefinitionWithHostedExecutionTraits(tool, coordinator));
}
