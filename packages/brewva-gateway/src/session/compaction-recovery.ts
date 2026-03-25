import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { AgentSession, PromptOptions } from "@mariozechner/pi-coding-agent";
import type { PromptDispatchSession } from "./contracts.js";

const COMPACTION_RESUME_PROMPT =
  "Context compaction completed. Resume the interrupted turn from the current task and evidence state. Do not repeat completed tool side effects unless required for correctness. Finish the pending response.";

const controllerByRawSession = new WeakMap<
  CompactionRecoverySessionLike,
  InstalledCompactionRecoveryController
>();
const backgroundWrappedByRawSession = new WeakMap<
  CompactionRecoverySessionLike,
  CompactionRecoverySessionLike
>();
const settledWrappedByRawSession = new WeakMap<
  CompactionRecoverySessionLike,
  CompactionRecoverySessionLike
>();
const rawByWrappedSession = new WeakMap<
  CompactionRecoverySessionLike,
  CompactionRecoverySessionLike
>();

type PromptDispatchOptions = PromptOptions;

export type CompactionRecoverySessionLike = PromptDispatchSession;

interface CompactionRecoveryController {
  readonly sessionId: string;
  getRequestedGeneration(): number;
  waitForSettled(afterGeneration?: number): Promise<void>;
  dispose(): void;
}

interface InstalledCompactionRecoveryController extends CompactionRecoveryController {
  dispatchPrompt(content: string, promptOptions?: PromptDispatchOptions): Promise<void>;
}

export interface CompactionRecoveryOptions {
  runtime?: BrewvaRuntime;
  sessionId?: string;
  promptOptions?: PromptDispatchOptions;
}

