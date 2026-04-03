import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import { selectBrewvaFallbackModel } from "@brewva/brewva-tools";
import type { AgentSession, PromptOptions } from "@mariozechner/pi-coding-agent";
import type { PromptDispatchSession } from "./contracts.js";
import {
  armNextPromptOutputBudgetEscalation,
  clearNextPromptOutputBudgetEscalation,
  hasProviderRequestRecoveryInstalled,
} from "./prompt-recovery-state.js";
import {
  getHostedTurnTransitionCoordinator,
  recordSessionTurnTransition,
} from "./turn-transition.js";

const COMPACTION_RESUME_PROMPT =
  "Context compaction completed. Resume the interrupted turn from the current task and evidence state. Do not repeat completed tool side effects unless required for correctness. Finish the pending response.";
const MAX_OUTPUT_RECOVERY_PROMPT =
  "The previous assistant response exceeded the output budget. Continue from the current task and evidence state, but finish more concisely. Do not repeat prior content or replay completed tool side effects. Deliver only the highest-value remaining answer.";
const PROVIDER_FALLBACK_RECOVERY_PROMPT =
  "The previous model request failed before the turn could complete. Continue from the current task and evidence state. Do not repeat completed tool side effects. Resume the pending response.";

const controllerStoreByRuntime = new WeakMap<
  BrewvaRuntime,
  Map<string, InstalledCompactionRecoveryController>
>();
const RECOVERY_MODE_SYMBOL = Symbol("brewva.compactionRecoveryMode");

type PromptDispatchOptions = PromptOptions;
type CompactionRecoveryMode = "background" | "settled";
type PromptRecoveryPolicyName =
  | "deterministic_context_reduction"
  | "output_budget_escalation"
  | "provider_fallback_retry"
  | "max_output_recovery";
type PromptRecoveryDecision = "recovered" | "continue";
interface PromptRecoveryResult {
  decision: PromptRecoveryDecision;
  nextError?: unknown;
}

export type CompactionRecoverySessionLike = PromptDispatchSession;

type PromptSessionModel = NonNullable<AgentSession["model"]>;
type PromptSessionThinkingLevel = AgentSession["thinkingLevel"];

interface ModelAwarePromptDispatchSession extends PromptDispatchSession {
  readonly model?: PromptSessionModel;
  readonly thinkingLevel?: PromptSessionThinkingLevel;
  readonly modelRegistry?: {
    getAvailable?: () => Promise<PromptSessionModel[]>;
    getAll?: () => PromptSessionModel[];
  };
  readonly getAvailableThinkingLevels?: () => PromptSessionThinkingLevel[];
  readonly agent: PromptDispatchSession["agent"] & {
    setModel?: (model: PromptSessionModel) => void;
    setThinkingLevel?: (level: PromptSessionThinkingLevel) => void;
  };
}

interface CompactionRecoveryController {
  readonly sessionId: string;
  getRequestedGeneration(): number;
  waitForSettled(afterGeneration?: number): Promise<void>;
  dispose(): void;
  installMode(mode: CompactionRecoveryMode): void;
}

interface InstalledCompactionRecoveryController extends CompactionRecoveryController {
  dispatchPrompt(content: string, promptOptions?: PromptDispatchOptions): Promise<void>;
  readonly rawSession: CompactionRecoverySessionLike;
  readonly runtime: BrewvaRuntime;
}

export interface CompactionRecoveryOptions {
  runtime?: BrewvaRuntime;
  sessionId?: string;
  promptOptions?: PromptDispatchOptions;
}

interface PromptRecoveryContext {
  runtime: BrewvaRuntime;
  session: CompactionRecoverySessionLike;
  sessionId: string;
  prompt: string;
  promptOptions?: PromptDispatchOptions;
  error: unknown;
  message: string;
  controller?: InstalledCompactionRecoveryController;
  transitionCoordinator: ReturnType<typeof getHostedTurnTransitionCoordinator>;
  afterGeneration: number;
  operatorVisibleCheckpoint: number;
}

