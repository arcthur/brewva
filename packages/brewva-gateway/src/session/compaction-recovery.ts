import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  buildBrewvaPromptText,
  type BrewvaPromptContentPart,
  BrewvaPromptOptions,
  BrewvaPromptThinkingLevel,
  BrewvaSessionModelCatalogView,
  BrewvaSessionModelDescriptor,
} from "@brewva/brewva-substrate";
import { selectBrewvaFallbackModel } from "@brewva/brewva-tools";
import type { CompactionGenerationCoordinator } from "./compaction-generation-coordinator.js";
import type { PromptDispatchSession } from "./contracts.js";
import {
  looksLikeMaxOutputError,
  looksLikeRetryableProviderError,
  normalizeRuntimeError,
} from "./error-classification.js";
import { dispatchHostedPromptAttempt } from "./hosted-prompt-attempt.js";
import {
  armNextPromptOutputBudgetEscalation,
  clearNextPromptOutputBudgetEscalation,
  hasProviderRequestRecoveryInstalled,
} from "./prompt-recovery-state.js";
import type { ThreadLoopRecoveryPolicyName } from "./thread-loop-types.js";
import {
  getHostedTurnTransitionCoordinator,
  recordSessionTurnTransition,
} from "./turn-transition.js";

export const COMPACTION_RESUME_PROMPT =
  "Context compaction completed. Resume the interrupted turn from the current task and evidence state. Do not repeat completed tool side effects unless required for correctness. Finish the pending response.";
const MAX_OUTPUT_RECOVERY_PROMPT =
  "The previous assistant response exceeded the output budget. Continue from the current task and evidence state, but finish more concisely. Do not repeat prior content or replay completed tool side effects. Deliver only the highest-value remaining answer.";
const PROVIDER_FALLBACK_RECOVERY_PROMPT =
  "The previous model request failed before the turn could complete. Continue from the current task and evidence state. Do not repeat completed tool side effects. Resume the pending response.";

const controllerStoreByRuntime = new WeakMap<
  BrewvaRuntime,
  Map<string, InstalledCompactionRecoveryController>
>();

type PromptDispatchOptions = BrewvaPromptOptions;
type PromptRecoveryDecision = "recovered" | "continue";
interface PromptRecoveryResult {
  decision: PromptRecoveryDecision;
  nextError?: unknown;
}

export type CompactionRecoverySessionLike = PromptDispatchSession;

type PromptSessionModel = BrewvaSessionModelDescriptor;
type PromptSessionThinkingLevel = BrewvaPromptThinkingLevel;
type FallbackComparableModel = Parameters<typeof selectBrewvaFallbackModel>[0]["currentModel"] &
  PromptSessionModel;

interface ModelAwarePromptDispatchSession extends PromptDispatchSession {
  readonly model?: PromptSessionModel;
  readonly thinkingLevel?: PromptSessionThinkingLevel;
  readonly modelRegistry?: BrewvaSessionModelCatalogView;
  readonly getAvailableThinkingLevels?: () => PromptSessionThinkingLevel[];
  readonly setModel?: (model: PromptSessionModel) => Promise<void> | void;
  readonly setThinkingLevel?: (level: PromptSessionThinkingLevel) => void;
  readonly waitForIdle?: () => Promise<void>;
}

interface InstalledCompactionRecoveryController extends CompactionGenerationCoordinator {
  dispatchPrompt(
    content: readonly BrewvaPromptContentPart[],
    promptOptions?: PromptDispatchOptions,
  ): Promise<void>;
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
  parts: readonly BrewvaPromptContentPart[];
  prompt: string;
  promptOptions?: PromptDispatchOptions;
  error: unknown;
  message: string;
  controller?: InstalledCompactionRecoveryController;
  dispatchPrompt: (
    content: readonly BrewvaPromptContentPart[],
    promptOptions?: PromptDispatchOptions,
  ) => Promise<void>;
  transitionCoordinator: ReturnType<typeof getHostedTurnTransitionCoordinator>;
  afterGeneration: number;
  operatorVisibleCheckpoint: number;
}

interface PromptRecoveryPolicy {
  readonly name: ThreadLoopRecoveryPolicyName;
  execute(input: PromptRecoveryContext): Promise<PromptRecoveryResult>;
}

