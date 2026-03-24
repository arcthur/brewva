import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { AgentSession, PromptOptions } from "@mariozechner/pi-coding-agent";

const COMPACTION_RESUME_PROMPT =
  "Context compaction completed. Resume the interrupted turn from the current task and evidence state. Do not repeat completed tool side effects unless required for correctness. Finish the pending response.";

const SESSION_COMPACTION_RECOVERY = Symbol("brewva.sessionCompactionRecovery");

type PromptDispatchOptions = PromptOptions;

interface CompactionRecoverySessionLike {
  prompt: AgentSession["prompt"];
  agent: {
    waitForIdle: () => Promise<void>;
  };
  sessionManager?: {
    getSessionId?: () => string;
  };
  isStreaming?: boolean;
  isCompacting?: boolean;
  dispose?: () => void;
}

interface CompactionRecoveryController {
  readonly sessionId: string;
  getRequestedGeneration(): number;
  waitForSettled(afterGeneration?: number): Promise<void>;
  dispose(): void;
}

type CompactionRecoveryAwareSession = CompactionRecoverySessionLike & {
  [SESSION_COMPACTION_RECOVERY]?: CompactionRecoveryController;
};

export interface CompactionRecoveryOptions {
  runtime?: BrewvaRuntime;
  sessionId?: string;
  promptOptions?: PromptDispatchOptions;
}