interface PromptRecoveryPolicy {
  readonly name: PromptRecoveryPolicyName;
  execute(input: PromptRecoveryContext): Promise<PromptRecoveryResult>;
}

function normalizeSessionId(input: CompactionRecoverySessionLike): string | undefined {
  const value = input.sessionManager?.getSessionId?.();
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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

function getControllerStore(
  runtime: BrewvaRuntime,
): Map<string, InstalledCompactionRecoveryController> {
  const existing = controllerStoreByRuntime.get(runtime);
  if (existing) {
    return existing;
  }
  const created = new Map<string, InstalledCompactionRecoveryController>();
  controllerStoreByRuntime.set(runtime, created);
  return created;
}

function normalizeRuntimeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  return "unknown_error";
}

function looksLikeMaxOutputError(error: unknown): boolean {
  const message = normalizeRuntimeError(error).toLowerCase();
  return (
    message.includes("max_output") ||
    message.includes("max output") ||
    message.includes("output token") ||
    message.includes("response too long") ||
    message.includes("length finish reason")
  );
}

function looksLikeRetryableProviderError(error: unknown): boolean {
  const message = normalizeRuntimeError(error).toLowerCase();
  if (looksLikeMaxOutputError(error)) {
    return false;
  }
  return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|529|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|timed? out|timeout|terminated|retry delay/u.test(
    message,
  );
}

function readCurrentModel(session: CompactionRecoverySessionLike): PromptSessionModel | undefined {
  return (session as ModelAwarePromptDispatchSession).model;
}

function formatModelKey(model: PromptSessionModel | undefined): string | null {
  if (!model) {
    return null;
  }
  return `${model.provider}/${model.id}`;
}

async function listAvailableModels(
  session: CompactionRecoverySessionLike,
): Promise<PromptSessionModel[]> {
  const modelRegistry = (session as ModelAwarePromptDispatchSession).modelRegistry;
  if (typeof modelRegistry?.getAvailable === "function") {
    return await modelRegistry.getAvailable();
  }
  if (typeof modelRegistry?.getAll === "function") {
    return modelRegistry.getAll();
  }
  return [];
}

function resolveFallbackThinkingLevel(
  session: CompactionRecoverySessionLike,
  preferredLevel: PromptSessionThinkingLevel | undefined,
): PromptSessionThinkingLevel {
  const getter = (session as ModelAwarePromptDispatchSession).getAvailableThinkingLevels;
  if (typeof getter !== "function") {
    return preferredLevel ?? "off";
  }
  const available = getter.call(session);
  if (preferredLevel && available.includes(preferredLevel)) {
    return preferredLevel;
  }
  return available[available.length - 1] ?? "off";
}