function buildTextPromptParts(text: string): BrewvaPromptContentPart[] {
  return [{ type: "text", text }];
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

function readCurrentModel(session: CompactionRecoverySessionLike): PromptSessionModel | undefined {
  return (session as ModelAwarePromptDispatchSession).model;
}

function toFallbackComparableModel(model: PromptSessionModel): FallbackComparableModel {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name ?? model.displayName ?? model.id,
    api: model.api ?? "openai-responses",
    baseUrl: model.baseUrl ?? "",
    reasoning: model.reasoning,
    input: model.input ?? ["text"],
    cost: model.cost ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.headers ? { headers: model.headers } : {}),
    ...(model.compat != null ? { compat: model.compat } : {}),
    ...(model.displayName ? { displayName: model.displayName } : {}),
  };
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
    return [...(await modelRegistry.getAvailable())];
  }
  if (typeof modelRegistry?.getAll === "function") {
    return [...modelRegistry.getAll()];
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
  await typedSession.setModel?.(model);
  typedSession.setThinkingLevel?.(resolveFallbackThinkingLevel(session, previousThinkingLevel));
  try {
    return await fn();
  } finally {
    if (previousModel) {
      await typedSession.setModel?.(previousModel);
    }
    typedSession.setThinkingLevel?.(previousThinkingLevel);
  }
}

async function dispatchMaxOutputRecoveryPrompt(input: {
  session: CompactionRecoverySessionLike;
  dispatchPrompt: (
    content: readonly BrewvaPromptContentPart[],
    promptOptions?: PromptDispatchOptions,
  ) => Promise<void>;
}): Promise<void> {
  const promptOptions: PromptDispatchOptions = {
    expandPromptTemplates: false,
    source: "extension",
    ...(input.session.isStreaming === true ? { streamingBehavior: "followUp" as const } : {}),
  };
  await input.dispatchPrompt(buildTextPromptParts(MAX_OUTPUT_RECOVERY_PROMPT), promptOptions);
}