function normalizeSessionId(input: CompactionRecoverySessionLike): string | undefined {
  const value = input.sessionManager?.getSessionId?.();
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function buildResumeEventPayload(input: {
  sourceEventId: string;
  sourceTimestamp: number;
  sourceTurn?: number;
  error?: string;
}): Record<string, unknown> {
  return {
    sourceEventId: input.sourceEventId,
    sourceTimestamp: input.sourceTimestamp,
    sourceTurn: typeof input.sourceTurn === "number" ? input.sourceTurn : null,
    error: input.error ?? null,
  };
}

function waitForNextTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function waitForCompactionToFinish(session: CompactionRecoverySessionLike): Promise<void> {
  while (session.isCompacting === true) {
    await waitForNextTick();
  }
}

async function dispatchResumePrompt(session: CompactionRecoverySessionLike): Promise<void> {
  const promptOptions: PromptDispatchOptions = {
    expandPromptTemplates: false,
    source: "extension",
    ...(session.isStreaming === true ? { streamingBehavior: "followUp" as const } : {}),
  };
  await session.prompt(COMPACTION_RESUME_PROMPT, promptOptions);
}

function getInstalledCompactionRecovery(
  session: CompactionRecoverySessionLike,
): CompactionRecoveryController | undefined {
  return (session as CompactionRecoveryAwareSession)[SESSION_COMPACTION_RECOVERY];
}

function installTrackedPrompt(session: CompactionRecoverySessionLike): {
  getLatestPromptSettlement: () => Promise<void>;
} {
  const trackedSession = session as CompactionRecoveryAwareSession;
  const originalPrompt = session.prompt.bind(session);
  let latestPromptSettlement: Promise<void> = Promise.resolve();

  trackedSession.prompt = (async (content: string, promptOptions?: PromptDispatchOptions) => {
    const promptPromise = originalPrompt(content, promptOptions);
    latestPromptSettlement = promptPromise.then(
      () => undefined,
      () => undefined,
    );
    return promptPromise;
  }) as AgentSession["prompt"];

  return {
    getLatestPromptSettlement: () => latestPromptSettlement,
  };
}

export function installSessionCompactionRecovery<T extends CompactionRecoverySessionLike>(
  session: T,
  options: {
    runtime: BrewvaRuntime;
    sessionId?: string;
  },
): T {
  const existing = getInstalledCompactionRecovery(session);
  if (existing) {
    return session;
  }

  const sessionId = options.sessionId?.trim() || normalizeSessionId(session);
  if (!sessionId) {
    throw new Error("session compaction recovery requires a stable session id");
  }

  const { getLatestPromptSettlement } = installTrackedPrompt(session);
  const seenCompactionEventIds = new Set<string>();
  const pendingGenerationPromises = new Map<number, Promise<void>>();
  let requestedGeneration = 0;
  let completedGeneration = 0;
  let disposed = false;
  let disposePatched = false;

  const unsubscribe = options.runtime.events.subscribe((event) => {
    if (disposed) {
      return;
    }
    if (event.sessionId !== sessionId) {
      return;
    }
    if (event.type === "session_shutdown") {
      controller.dispose();
      return;
    }
    if (event.type !== "session_compact") {
      return;
    }
    if (seenCompactionEventIds.has(event.id)) {
      return;
    }

    seenCompactionEventIds.add(event.id);
    requestedGeneration += 1;
    const generation = requestedGeneration;
    options.runtime.events.record({
      sessionId,
      type: "session_turn_compaction_resume_requested",
      turn: event.turn,
      payload: buildResumeEventPayload({
        sourceEventId: event.id,
        sourceTimestamp: event.timestamp,
        sourceTurn: event.turn,
      }),
    });

    const previousGeneration =
      pendingGenerationPromises.get(generation - 1)?.catch(() => undefined) ?? Promise.resolve();
    const currentGeneration = previousGeneration.then(async () => {
      await getLatestPromptSettlement();
      await waitForCompactionToFinish(session);
      await session.agent.waitForIdle();

      try {
        await dispatchResumePrompt(session);
        completedGeneration = Math.max(completedGeneration, generation);
        options.runtime.events.record({
          sessionId,
          type: "session_turn_compaction_resume_dispatched",
          turn: event.turn,
          payload: buildResumeEventPayload({
            sourceEventId: event.id,
            sourceTimestamp: event.timestamp,
            sourceTurn: event.turn,
          }),
        });
      } catch (error) {
        completedGeneration = Math.max(completedGeneration, generation);
        options.runtime.events.record({
          sessionId,
          type: "session_turn_compaction_resume_failed",
          turn: event.turn,
          payload: buildResumeEventPayload({
            sourceEventId: event.id,
            sourceTimestamp: event.timestamp,
            sourceTurn: event.turn,
            error: error instanceof Error ? error.message : String(error),
          }),
        });
        throw error;
      }
    });

    pendingGenerationPromises.set(generation, currentGeneration);
    void currentGeneration.catch(() => undefined);
  });

  const originalDispose =
    typeof session.dispose === "function" ? session.dispose.bind(session) : undefined;

  const controller: CompactionRecoveryController = {
    sessionId,
    getRequestedGeneration() {
      return requestedGeneration;
    },
    async waitForSettled(afterGeneration = 0): Promise<void> {
      while (true) {
        await getLatestPromptSettlement();
        await waitForCompactionToFinish(session);
        await session.agent.waitForIdle();

        const targetGeneration = requestedGeneration;
        if (targetGeneration <= afterGeneration) {
          if (requestedGeneration <= afterGeneration && session.isCompacting !== true) {
            return;
          }
          continue;
        }

        const pending = pendingGenerationPromises.get(targetGeneration);
        if (pending) {
          await pending;
        }

        await getLatestPromptSettlement();
        await waitForCompactionToFinish(session);
        await session.agent.waitForIdle();

        if (requestedGeneration === targetGeneration && completedGeneration >= targetGeneration) {
          return;
        }
      }
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribe();
      delete (session as CompactionRecoveryAwareSession)[SESSION_COMPACTION_RECOVERY];
    },
  };

  (session as CompactionRecoveryAwareSession)[SESSION_COMPACTION_RECOVERY] = controller;

  if (originalDispose && !disposePatched) {
    disposePatched = true;
    (session as CompactionRecoveryAwareSession).dispose = (() => {
      controller.dispose();
      return originalDispose();
    }) as typeof session.dispose;
  }

  return session;
}

function getOrInstallCompactionRecovery(
  session: CompactionRecoverySessionLike,
  options: CompactionRecoveryOptions,
): CompactionRecoveryController | undefined {
  const existing = getInstalledCompactionRecovery(session);
  if (existing) {
    return existing;
  }
  if (!options.runtime) {
    return undefined;
  }
  installSessionCompactionRecovery(session, {
    runtime: options.runtime,
    sessionId: options.sessionId,
  });
  return getInstalledCompactionRecovery(session);
}

export async function sendPromptWithCompactionRecovery(
  session: CompactionRecoverySessionLike,
  prompt: string,
  options: CompactionRecoveryOptions = {},
): Promise<void> {
  const controller = getOrInstallCompactionRecovery(session, options);
  const afterGeneration = controller?.getRequestedGeneration() ?? 0;

  await session.prompt(prompt, options.promptOptions);
  if (!controller) {
    return;
  }
  await controller.waitForSettled(afterGeneration);
}

export function wrapSessionWithSettledPrompts<T extends CompactionRecoverySessionLike>(
  session: T,
  options: CompactionRecoveryOptions = {},
): T {
  return new Proxy(session, {
    get(target, prop, receiver) {
      if (prop === "prompt") {
        return (content: string, promptOptions?: PromptDispatchOptions) =>
          sendPromptWithCompactionRecovery(target, content, {
            ...options,
            promptOptions,
          });
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  });
}

export const COMPACTION_RECOVERY_TEST_ONLY = {
  COMPACTION_RESUME_PROMPT,
};
