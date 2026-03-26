import type {
  BrewvaRuntime,
  ContextCompactionGateStatus,
  ContextInjectionEntry,
} from "@brewva/brewva-runtime";
import { CONTEXT_COMPOSED_EVENT_TYPE, coerceContextBudgetUsage } from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { prepareContextComposerSupport } from "./context-composer-support.js";
import {
  buildContextComposedEventPayload,
  composeContextBlocks,
  resolveSupplementalContextBlocks,
} from "./context-composer.js";
import { applyContextContract } from "./context-contract.js";
import {
  extractCompactionEntryId,
  extractCompactionSummary,
  resolveInjectionScopeId,
} from "./context-shared.js";
import { appendSupplementalContextBlocks } from "./context-supplemental.js";
import { clearRuntimeTurnClock, observeRuntimeTurnStart } from "./runtime-turn-clock.js";

const CONTEXT_INJECTION_MESSAGE_TYPE = "brewva-context-injection";

export interface ContextTransformOptions {
  autoCompactionWatchdogMs?: number;
}

export interface ContextTransformLifecycle {
  turnStart: (event: unknown, ctx: unknown) => undefined;
  context: (event: unknown, ctx: unknown) => undefined;
  sessionCompact: (event: unknown, ctx: unknown) => undefined;
  sessionShutdown: (event: unknown, ctx: unknown) => undefined;
  beforeAgentStart: (event: unknown, ctx: unknown) => Promise<Record<string, unknown>>;
}

interface CompactionGateState {
  turnIndex: number;
  lastRuntimeGateRequired: boolean;
  autoCompactionInFlight: boolean;
  autoCompactionWatchdog: ReturnType<typeof setTimeout> | null;
  deferredAutoCompactionReason: string | null;
}

const DEFAULT_AUTO_COMPACTION_WATCHDOG_MS = 30_000;
const AUTO_COMPACTION_WATCHDOG_ERROR = "auto_compaction_watchdog_timeout";

function getOrCreateGateState(
  store: Map<string, CompactionGateState>,
  sessionId: string,
): CompactionGateState {
  const existing = store.get(sessionId);
  if (existing) return existing;
  const created: CompactionGateState = {
    turnIndex: 0,
    lastRuntimeGateRequired: false,
    autoCompactionInFlight: false,
    autoCompactionWatchdog: null,
    deferredAutoCompactionReason: null,
  };
  store.set(sessionId, created);
  return created;
}

function clearAutoCompactionState(state: CompactionGateState): void {
  state.autoCompactionInFlight = false;
  state.deferredAutoCompactionReason = null;
  if (state.autoCompactionWatchdog) {
    clearTimeout(state.autoCompactionWatchdog);
    state.autoCompactionWatchdog = null;
  }
}

function emitRuntimeEvent(
  runtime: BrewvaRuntime,
  input: {
    sessionId: string;
    turn: number;
    type: string;
    payload: Record<string, unknown>;
  },
): void {
  runtime.events.record({
    sessionId: input.sessionId,
    turn: input.turn,
    type: input.type,
    payload: input.payload,
  });
}

function emitContextComposedEvent(
  runtime: BrewvaRuntime,
  input: {
    sessionId: string;
    turn: number;
    composed: ReturnType<typeof composeContextBlocks>;
    injectionAccepted: boolean;
  },
): void {
  emitRuntimeEvent(runtime, {
    sessionId: input.sessionId,
    turn: input.turn,
    type: CONTEXT_COMPOSED_EVENT_TYPE,
    payload: buildContextComposedEventPayload(input.composed, input.injectionAccepted),
  });
}