async function withTemporaryModel<T>(
  session: CompactionRecoverySessionLike,
  model: PromptSessionModel,
  fn: () => Promise<T>,
): Promise<T> {
  const typedSession = session as ModelAwarePromptDispatchSession;
  const previousModel = typedSession.model;
  const previousThinkingLevel = typedSession.thinkingLevel ?? "off";
  typedSession.agent.setModel?.(model);
  typedSession.agent.setThinkingLevel?.(
    resolveFallbackThinkingLevel(session, previousThinkingLevel),
  );
  try {
    return await fn();
  } finally {
    if (previousModel) {
      typedSession.agent.setModel?.(previousModel);
    }
    typedSession.agent.setThinkingLevel?.(previousThinkingLevel);
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

async function dispatchMaxOutputRecoveryPrompt(input: {
  session: CompactionRecoverySessionLike;
  dispatchPrompt: (content: string, promptOptions?: PromptDispatchOptions) => Promise<void>;
}): Promise<void> {
  const promptOptions: PromptDispatchOptions = {
    expandPromptTemplates: false,
    source: "extension",
    ...(input.session.isStreaming === true ? { streamingBehavior: "followUp" as const } : {}),
  };
  await input.dispatchPrompt(MAX_OUTPUT_RECOVERY_PROMPT, promptOptions);
}

async function dispatchProviderFallbackRecoveryPrompt(input: {
  session: CompactionRecoverySessionLike;
  dispatchPrompt: (content: string, promptOptions?: PromptDispatchOptions) => Promise<void>;
}): Promise<void> {
  const promptOptions: PromptDispatchOptions = {
    expandPromptTemplates: false,
    source: "extension",
    ...(input.session.isStreaming === true ? { streamingBehavior: "followUp" as const } : {}),
  };
  await input.dispatchPrompt(PROVIDER_FALLBACK_RECOVERY_PROMPT, promptOptions);
}

function buildRecoveryFailureError(rootError: unknown, recoveryError: unknown): Error {
  const rootMessage = normalizeRuntimeError(rootError);
  const recoveryMessage = normalizeRuntimeError(recoveryError);
  return new Error(`${rootMessage}; max_output_recovery_exhausted:${recoveryMessage}`);
}

function buildProviderFallbackFailureError(rootError: unknown, recoveryError: unknown): Error {
  const rootMessage = normalizeRuntimeError(rootError);
  const recoveryMessage = normalizeRuntimeError(recoveryError);
  return new Error(`${rootMessage}; provider_fallback_retry_exhausted:${recoveryMessage}`);
}

const deterministicContextReductionPolicy: PromptRecoveryPolicy = {
  name: "deterministic_context_reduction",
  async execute(input) {
    if (!input.controller) {
      return {
        decision: "continue",
      };
    }
    if (input.controller.getRequestedGeneration() <= input.afterGeneration) {
      return {
        decision: "continue",
      };
    }
    await input.controller.waitForSettled(input.afterGeneration);
    return {
      decision: "recovered",
    };
  },
};

const outputBudgetEscalationPolicy: PromptRecoveryPolicy = {
  name: "output_budget_escalation",
  async execute(input) {
    if (!looksLikeMaxOutputError(input.error)) {
      return {
        decision: "continue",
      };
    }
    const currentModel = readCurrentModel(input.session);
    if (
      !input.controller ||
      !currentModel ||
      currentModel.maxTokens <= 0 ||
      !hasProviderRequestRecoveryInstalled(input.runtime)
    ) {
      recordSessionTurnTransition(input.runtime, {
        sessionId: input.sessionId,
        reason: "output_budget_escalation",
        status: "skipped",
        error:
          !hasProviderRequestRecoveryInstalled(input.runtime) &&
          input.controller &&
          currentModel &&
          currentModel.maxTokens > 0
            ? "provider_request_recovery_unavailable"
            : input.message,
        model: formatModelKey(currentModel),
      });
      return {
        decision: "continue",
      };
    }
    recordSessionTurnTransition(input.runtime, {
      sessionId: input.sessionId,
      reason: "output_budget_escalation",
      status: "entered",
      model: formatModelKey(currentModel),
    });
    armNextPromptOutputBudgetEscalation(input.runtime, {
      sessionId: input.sessionId,
      targetMaxTokens: currentModel.maxTokens,
      model: formatModelKey(currentModel),
    });
    try {
      await input.controller.dispatchPrompt(input.prompt, input.promptOptions);
      if (clearNextPromptOutputBudgetEscalation(input.runtime, input.sessionId)) {
        recordSessionTurnTransition(input.runtime, {
          sessionId: input.sessionId,
          reason: "output_budget_escalation",
          status: "skipped",
          error: "provider_request_recovery_not_applied",
          model: formatModelKey(currentModel),
        });
      }
      return {
        decision: "recovered",
      };
    } catch (recoveryError) {
      if (clearNextPromptOutputBudgetEscalation(input.runtime, input.sessionId)) {
        recordSessionTurnTransition(input.runtime, {
          sessionId: input.sessionId,
          reason: "output_budget_escalation",
          status: "failed",
          error: normalizeRuntimeError(recoveryError),
          model: formatModelKey(currentModel),
        });
      }
      return {
        decision: "continue",
        nextError: recoveryError,
      };
    }
  },
};

const providerFallbackPolicy: PromptRecoveryPolicy = {
  name: "provider_fallback_retry",
  async execute(input) {
    if (!looksLikeRetryableProviderError(input.error)) {
      return {
        decision: "continue",
      };
    }

    const currentModel = readCurrentModel(input.session);
    const fallbackModel = currentModel
      ? selectBrewvaFallbackModel({
          currentModel,
          availableModels: await listAvailableModels(input.session),
        })
      : undefined;
    if (!fallbackModel) {
      recordSessionTurnTransition(input.runtime, {
        sessionId: input.sessionId,
        reason: "provider_fallback_retry",
        status: "skipped",
        error: input.message,
        model: formatModelKey(currentModel),
      });
      return {
        decision: "continue",
      };
    }
    if (!input.controller) {
      recordSessionTurnTransition(input.runtime, {
        sessionId: input.sessionId,
        reason: "provider_fallback_retry",
        status: "skipped",
        error: "provider_fallback_retry_controller_unavailable",
        model: formatModelKey(fallbackModel),
      });
      return {
        decision: "continue",
      };
    }

    const attempt =
      input.transitionCoordinator.getFailureCount(input.sessionId, "provider_fallback_retry") + 1;
    if (input.transitionCoordinator.isBreakerOpen(input.sessionId, "provider_fallback_retry")) {
      recordSessionTurnTransition(input.runtime, {
        sessionId: input.sessionId,
        reason: "provider_fallback_retry",
        status: "skipped",
        attempt,
        breakerOpen: true,
        error: input.message,
        model: formatModelKey(fallbackModel),
      });
      throw input.error;
    }

    recordSessionTurnTransition(input.runtime, {
      sessionId: input.sessionId,
      reason: "provider_fallback_retry",
      status: "entered",
      attempt,
      model: formatModelKey(fallbackModel),
    });

    try {
      await withTemporaryModel(input.session, fallbackModel, async () => {
        await dispatchProviderFallbackRecoveryPrompt({
          session: input.session,
          dispatchPrompt: (content, promptOptions) =>
            input.controller?.dispatchPrompt(content, promptOptions) ??
            Promise.reject(new Error("provider_fallback_retry_controller_unavailable")),
        });
      });
      recordSessionTurnTransition(input.runtime, {
        sessionId: input.sessionId,
        reason: "provider_fallback_retry",
        status: "completed",
        attempt,
        model: formatModelKey(fallbackModel),
      });
      return {
        decision: "recovered",
      };
    } catch (recoveryError) {
      recordSessionTurnTransition(input.runtime, {
        sessionId: input.sessionId,
        reason: "provider_fallback_retry",
        status: "failed",
        attempt,
        error: normalizeRuntimeError(recoveryError),
        model: formatModelKey(fallbackModel),
      });
      throw buildProviderFallbackFailureError(input.error, recoveryError);
    }
  },
};

const maxOutputRecoveryPolicy: PromptRecoveryPolicy = {
  name: "max_output_recovery",
  async execute(input) {
    if (!looksLikeMaxOutputError(input.error)) {
      return {
        decision: "continue",
      };
    }

    const attempt =
      input.transitionCoordinator.getFailureCount(input.sessionId, "max_output_recovery") + 1;
    if (input.transitionCoordinator.isBreakerOpen(input.sessionId, "max_output_recovery")) {
      if (clearNextPromptOutputBudgetEscalation(input.runtime, input.sessionId)) {
        recordSessionTurnTransition(input.runtime, {
          sessionId: input.sessionId,
          reason: "output_budget_escalation",
          status: "skipped",
          error: input.message,
          model: formatModelKey(readCurrentModel(input.session)),
        });
      }
      recordSessionTurnTransition(input.runtime, {
        sessionId: input.sessionId,
        reason: "max_output_recovery",
        status: "skipped",
        attempt,
        breakerOpen: true,
        error: input.message,
      });
      throw input.error;
    }

    recordSessionTurnTransition(input.runtime, {
      sessionId: input.sessionId,
      reason: "max_output_recovery",
      status: "entered",
      attempt,
    });

    try {
      if (!input.controller) {
        clearNextPromptOutputBudgetEscalation(input.runtime, input.sessionId);
        throw new Error("max_output_recovery_controller_unavailable");
      }
      await dispatchMaxOutputRecoveryPrompt({
        session: input.session,
        dispatchPrompt: (content, promptOptions) =>
          input.controller?.dispatchPrompt(content, promptOptions) ??
          Promise.reject(new Error("max_output_recovery_controller_unavailable")),
      });
      recordSessionTurnTransition(input.runtime, {
        sessionId: input.sessionId,
        reason: "max_output_recovery",
        status: "completed",
        attempt,
      });
      return {
        decision: "recovered",
      };
    } catch (recoveryError) {
      recordSessionTurnTransition(input.runtime, {
        sessionId: input.sessionId,
        reason: "max_output_recovery",
        status: "failed",
        attempt,
        error: normalizeRuntimeError(recoveryError),
      });
      throw buildRecoveryFailureError(input.error, recoveryError);
    }
  },
};

const PROMPT_RECOVERY_POLICIES: readonly PromptRecoveryPolicy[] = [
  deterministicContextReductionPolicy,
  outputBudgetEscalationPolicy,
  providerFallbackPolicy,
  maxOutputRecoveryPolicy,
];

function createCompactionRecoveryController(
  session: CompactionRecoverySessionLike,
  options: {
    runtime: BrewvaRuntime;
    sessionId?: string;
  },
): InstalledCompactionRecoveryController {
  const sessionId = options.sessionId?.trim() || normalizeSessionId(session);
  if (!sessionId) {
    throw new Error("session compaction recovery requires a stable session id");
  }

  const store = getControllerStore(options.runtime);
  const existing = store.get(sessionId);
  if (existing && existing.rawSession !== session) {
    existing.dispose();
  } else if (existing) {
    return existing;
  }

  const seenCompactionEventIds = new Set<string>();
  const pendingGenerationPromises = new Map<number, Promise<void>>();
  const transitionCoordinator = getHostedTurnTransitionCoordinator(options.runtime);
  const basePrompt = session.prompt.bind(session);
  const originalPrompt = session.prompt;
  const originalDispose = session.dispose?.bind(session);
  const sessionState = session as unknown as Record<PropertyKey, unknown>;
  let latestPromptSettlement: Promise<void> = Promise.resolve();
  let requestedGeneration = 0;
  let completedGeneration = 0;
  let disposed = false;

  const removeController = () => {
    const runtimeStore = controllerStoreByRuntime.get(options.runtime);
    if (!runtimeStore) {
      return;
    }
    runtimeStore.delete(sessionId);
    if (runtimeStore.size === 0) {
      controllerStoreByRuntime.delete(options.runtime);
    }
  };

  const dispatchPrompt = async (
    content: string,
    promptOptions?: PromptDispatchOptions,
  ): Promise<void> => {
    const promptPromise = basePrompt(content, promptOptions);
    latestPromptSettlement = promptPromise.then(
      () => undefined,
      () => undefined,
    );
    return await promptPromise;
  };

  const installPromptMode = (mode: CompactionRecoveryMode): void => {
    if (disposed) {
      return;
    }
    if (sessionState[RECOVERY_MODE_SYMBOL] === mode) {
      return;
    }
    const promptWrapper: AgentSession["prompt"] = (content, promptOptions) => {
      if (mode === "settled") {
        return sendPromptWithCompactionRecovery(session, content, {
          runtime: options.runtime,
          sessionId,
          promptOptions,
        });
      }
      return sendPromptWithBackgroundCompactionRecovery(session, content, {
        runtime: options.runtime,
        sessionId,
        promptOptions,
      });
    };
    session.prompt = promptWrapper;
    if (typeof originalDispose === "function") {
      session.dispose = () => {
        controller.dispose();
        originalDispose();
      };
    }
    sessionState[RECOVERY_MODE_SYMBOL] = mode;
  };

  const controller: InstalledCompactionRecoveryController = {
    sessionId,
    runtime: options.runtime,
    rawSession: session,
    getRequestedGeneration() {
      return requestedGeneration;
    },
    installMode(mode) {
      installPromptMode(mode);
    },
    async dispatchPrompt(content: string, promptOptions?: PromptDispatchOptions): Promise<void> {
      return await dispatchPrompt(content, promptOptions);
    },
    async waitForSettled(afterGeneration = 0): Promise<void> {
      while (true) {
        await latestPromptSettlement;
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

        await latestPromptSettlement;
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
      pendingGenerationPromises.clear();
      removeController();
      session.prompt = originalPrompt;
      if (typeof originalDispose === "function") {
        session.dispose = originalDispose;
      }
      delete sessionState[RECOVERY_MODE_SYMBOL];
    },
  };

  const unsubscribe = options.runtime.events.subscribe((event) => {
    if (disposed || event.sessionId !== sessionId) {
      return;
    }
    if (event.type === "session_shutdown") {
      controller.dispose();
      return;
    }
    if (event.type !== "session_compact" || seenCompactionEventIds.has(event.id)) {
      return;
    }

    seenCompactionEventIds.add(event.id);
    requestedGeneration += 1;
    const generation = requestedGeneration;
    const attempt = transitionCoordinator.getFailureCount(sessionId, "compaction_retry") + 1;
    const previousGeneration =
      pendingGenerationPromises.get(generation - 1)?.catch(() => undefined) ?? Promise.resolve();

    if (transitionCoordinator.isBreakerOpen(sessionId, "compaction_retry")) {
      completedGeneration = Math.max(completedGeneration, generation);
      recordSessionTurnTransition(options.runtime, {
        sessionId,
        turn: event.turn,
        reason: "compaction_retry",
        status: "skipped",
        attempt,
        sourceEventId: event.id,
        sourceEventType: event.type,
        breakerOpen: true,
      });
      const skippedGeneration = previousGeneration.then(() => undefined);
      pendingGenerationPromises.set(generation, skippedGeneration);
      return;
    }

    recordSessionTurnTransition(options.runtime, {
      sessionId,
      turn: event.turn,
      reason: "compaction_retry",
      status: "entered",
      attempt,
      sourceEventId: event.id,
      sourceEventType: event.type,
    });

    const currentGeneration = previousGeneration.then(async () => {
      await latestPromptSettlement;
      await waitForCompactionToFinish(session);
      await session.agent.waitForIdle();

      try {
        await dispatchResumePrompt({
          session,
          dispatchPrompt,
        });
        completedGeneration = Math.max(completedGeneration, generation);
        recordSessionTurnTransition(options.runtime, {
          sessionId,
          turn: event.turn,
          reason: "compaction_retry",
          status: "completed",
          attempt,
          sourceEventId: event.id,
          sourceEventType: event.type,
        });
      } catch (error) {
        completedGeneration = Math.max(completedGeneration, generation);
        recordSessionTurnTransition(options.runtime, {
          sessionId,
          turn: event.turn,
          reason: "compaction_retry",
          status: "failed",
          attempt,
          sourceEventId: event.id,
          sourceEventType: event.type,
          error: normalizeRuntimeError(error),
        });
        throw error;
      }
    });

    pendingGenerationPromises.set(generation, currentGeneration);
    void currentGeneration.catch(() => undefined);
  });

  store.set(sessionId, controller);
  return controller;
}

function getOrInstallCompactionRecovery(
  session: CompactionRecoverySessionLike,
  options: CompactionRecoveryOptions,
): InstalledCompactionRecoveryController | undefined {
  if (!options.runtime) {
    return undefined;
  }
  return createCompactionRecoveryController(session, {
    runtime: options.runtime,
    sessionId: options.sessionId,
  });
}

async function sendPromptWithBackgroundCompactionRecovery(
  session: CompactionRecoverySessionLike,
  prompt: string,
  options: CompactionRecoveryOptions = {},
): Promise<void> {
  const controller = getOrInstallCompactionRecovery(session, options);
  if (controller) {
    await controller.dispatchPrompt(prompt, options.promptOptions);
    return;
  }
  await session.prompt(prompt, options.promptOptions);
}

async function handlePromptRecoveryFailure(input: {
  runtime: BrewvaRuntime;
  session: CompactionRecoverySessionLike;
  sessionId: string;
  prompt: string;
  promptOptions?: PromptDispatchOptions;
  error: unknown;
  controller?: InstalledCompactionRecoveryController;
  afterGeneration: number;
  operatorVisibleCheckpoint: number;
}): Promise<void> {
  const transitionCoordinator = getHostedTurnTransitionCoordinator(input.runtime);
  let currentError: unknown = input.error;

  for (const policy of PROMPT_RECOVERY_POLICIES) {
    if (
      transitionCoordinator.hasOperatorVisibleFactSince(
        input.sessionId,
        input.operatorVisibleCheckpoint,
      )
    ) {
      throw currentError;
    }
    const result = await policy.execute({
      runtime: input.runtime,
      session: input.session,
      sessionId: input.sessionId,
      prompt: input.prompt,
      promptOptions: input.promptOptions,
      error: currentError,
      message: normalizeRuntimeError(currentError),
      controller: input.controller,
      transitionCoordinator,
      afterGeneration: input.afterGeneration,
      operatorVisibleCheckpoint: input.operatorVisibleCheckpoint,
    });
    if (result.decision === "recovered") {
      return;
    }
    if ("nextError" in result) {
      currentError = result.nextError;
    }
  }

  throw currentError;
}

export function installSessionCompactionRecovery<T extends CompactionRecoverySessionLike>(
  session: T,
  options: {
    runtime: BrewvaRuntime;
    sessionId?: string;
  },
): T {
  const controller = getOrInstallCompactionRecovery(session, options);
  controller?.installMode("background");
  return session;
}

export async function sendPromptWithCompactionRecovery(
  session: CompactionRecoverySessionLike,
  prompt: string,
  options: CompactionRecoveryOptions = {},
): Promise<void> {
  const controller = getOrInstallCompactionRecovery(session, options);
  const afterGeneration = controller?.getRequestedGeneration() ?? 0;
  const sessionId = options.sessionId?.trim() || normalizeSessionId(session);
  const operatorVisibleCheckpoint =
    options.runtime && sessionId
      ? getHostedTurnTransitionCoordinator(options.runtime).captureOperatorVisibleCheckpoint(
          sessionId,
        )
      : null;

  try {
    if (controller) {
      await controller.dispatchPrompt(prompt, options.promptOptions);
    } else {
      await session.prompt(prompt, options.promptOptions);
    }
  } catch (error) {
    let recovered = false;
    if (options.runtime) {
      if (
        sessionId &&
        (operatorVisibleCheckpoint === null ||
          !getHostedTurnTransitionCoordinator(options.runtime).hasOperatorVisibleFactSince(
            sessionId,
            operatorVisibleCheckpoint,
          ))
      ) {
        if (operatorVisibleCheckpoint === null) {
          throw error;
        }
        await handlePromptRecoveryFailure({
          runtime: options.runtime,
          session,
          sessionId,
          prompt,
          promptOptions: options.promptOptions,
          error,
          controller,
          afterGeneration,
          operatorVisibleCheckpoint,
        });
        recovered = true;
      }
    }
    if (!recovered) {
      throw error;
    }
  }

  if (!controller) {
    return;
  }
  if (
    session.isStreaming === true &&
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
  const controller = getOrInstallCompactionRecovery(session, options);
  controller?.installMode("settled");
  return session;
}

export const COMPACTION_RECOVERY_TEST_ONLY = {
  COMPACTION_RESUME_PROMPT,
  MAX_OUTPUT_RECOVERY_PROMPT,
  PROVIDER_FALLBACK_RECOVERY_PROMPT,
  PROMPT_RECOVERY_POLICIES,
};