function normalizeSessionId(input: CompactionRecoverySessionLike): string | undefined {
  const value = input.sessionManager?.getSessionId?.();
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolveRawSession(session: CompactionRecoverySessionLike): CompactionRecoverySessionLike {
  return rawByWrappedSession.get(session) ?? session;
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

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

async function waitForCompactionToFinish(session: CompactionRecoverySessionLike): Promise<void> {
  while (session.isCompacting === true) {
    await waitForNextTick();
  }
}

async function dispatchResumePrompt(input: {
  session: CompactionRecoverySessionLike;
  dispatchPrompt: (content: string, promptOptions?: PromptDispatchOptions) => Promise<void>;
}): Promise<void> {
  const promptOptions: PromptDispatchOptions = {
    expandPromptTemplates: false,
    source: "extension",
    ...(input.session.isStreaming === true ? { streamingBehavior: "followUp" as const } : {}),
  };
  await input.dispatchPrompt(COMPACTION_RESUME_PROMPT, promptOptions);
}

function createCompactionRecoveryController(
  session: CompactionRecoverySessionLike,
  options: {
    runtime: BrewvaRuntime;
    sessionId?: string;
  },
): InstalledCompactionRecoveryController {
  const rawSession = resolveRawSession(session);
  const sessionId = options.sessionId?.trim() || normalizeSessionId(rawSession);
  if (!sessionId) {
    throw new Error("session compaction recovery requires a stable session id");
  }

  const seenCompactionEventIds = new Set<string>();
  const pendingGenerationPromises = new Map<number, Promise<void>>();
  let latestPromptSettlement: Promise<void> = Promise.resolve();
  let requestedGeneration = 0;
  let completedGeneration = 0;
  let disposed = false;
  const basePrompt = rawSession.prompt.bind(rawSession);

  const dispatchPrompt = async (
    content: string,
    promptOptions?: PromptDispatchOptions,
  ): Promise<void> => {
    const promptPromise = basePrompt(content, promptOptions);
    latestPromptSettlement = promptPromise.then(
      () => undefined,
      () => undefined,
    );
    return promptPromise;
  };

  const controller: InstalledCompactionRecoveryController = {
    sessionId,
    getRequestedGeneration() {
      return requestedGeneration;
    },
    async dispatchPrompt(content: string, promptOptions?: PromptDispatchOptions): Promise<void> {
      return dispatchPrompt(content, promptOptions);
    },
    async waitForSettled(afterGeneration = 0): Promise<void> {
      while (true) {
        await latestPromptSettlement;
        await waitForCompactionToFinish(rawSession);
        await rawSession.agent.waitForIdle();

        const targetGeneration = requestedGeneration;
        if (targetGeneration <= afterGeneration) {
          if (requestedGeneration <= afterGeneration && rawSession.isCompacting !== true) {
            return;
          }
          continue;
        }

        const pending = pendingGenerationPromises.get(targetGeneration);
        if (pending) {
          await pending;
        }

        await latestPromptSettlement;
        await waitForCompactionToFinish(rawSession);
        await rawSession.agent.waitForIdle();

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
      controllerByRawSession.delete(rawSession);
    },
  };

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
      await latestPromptSettlement;
      await waitForCompactionToFinish(rawSession);
      await rawSession.agent.waitForIdle();

      try {
        await dispatchResumePrompt({
          session: rawSession,
          dispatchPrompt,
        });
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

  controllerByRawSession.set(rawSession, controller);
  return controller;
}

function getInstalledCompactionRecovery(
  session: CompactionRecoverySessionLike,
): InstalledCompactionRecoveryController | undefined {
  return controllerByRawSession.get(resolveRawSession(session));
}

function withTemporaryPromptInterception<T>(
  session: CompactionRecoverySessionLike,
  prompt: AgentSession["prompt"],
  invoke: () => T,
): T {
  const hadOwnPrompt = Object.prototype.hasOwnProperty.call(session, "prompt");
  const previousPromptDescriptor = Object.getOwnPropertyDescriptor(session, "prompt");

  Object.defineProperty(session, "prompt", {
    configurable: true,
    writable: true,
    value: prompt,
  });

  const restore = () => {
    if (hadOwnPrompt && previousPromptDescriptor) {
      Object.defineProperty(session, "prompt", previousPromptDescriptor);
      return;
    }
    delete (session as { prompt?: unknown }).prompt;
  };

  try {
    const result = invoke();
    if (isPromiseLike(result)) {
      return Promise.resolve(result).finally(restore) as T;
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function getOrInstallCompactionRecovery(
  session: CompactionRecoverySessionLike,
  options: CompactionRecoveryOptions,
): InstalledCompactionRecoveryController | undefined {
  const rawSession = resolveRawSession(session);
  const existing = getInstalledCompactionRecovery(rawSession);
  if (existing) {
    return existing;
  }
  if (!options.runtime) {
    return undefined;
  }
  return createCompactionRecoveryController(rawSession, {
    runtime: options.runtime,
    sessionId: options.sessionId,
  });
}

async function sendPromptWithBackgroundCompactionRecovery(
  session: CompactionRecoverySessionLike,
  prompt: string,
  options: CompactionRecoveryOptions = {},
): Promise<void> {
  const rawSession = resolveRawSession(session);
  const controller = getOrInstallCompactionRecovery(rawSession, options);
  if (controller) {
    await controller.dispatchPrompt(prompt, options.promptOptions);
    return;
  }
  await rawSession.prompt(prompt, options.promptOptions);
}

export function installSessionCompactionRecovery<T extends CompactionRecoverySessionLike>(
  session: T,
  options: {
    runtime: BrewvaRuntime;
    sessionId?: string;
  },
): T {
  const rawSession = resolveRawSession(session);
  getOrInstallCompactionRecovery(rawSession, options);
  const promptWithBackgroundRecovery: AgentSession["prompt"] = (content, promptOptions) =>
    sendPromptWithBackgroundCompactionRecovery(rawSession, content, {
      ...options,
      promptOptions,
    });

  return createSessionFacade(rawSession as T, {
    prompt: promptWithBackgroundRecovery,
    wrappedSessions: backgroundWrappedByRawSession,
  });
}

export async function sendPromptWithCompactionRecovery(
  session: CompactionRecoverySessionLike,
  prompt: string,
  options: CompactionRecoveryOptions = {},
): Promise<void> {
  const rawSession = resolveRawSession(session);
  const controller = getOrInstallCompactionRecovery(rawSession, options);
  const afterGeneration = controller?.getRequestedGeneration() ?? 0;

  if (controller) {
    await controller.dispatchPrompt(prompt, options.promptOptions);
  } else {
    await rawSession.prompt(prompt, options.promptOptions);
  }

  if (!controller) {
    return;
  }
  if (
    rawSession.isStreaming === true &&
    typeof options.promptOptions?.streamingBehavior === "string"
  ) {
    return;
  }
  await controller.waitForSettled(afterGeneration);
}

export function wrapSessionWithSettledPrompts<T extends CompactionRecoverySessionLike>(
  session: T,
  options: CompactionRecoveryOptions = {},
): T {
  const rawSession = resolveRawSession(session) as T;
  const promptWithRecovery: AgentSession["prompt"] = (content, promptOptions) =>
    sendPromptWithCompactionRecovery(rawSession, content, {
      ...options,
      promptOptions,
    });

  return createSessionFacade(rawSession, {
    prompt: promptWithRecovery,
    wrappedSessions: settledWrappedByRawSession,
  });
}

function createSessionFacade<T extends CompactionRecoverySessionLike>(
  session: T,
  input: {
    prompt: AgentSession["prompt"];
    wrappedSessions: WeakMap<CompactionRecoverySessionLike, CompactionRecoverySessionLike>;
  },
): T {
  const existing = input.wrappedSessions.get(session);
  if (existing) {
    return existing as T;
  }

  const wrapped = new Proxy(session, {
    get(target, prop) {
      if (prop === "prompt") {
        return input.prompt;
      }

      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") {
        return value;
      }

      if (prop === "dispose") {
        return (...args: unknown[]) => {
          getInstalledCompactionRecovery(target)?.dispose();
          return Reflect.apply(value, target, args);
        };
      }

      return (...args: unknown[]) =>
        withTemporaryPromptInterception(target, input.prompt, () =>
          Reflect.apply(value, target, args),
        );
    },
  });

  input.wrappedSessions.set(session, wrapped);
  rawByWrappedSession.set(wrapped, session);
  return wrapped;
}

export const COMPACTION_RECOVERY_TEST_ONLY = {
  COMPACTION_RESUME_PROMPT,
};
