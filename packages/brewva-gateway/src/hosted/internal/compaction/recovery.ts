import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import {
  buildBrewvaPromptText,
  type BrewvaPromptContentPart,
} from "@brewva/brewva-substrate/prompt";
import {
  BrewvaPromptDispatchSession,
  BrewvaPromptOptions,
  BrewvaPromptThinkingLevel,
  BrewvaSessionModelCatalogView,
  BrewvaSessionModelDescriptor,
} from "@brewva/brewva-substrate/session";
import { selectBrewvaFallbackModel } from "../../../policy/model-routing/api.js";
import {
  looksLikeMaxOutputError,
  looksLikeRetryableProviderError,
  normalizeRuntimeError,
} from "../thread-loop/error-classification.js";
import { dispatchHostedPromptAttempt } from "../thread-loop/hosted-prompt-attempt.js";
import {
  armNextPromptOutputBudgetEscalation,
  clearNextPromptOutputBudgetEscalation,
} from "../thread-loop/recovery/output-budget-state.js";
import { getHostedRecoveryProjection } from "../thread-loop/recovery/projection.js";
import {
  COMPACTION_RESUME_PROMPT,
  MAX_OUTPUT_RECOVERY_PROMPT,
  PROVIDER_FALLBACK_RECOVERY_PROMPT,
} from "../thread-loop/recovery/prompts.js";
import type { ThreadLoopRecoveryPolicyName } from "../thread-loop/state.js";
import {
  getHostedTurnTransitionCoordinator,
  recordSessionTurnTransition,
} from "../thread-loop/turn-transition.js";
import {
  FALLBACK_MODEL_DOWNSHIFT_COMPACTION_INSTRUCTIONS,
  requestCompactionAndWait,
  shouldCompactForModelDownshift,
} from "./model-downshift-policy.js";

const controllerStoreByRuntime = new WeakMap<
  BrewvaHostedRuntimePort,
  Map<string, InstalledCompactionRecoveryController>
>();

type PromptRecoveryResult = { decision: "recovered" | "continue"; nextError?: unknown };
export type CompactionRecoverySessionLike = BrewvaPromptDispatchSession;

type FallbackComparableModel = Parameters<typeof selectBrewvaFallbackModel>[0]["currentModel"] &
  BrewvaSessionModelDescriptor;

interface ModelAwarePromptDispatchSession extends BrewvaPromptDispatchSession {
  readonly model?: BrewvaSessionModelDescriptor;
  readonly thinkingLevel?: BrewvaPromptThinkingLevel;
  readonly modelRegistry?: BrewvaSessionModelCatalogView;
  readonly getAvailableThinkingLevels?: () => BrewvaPromptThinkingLevel[];
  readonly setModel?: (model: BrewvaSessionModelDescriptor) => Promise<void> | void;
  readonly setThinkingLevel?: (level: BrewvaPromptThinkingLevel) => void;
  readonly requestCompaction?: (request?: {
    customInstructions?: string;
    onComplete?: (event: unknown) => void;
    onError?: (error: Error) => void;
  }) => void;
  readonly waitForIdle?: () => Promise<void>;
}

interface InstalledCompactionRecoveryController {
  readonly sessionId: string;
  readonly rawSession: CompactionRecoverySessionLike;
  readonly runtime: BrewvaHostedRuntimePort;
  getRequestedGeneration(): number;
  getCompletedGeneration(): number;
  waitForSettled(afterGeneration?: number): Promise<void>;
  dispose(): void;
  installMode(mode: "background" | "settled"): void;
  dispatchPrompt(
    content: readonly BrewvaPromptContentPart[],
    promptOptions?: BrewvaPromptOptions,
  ): Promise<void>;
}

export interface CompactionRecoveryOptions {
  runtime?: BrewvaHostedRuntimePort;
  sessionId?: string;
  promptOptions?: BrewvaPromptOptions;
}