function markSurfacedDelegationOutcomes(
  runtime: BrewvaRuntime,
  input: {
    sessionId: string;
    turn: number;
    runIds: readonly string[];
  },
): void {
  if (input.runIds.length === 0) {
    return;
  }
  const surfacedAt = Date.now();
  for (const runId of input.runIds) {
    const existing = runtime.session.getDelegationRun(input.sessionId, runId);
    if (!existing?.delivery || existing.delivery.handoffState !== "pending_parent_turn") {
      continue;
    }
    const updated = {
      ...existing,
      updatedAt: surfacedAt,
      delivery: {
        ...existing.delivery,
        handoffState: "surfaced" as const,
        surfacedAt,
        updatedAt: surfacedAt,
      },
    };
    runtime.session.recordDelegationRun(input.sessionId, updated);
    emitRuntimeEvent(runtime, {
      sessionId: input.sessionId,
      turn: input.turn,
      type: "subagent_delivery_surfaced",
      payload: {
        runId: updated.runId,
        delegate: updated.delegate,
        label: updated.label ?? null,
        kind: updated.kind ?? null,
        boundary: updated.boundary ?? null,
        parentSkill: updated.parentSkill ?? null,
        childSessionId: updated.workerSessionId ?? null,
        status: updated.status,
        summary: updated.summary ?? null,
        error: updated.error ?? null,
        artifactRefs: updated.artifactRefs ?? [],
        totalTokens: updated.totalTokens ?? null,
        costUsd: updated.costUsd ?? null,
        deliveryMode: updated.delivery.mode,
        deliveryScopeId: updated.delivery.scopeId ?? null,
        deliveryLabel: updated.delivery.label ?? null,
        deliveryHandoffState: updated.delivery.handoffState ?? null,
        deliveryReadyAt: updated.delivery.readyAt ?? null,
        deliverySurfacedAt: updated.delivery.surfacedAt ?? null,
        supplementalAppended: updated.delivery.supplementalAppended ?? null,
        deliveryUpdatedAt: updated.delivery.updatedAt ?? null,
      },
    });
  }
}

function normalizeRuntimeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  return "unknown_error";
}

async function resolveContextInjection(
  runtime: BrewvaRuntime,
  input: {
    sessionId: string;
    prompt: string;
    usage: ReturnType<typeof coerceContextBudgetUsage>;
    injectionScopeId?: string;
  },
): Promise<{
  text: string;
  entries: ContextInjectionEntry[];
  accepted: boolean;
  originalTokens: number;
  finalTokens: number;
  truncated: boolean;
}> {
  return runtime.context.buildInjection(
    input.sessionId,
    input.prompt,
    input.usage,
    input.injectionScopeId,
  );
}