async function dispatchProviderFallbackRecoveryPrompt(input: {
  session: CompactionRecoverySessionLike;
  dispatchPrompt: (
    content: readonly BrewvaPromptContentPart[],
    promptOptions?: PromptDispatchOptions,
  ) => Promise<void>;
}): Promise<void> {
  const promptOptions: PromptDispatchOptions = {
    expandPromptTemplates: false,
    source: "extension",
    ...(input.session.isStreaming === true ? { streamingBehavior: "followUp" as const } : {}),
  };
  await input.dispatchPrompt(
    buildTextPromptParts(PROVIDER_FALLBACK_RECOVERY_PROMPT),
    promptOptions,
  );
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
      await input.dispatchPrompt(input.parts, input.promptOptions);
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
          currentModel: toFallbackComparableModel(currentModel),
          availableModels: (await listAvailableModels(input.session)).map(
            toFallbackComparableModel,
          ),
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
          dispatchPrompt: input.dispatchPrompt,
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
        dispatchPrompt: input.dispatchPrompt,
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
  // Capture the original prompt only for explicit coordinator dispatch. Installing
  // the coordinator must not mutate session.prompt.
  const basePrompt: CompactionRecoverySessionLike["prompt"] = (content, promptOptions) =>
    dispatchHostedPromptAttempt(session, content, promptOptions);
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
    content: readonly BrewvaPromptContentPart[],
    promptOptions?: PromptDispatchOptions,
  ): Promise<void> => {
    const promptPromise = basePrompt(content, promptOptions);
    latestPromptSettlement = promptPromise.then(
      () => undefined,
      () => undefined,
    );
    return await promptPromise;
  };

  const controller: InstalledCompactionRecoveryController = {
    sessionId,
    runtime: options.runtime,
    rawSession: session,
    getRequestedGeneration() {
      return requestedGeneration;
    },
    getCompletedGeneration() {
      return completedGeneration;
    },
    installMode(_mode) {
      return;
    },
    async dispatchPrompt(
      content: readonly BrewvaPromptContentPart[],
      promptOptions?: PromptDispatchOptions,
    ): Promise<void> {
      return await dispatchPrompt(content, promptOptions);
    },
    async waitForSettled(afterGeneration = 0): Promise<void> {
      while (true) {
        await latestPromptSettlement;
        await waitForCompactionToFinish(session);
        await session.waitForIdle?.();

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
        await session.waitForIdle?.();

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
    },
  };

  const unsubscribe = options.runtime.inspect.events.subscribe((event) => {
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
    const previousGeneration =
      pendingGenerationPromises.get(generation - 1)?.catch(() => undefined) ?? Promise.resolve();

    const currentGeneration = previousGeneration.then(async () => {
      await latestPromptSettlement;
      await waitForCompactionToFinish(session);
      await session.waitForIdle?.();
      completedGeneration = Math.max(completedGeneration, generation);
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

export type PromptRecoveryPolicyApplicationResult =
  | {
      readonly outcome: "recovered";
      readonly policy: ThreadLoopRecoveryPolicyName;
    }
  | {
      readonly outcome: "continued";
      readonly policy: ThreadLoopRecoveryPolicyName;
      readonly error: unknown;
    }
  | {
      readonly outcome: "aborted";
      readonly policy: ThreadLoopRecoveryPolicyName;
      readonly error: unknown;
    };

export async function applyPromptRecoveryPolicy(input: {
  readonly runtime: BrewvaRuntime;
  readonly session: CompactionRecoverySessionLike;
  readonly sessionId: string;
  readonly policy: ThreadLoopRecoveryPolicyName;
  readonly parts: readonly BrewvaPromptContentPart[];
  readonly promptOptions?: PromptDispatchOptions;
  readonly error: unknown;
  readonly afterGeneration: number;
  readonly operatorVisibleCheckpoint: number;
  readonly dispatchPrompt: (
    content: readonly BrewvaPromptContentPart[],
    promptOptions?: PromptDispatchOptions,
  ) => Promise<void>;
}): Promise<PromptRecoveryPolicyApplicationResult> {
  const policy = PROMPT_RECOVERY_POLICIES.find((candidate) => candidate.name === input.policy);
  if (!policy) {
    return {
      outcome: "continued",
      policy: input.policy,
      error: input.error,
    };
  }
  const transitionCoordinator = getHostedTurnTransitionCoordinator(input.runtime);
  if (
    transitionCoordinator.hasOperatorVisibleFactSince(
      input.sessionId,
      input.operatorVisibleCheckpoint,
    )
  ) {
    return {
      outcome: "aborted",
      policy: input.policy,
      error: input.error,
    };
  }
  const controller = getOrInstallCompactionRecovery(input.session, {
    runtime: input.runtime,
    sessionId: input.sessionId,
  });
  try {
    const result = await policy.execute({
      runtime: input.runtime,
      session: input.session,
      sessionId: input.sessionId,
      parts: input.parts,
      prompt: buildBrewvaPromptText(input.parts),
      promptOptions: input.promptOptions,
      error: input.error,
      message: normalizeRuntimeError(input.error),
      controller,
      dispatchPrompt: input.dispatchPrompt,
      transitionCoordinator,
      afterGeneration: input.afterGeneration,
      operatorVisibleCheckpoint: input.operatorVisibleCheckpoint,
    });
    if (result.decision === "recovered") {
      return {
        outcome: "recovered",
        policy: input.policy,
      };
    }
    return {
      outcome: "continued",
      policy: input.policy,
      error: result.nextError ?? input.error,
    };
  } catch (error) {
    return {
      outcome: "aborted",
      policy: input.policy,
      error,
    };
  }
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

export function getCompactionGenerationState(
  session: CompactionRecoverySessionLike,
  options: CompactionRecoveryOptions = {},
): {
  readonly requestedGeneration: number;
  readonly completedGeneration: number;
} {
  const controller = getOrInstallCompactionRecovery(session, options);
  return {
    requestedGeneration: controller?.getRequestedGeneration() ?? 0,
    completedGeneration: controller?.getCompletedGeneration() ?? 0,
  };
}

export async function dispatchPromptWithCompactionSettlement(
  session: CompactionRecoverySessionLike,
  prompt: readonly BrewvaPromptContentPart[],
  options: CompactionRecoveryOptions = {},
): Promise<void> {
  const controller = getOrInstallCompactionRecovery(session, options);
  const afterGeneration = controller?.getRequestedGeneration() ?? 0;
  if (controller) {
    await controller.dispatchPrompt(prompt, options.promptOptions);
  } else {
    await dispatchHostedPromptAttempt(session, prompt, options.promptOptions);
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

export const COMPACTION_RECOVERY_TEST_ONLY = {
  COMPACTION_RESUME_PROMPT,
  MAX_OUTPUT_RECOVERY_PROMPT,
  PROVIDER_FALLBACK_RECOVERY_PROMPT,
  PROMPT_RECOVERY_POLICIES,
};