interface PromptRecoveryContext {
  runtime: BrewvaHostedRuntimePort;
  session: CompactionRecoverySessionLike;
  sessionId: string;
  parts: readonly BrewvaPromptContentPart[];
  prompt: string;
  promptOptions?: BrewvaPromptOptions;
  error: unknown;
  message: string;
  controller?: InstalledCompactionRecoveryController;
  dispatchPrompt: (
    content: readonly BrewvaPromptContentPart[],
    promptOptions?: BrewvaPromptOptions,
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
  runtime: BrewvaHostedRuntimePort,
): Map<string, InstalledCompactionRecoveryController> {
  const existing = controllerStoreByRuntime.get(runtime);
  if (existing) {
    return existing;
  }
  const created = new Map<string, InstalledCompactionRecoveryController>();
  controllerStoreByRuntime.set(runtime, created);
  return created;
}

function readCurrentModel(
  session: CompactionRecoverySessionLike,
): BrewvaSessionModelDescriptor | undefined {
  return (session as ModelAwarePromptDispatchSession).model;
}

function toFallbackComparableModel(model: BrewvaSessionModelDescriptor): FallbackComparableModel {
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

function formatModelKey(model: BrewvaSessionModelDescriptor | undefined): string | null {
  if (!model) {
    return null;
  }
  return `${model.provider}/${model.id}`;
}

async function listAvailableModels(
  session: CompactionRecoverySessionLike,
): Promise<BrewvaSessionModelDescriptor[]> {
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
  preferredLevel: BrewvaPromptThinkingLevel | undefined,
): BrewvaPromptThinkingLevel {
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

async function compactBeforeModelDownshift(input: {
  runtime: BrewvaHostedRuntimePort;
  session: CompactionRecoverySessionLike;
  controller: InstalledCompactionRecoveryController;
  sessionId: string;
  currentModel: BrewvaSessionModelDescriptor;
  targetModel: BrewvaSessionModelDescriptor;
}): Promise<void> {
  if (!shouldCompactForModelDownshift(input)) {
    return;
  }

  const requestCompaction = (input.session as ModelAwarePromptDispatchSession).requestCompaction;
  if (typeof requestCompaction !== "function") {
    return;
  }

  const afterGeneration = input.controller.getRequestedGeneration();
  await requestCompactionAndWait(requestCompaction.bind(input.session), {
    customInstructions: FALLBACK_MODEL_DOWNSHIFT_COMPACTION_INSTRUCTIONS,
  });
  await input.controller.waitForSettled(afterGeneration);
}

async function withTemporaryModel<T>(
  session: CompactionRecoverySessionLike,
  model: BrewvaSessionModelDescriptor,
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
    promptOptions?: BrewvaPromptOptions,
  ) => Promise<void>;
}): Promise<void> {
  const promptOptions: BrewvaPromptOptions = {
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
    promptOptions?: BrewvaPromptOptions,
  ) => Promise<void>;
}): Promise<void> {
  const promptOptions: BrewvaPromptOptions = {
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
    const recoveryProjection = getHostedRecoveryProjection(input.runtime).getSnapshot(
      input.sessionId,
    );
    if (
      !input.controller ||
      !currentModel ||
      currentModel.maxTokens <= 0 ||
      !recoveryProjection.providerRequestRecoveryInstalled
    ) {
      recordSessionTurnTransition(input.runtime, {
        sessionId: input.sessionId,
        reason: "output_budget_escalation",
        status: "skipped",
        error:
          !recoveryProjection.providerRequestRecoveryInstalled &&
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
      if (currentModel) {
        await compactBeforeModelDownshift({
          runtime: input.runtime,
          session: input.session,
          controller: input.controller,
          sessionId: input.sessionId,
          currentModel,
          targetModel: fallbackModel,
        });
      }
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
    runtime: BrewvaHostedRuntimePort;
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
    promptOptions?: BrewvaPromptOptions,
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
      promptOptions?: BrewvaPromptOptions,
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

  const unsubscribe = options.runtime.inspect.events.records.subscribe((event) => {
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
  readonly runtime: BrewvaHostedRuntimePort;
  readonly session: CompactionRecoverySessionLike;
  readonly sessionId: string;
  readonly policy: ThreadLoopRecoveryPolicyName;
  readonly parts: readonly BrewvaPromptContentPart[];
  readonly promptOptions?: BrewvaPromptOptions;
  readonly error: unknown;
  readonly afterGeneration: number;
  readonly operatorVisibleCheckpoint: number;
  readonly dispatchPrompt: (
    content: readonly BrewvaPromptContentPart[],
    promptOptions?: BrewvaPromptOptions,
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
    runtime: BrewvaHostedRuntimePort;
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

export { COMPACTION_RESUME_PROMPT };

export const COMPACTION_RECOVERY_TEST_ONLY = {
  COMPACTION_RESUME_PROMPT,
  MAX_OUTPUT_RECOVERY_PROMPT,
  PROVIDER_FALLBACK_RECOVERY_PROMPT,
  PROMPT_RECOVERY_POLICIES,
};