export function createContextTransformLifecycle(
  pi: ExtensionAPI,
  runtime: BrewvaRuntime,
  options: ContextTransformOptions = {},
): ContextTransformLifecycle {
  const gateStateBySession = new Map<string, CompactionGateState>();
  const autoCompactionWatchdogMs = Math.max(
    1,
    Math.trunc(options.autoCompactionWatchdogMs ?? DEFAULT_AUTO_COMPACTION_WATCHDOG_MS),
  );

  return {
    turnStart(event, ctx) {
      const rawEvent = event as { turnIndex?: unknown; timestamp?: unknown };
      const sessionId = (
        ctx as { sessionManager: { getSessionId: () => string } }
      ).sessionManager.getSessionId();
      const state = getOrCreateGateState(gateStateBySession, sessionId);
      const runtimeTurn = observeRuntimeTurnStart(
        sessionId,
        Number(rawEvent.turnIndex ?? 0),
        Number(rawEvent.timestamp ?? Date.now()),
      );
      state.turnIndex = runtimeTurn;
      runtime.context.onTurnStart(sessionId, runtimeTurn);
      return undefined;
    },
    context(_event, ctx) {
      const sessionId = (
        ctx as {
          sessionManager: { getSessionId: () => string };
          hasUI?: boolean;
          isIdle?: () => boolean;
          getContextUsage?: () => unknown;
          compact?: (options: Record<string, unknown>) => void;
        }
      ).sessionManager.getSessionId();
      const state = getOrCreateGateState(gateStateBySession, sessionId);
      const usage = coerceContextBudgetUsage(
        typeof (ctx as { getContextUsage?: () => unknown }).getContextUsage === "function"
          ? (ctx as { getContextUsage: () => unknown }).getContextUsage()
          : undefined,
      );
      runtime.context.observeUsage(sessionId, usage);

      if (!runtime.context.checkAndRequestCompaction(sessionId, usage)) {
        return undefined;
      }

      if ((ctx as { hasUI?: boolean }).hasUI) {
        const idle =
          typeof (ctx as { isIdle?: () => boolean }).isIdle === "function"
            ? (ctx as { isIdle: () => boolean }).isIdle()
            : false;
        if (!idle) {
          const pendingReason =
            runtime.context.getPendingCompactionReason(sessionId) ?? "usage_threshold";
          if (state.deferredAutoCompactionReason === pendingReason) {
            return undefined;
          }
          state.deferredAutoCompactionReason = pendingReason;
          emitRuntimeEvent(runtime, {
            sessionId,
            turn: state.turnIndex,
            type: "context_compaction_skipped",
            payload: {
              reason: "agent_active_manual_compaction_unsafe",
            },
          });
          return undefined;
        }
        state.deferredAutoCompactionReason = null;

        if (state.autoCompactionInFlight) {
          emitRuntimeEvent(runtime, {
            sessionId,
            turn: state.turnIndex,
            type: "context_compaction_skipped",
            payload: {
              reason: "auto_compaction_in_flight",
            },
          });
          return undefined;
        }

        const pendingReason = runtime.context.getPendingCompactionReason(sessionId);
        const compactionReason = pendingReason ?? "usage_threshold";
        state.autoCompactionInFlight = true;
        if (state.autoCompactionWatchdog) {
          clearTimeout(state.autoCompactionWatchdog);
        }
        state.autoCompactionWatchdog = setTimeout(() => {
          if (!state.autoCompactionInFlight) return;
          clearAutoCompactionState(state);
          emitRuntimeEvent(runtime, {
            sessionId,
            turn: state.turnIndex,
            type: "context_compaction_auto_failed",
            payload: {
              reason: compactionReason,
              error: AUTO_COMPACTION_WATCHDOG_ERROR,
              watchdogMs: autoCompactionWatchdogMs,
            },
          });
        }, autoCompactionWatchdogMs);

        emitRuntimeEvent(runtime, {
          sessionId,
          turn: state.turnIndex,
          type: "context_compaction_auto_requested",
          payload: {
            reason: compactionReason,
            usagePercent: runtime.context.getUsageRatio(usage),
            tokens: usage?.tokens ?? null,
          },
        });

        const clearInFlight = () => {
          clearAutoCompactionState(state);
        };
        const recordAutoFailure = (error: unknown) => {
          emitRuntimeEvent(runtime, {
            sessionId,
            turn: state.turnIndex,
            type: "context_compaction_auto_failed",
            payload: {
              reason: compactionReason,
              error: normalizeRuntimeError(error),
            },
          });
        };

        try {
          (ctx as { compact: (options: Record<string, unknown>) => void }).compact({
            customInstructions: runtime.context.getCompactionInstructions(),
            onComplete: () => {
              clearInFlight();
              emitRuntimeEvent(runtime, {
                sessionId,
                turn: state.turnIndex,
                type: "context_compaction_auto_completed",
                payload: {
                  reason: compactionReason,
                },
              });
            },
            onError: (error: unknown) => {
              clearInFlight();
              recordAutoFailure(error);
            },
          });
        } catch (error) {
          clearInFlight();
          recordAutoFailure(error);
        }

        return undefined;
      }

      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "context_compaction_skipped",
        payload: {
          reason: "non_interactive_mode",
        },
      });

      return undefined;
    },
    sessionCompact(event, ctx) {
      const sessionId = (
        ctx as { sessionManager: { getSessionId: () => string }; getContextUsage?: () => unknown }
      ).sessionManager.getSessionId();
      const state = getOrCreateGateState(gateStateBySession, sessionId);
      const usage = coerceContextBudgetUsage(
        typeof (ctx as { getContextUsage?: () => unknown }).getContextUsage === "function"
          ? (ctx as { getContextUsage: () => unknown }).getContextUsage()
          : undefined,
      );
      const wasGated = state.lastRuntimeGateRequired;
      state.lastRuntimeGateRequired = false;
      clearAutoCompactionState(state);

      runtime.context.markCompacted(sessionId, {
        fromTokens: null,
        toTokens: usage?.tokens ?? null,
        summary: extractCompactionSummary(event as { compactionEntry?: unknown }),
        entryId: extractCompactionEntryId(event as { compactionEntry?: unknown }),
      });
      const compactionEntry = (event as { compactionEntry?: { id?: unknown } }).compactionEntry;
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "session_compact",
        payload: {
          entryId: typeof compactionEntry?.id === "string" ? compactionEntry.id : null,
          fromExtension:
            (event as { fromExtension?: unknown }).fromExtension === true ? true : undefined,
        },
      });

      if (wasGated) {
        emitRuntimeEvent(runtime, {
          sessionId,
          turn: state.turnIndex,
          type: "context_compaction_gate_cleared",
          payload: {
            reason: "session_compact_performed",
          },
        });
      }
      return undefined;
    },
    sessionShutdown(_event, ctx) {
      const sessionId = (
        ctx as { sessionManager: { getSessionId: () => string } }
      ).sessionManager.getSessionId();
      const state = gateStateBySession.get(sessionId);
      if (state) {
        clearAutoCompactionState(state);
      }
      gateStateBySession.delete(sessionId);
      clearRuntimeTurnClock(sessionId);
      return undefined;
    },
    async beforeAgentStart(event, ctx) {
      const rawEvent = event as { prompt?: unknown; systemPrompt?: unknown };
      const sessionId = (
        ctx as { sessionManager: { getSessionId: () => string }; getContextUsage?: () => unknown }
      ).sessionManager.getSessionId();
      const state = getOrCreateGateState(gateStateBySession, sessionId);
      const sessionManager = (ctx as { sessionManager: { getSessionId: () => string } })
        .sessionManager as Parameters<typeof resolveInjectionScopeId>[0];
      const injectionScopeId = resolveInjectionScopeId(sessionManager);
      const usage = coerceContextBudgetUsage(
        typeof (ctx as { getContextUsage?: () => unknown }).getContextUsage === "function"
          ? (ctx as { getContextUsage: () => unknown }).getContextUsage()
          : undefined,
      );
      runtime.context.observeUsage(sessionId, usage);
      const emitGateEvents = (
        gateStatus: ContextCompactionGateStatus,
        reason: "hard_limit",
      ): void => {
        emitRuntimeEvent(runtime, {
          sessionId,
          turn: state.turnIndex,
          type: "context_compaction_gate_armed",
          payload: {
            reason,
            usagePercent: gateStatus.pressure.usageRatio,
            hardLimitPercent: gateStatus.pressure.hardLimitRatio,
          },
        });
        emitRuntimeEvent(runtime, {
          sessionId,
          turn: state.turnIndex,
          type: "critical_without_compact",
          payload: {
            reason,
            usagePercent: gateStatus.pressure.usageRatio,
            hardLimitPercent: gateStatus.pressure.hardLimitRatio,
            contextPressure: gateStatus.pressure.level,
            requiredTool: "session_compact",
          },
        });
      };

      const prompt = typeof rawEvent.prompt === "string" ? rawEvent.prompt : "";
      let { gateStatus, pendingCompactionReason, capabilityView } = prepareContextComposerSupport({
        runtime,
        pi,
        sessionId,
        prompt,
        usage,
      });
      if (gateStatus.required) {
        emitGateEvents(gateStatus, "hard_limit");
      }
      const initialSupplementalBlocks = appendSupplementalContextBlocks(runtime, {
        sessionId,
        usage,
        injectionScopeId,
        blocks: [
          ...resolveSupplementalContextBlocks({
            runtime,
            sessionId,
            gateStatus,
            pendingCompactionReason,
            capabilityView,
          }),
        ],
      });
      const systemPromptWithContract = applyContextContract(
        rawEvent.systemPrompt,
        runtime,
        sessionId,
        usage,
      );
      const originalPrompt = prompt;

      if (gateStatus.required) {
        state.lastRuntimeGateRequired = true;
        const composed = composeContextBlocks({
          runtime,
          sessionId,
          gateStatus,
          pendingCompactionReason,
          capabilityView,
          admittedEntries: [],
          injectionAccepted: false,
          supplementalBlocks: initialSupplementalBlocks,
          includeDefaultSupplementalBlocks: false,
        });
        emitContextComposedEvent(runtime, {
          sessionId,
          turn: state.turnIndex,
          composed,
          injectionAccepted: false,
        });
        markSurfacedDelegationOutcomes(runtime, {
          sessionId,
          turn: state.turnIndex,
          runIds: composed.surfacedDelegationRunIds,
        });

        return {
          systemPrompt: systemPromptWithContract,
          message: {
            customType: CONTEXT_INJECTION_MESSAGE_TYPE,
            content: composed.content,
            display: false,
            details: {
              originalTokens: 0,
              finalTokens: 0,
              truncated: false,
              gateRequired: true,
              contextComposition: {
                narrativeRatio: composed.metrics.narrativeRatio,
                narrativeTokens: composed.metrics.narrativeTokens,
                constraintTokens: composed.metrics.constraintTokens,
                diagnosticTokens: composed.metrics.diagnosticTokens,
              },
              capabilityView: {
                requested: capabilityView.requested,
                detailNames: capabilityView.details.map((detail) => detail.name),
                missing: capabilityView.missing,
              },
            },
          },
        };
      }

      const injection = await resolveContextInjection(runtime, {
        sessionId,
        prompt: originalPrompt,
        usage,
        injectionScopeId,
      });
      const supportAfterInjection = prepareContextComposerSupport({
        runtime,
        pi,
        sessionId,
        prompt: originalPrompt,
        usage,
      });
      const gateStatusAfterInjection = supportAfterInjection.gateStatus;
      if (!gateStatus.required && gateStatusAfterInjection.required) {
        emitGateEvents(gateStatusAfterInjection, "hard_limit");
      }
      gateStatus = gateStatusAfterInjection;
      pendingCompactionReason = supportAfterInjection.pendingCompactionReason;
      capabilityView = supportAfterInjection.capabilityView;
      state.lastRuntimeGateRequired = gateStatus.required;
      const supplementalBlocks = appendSupplementalContextBlocks(runtime, {
        sessionId,
        usage,
        injectionScopeId,
        blocks: [
          ...resolveSupplementalContextBlocks({
            runtime,
            sessionId,
            gateStatus,
            pendingCompactionReason,
            capabilityView,
          }),
        ],
      });

      if (pendingCompactionReason && !gateStatus.required) {
        emitRuntimeEvent(runtime, {
          sessionId,
          turn: state.turnIndex,
          type: "context_compaction_advisory",
          payload: {
            reason: pendingCompactionReason,
            usagePercent: gateStatus.pressure.usageRatio,
            compactionThresholdPercent: gateStatus.pressure.compactionThresholdRatio,
            hardLimitPercent: gateStatus.pressure.hardLimitRatio,
            contextPressure: gateStatus.pressure.level,
            requiredTool: "session_compact",
          },
        });
      }
      const composed = composeContextBlocks({
        runtime,
        sessionId,
        gateStatus,
        pendingCompactionReason,
        capabilityView,
        admittedEntries: injection.entries,
        injectionAccepted: injection.accepted,
        supplementalBlocks,
        includeDefaultSupplementalBlocks: false,
      });
      emitContextComposedEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        composed,
        injectionAccepted: injection.accepted,
      });
      markSurfacedDelegationOutcomes(runtime, {
        sessionId,
        turn: state.turnIndex,
        runIds: composed.surfacedDelegationRunIds,
      });

      return {
        systemPrompt: systemPromptWithContract,
        message: {
          customType: CONTEXT_INJECTION_MESSAGE_TYPE,
          content: composed.content,
          display: false,
          details: {
            originalTokens: injection.originalTokens,
            finalTokens: injection.finalTokens,
            truncated: injection.truncated,
            gateRequired: gateStatus.required,
            contextComposition: {
              narrativeRatio: composed.metrics.narrativeRatio,
              narrativeTokens: composed.metrics.narrativeTokens,
              constraintTokens: composed.metrics.constraintTokens,
              diagnosticTokens: composed.metrics.diagnosticTokens,
            },
            capabilityView: {
              requested: capabilityView.requested,
              detailNames: capabilityView.details.map((detail) => detail.name),
              missing: capabilityView.missing,
            },
          },
        },
      };
    },
  };
}

export function registerContextTransform(
  pi: ExtensionAPI,
  runtime: BrewvaRuntime,
  options: ContextTransformOptions = {},
): void {
  const hooks = pi as unknown as {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  };
  const lifecycle = createContextTransformLifecycle(pi, runtime, options);
  hooks.on("turn_start", lifecycle.turnStart);
  hooks.on("context", lifecycle.context);
  hooks.on("session_compact", lifecycle.sessionCompact);
  hooks.on("session_shutdown", lifecycle.sessionShutdown);
  hooks.on("before_agent_start", lifecycle.beforeAgentStart);
}
