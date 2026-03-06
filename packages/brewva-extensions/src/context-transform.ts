import {
  coerceContextBudgetUsage,
  type ContextCompactionGateStatus,
  type ContextPressureStatus,
  type BrewvaRuntime,
} from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ToolInfo } from "@mariozechner/pi-coding-agent";
import { buildCapabilityView } from "./capability-view.js";
import {
  extractCompactionEntryId,
  extractCompactionSummary,
  formatPercent,
  resolveInjectionScopeId,
} from "./context-shared.js";
import { clearRuntimeTurnClock, observeRuntimeTurnStart } from "./runtime-turn-clock.js";

const CONTEXT_INJECTION_MESSAGE_TYPE = "brewva-context-injection";
const CONTEXT_CONTRACT_MARKER = "[Brewva Context Contract]";
const MISSING_ROUTING_TRACE_REASON = "routing_trace_unavailable";

export interface ContextTransformOptions {
  autoCompactionWatchdogMs?: number;
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

function resolveRoutingProjection(
  runtime: BrewvaRuntime,
  sessionId: string,
): {
  selection: {
    status: string;
    reason: string;
    selectedCount: number;
    selectedSkills: string[];
  };
  error: string | null;
} {
  const trace = runtime.skills.getLastRouting(sessionId);
  if (!trace) {
    return {
      selection: {
        status: "skipped",
        reason: MISSING_ROUTING_TRACE_REASON,
        selectedCount: 0,
        selectedSkills: [],
      },
      error: null,
    };
  }
  return {
    selection: {
      status: trace.selection.status,
      reason: trace.selection.reason,
      selectedCount: trace.selection.selectedCount,
      selectedSkills: [...trace.selection.selectedSkills],
    },
    error: trace.error ?? null,
  };
}

function buildCompactionGateMessage(input: { pressure: ContextPressureStatus }): string {
  const usagePercent = formatPercent(input.pressure.usageRatio);
  const hardLimitPercent = formatPercent(input.pressure.hardLimitRatio);
  const reasonLine = "Context pressure is critical.";
  return [
    "[ContextCompactionGate]",
    reasonLine,
    `Current usage: ${usagePercent} (hard limit: ${hardLimitPercent}).`,
    "Call tool `session_compact` immediately before any other tool call.",
    "Do not run `session_compact` via `exec` or shell.",
  ].join("\n");
}

function buildTapeStatusBlock(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  gateStatus: ContextCompactionGateStatus;
  pendingCompactionReason?: string | null;
}): string {
  const tapeStatus = input.runtime.events.getTapeStatus(input.sessionId);
  const usagePercent = formatPercent(input.gateStatus.pressure.usageRatio);
  const hardLimitPercent = formatPercent(input.gateStatus.pressure.hardLimitRatio);
  const pendingReason = input.pendingCompactionReason ?? null;
  const action = input.gateStatus.required
    ? "session_compact_now"
    : pendingReason
      ? "session_compact_recommended"
      : "none";
  const tapePressure = tapeStatus.tapePressure;
  const totalEntries = String(tapeStatus.totalEntries);
  const entriesSinceAnchor = String(tapeStatus.entriesSinceAnchor);
  const entriesSinceCheckpoint = String(tapeStatus.entriesSinceCheckpoint);
  const lastAnchorName = tapeStatus.lastAnchor?.name ?? "none";
  const lastAnchorId = tapeStatus.lastAnchor?.id ?? "none";

  return [
    "[TapeStatus]",
    `tape_pressure: ${tapePressure}`,
    `tape_entries_total: ${totalEntries}`,
    `tape_entries_since_anchor: ${entriesSinceAnchor}`,
    `tape_entries_since_checkpoint: ${entriesSinceCheckpoint}`,
    `last_anchor_name: ${lastAnchorName}`,
    `last_anchor_id: ${lastAnchorId}`,
    `context_pressure: ${input.gateStatus.pressure.level}`,
    `context_usage: ${usagePercent}`,
    `context_hard_limit: ${hardLimitPercent}`,
    `compaction_gate_reason: ${input.gateStatus.reason ?? "none"}`,
    `pending_compaction_reason: ${pendingReason ?? "none"}`,
    `recent_compact_performed: ${input.gateStatus.recentCompaction ? "true" : "false"}`,
    `turns_since_compaction: ${input.gateStatus.turnsSinceCompaction ?? "none"}`,
    `recent_compaction_window_turns: ${input.gateStatus.windowTurns}`,
    `required_action: ${action}`,
  ].join("\n");
}

function buildCompactionAdvisoryMessage(input: {
  reason: string;
  pressure: ContextPressureStatus;
}): string {
  const usagePercent = formatPercent(input.pressure.usageRatio);
  const thresholdPercent = formatPercent(input.pressure.compactionThresholdRatio);
  return [
    "[ContextCompactionAdvisory]",
    `Pending compaction request: ${input.reason}.`,
    `Current usage: ${usagePercent} (compact-soon threshold: ${thresholdPercent}).`,
    "Prefer calling tool `session_compact` before long tool chains or broad repository scans.",
    "If no further tool work is needed, answer directly instead of compacting first.",
  ].join("\n");
}

function buildContextContractBlock(runtime: BrewvaRuntime): string {
  const tapeThresholds = runtime.events.getTapePressureThresholds();
  const hardLimitPercent = formatPercent(runtime.context.getHardLimitRatio());
  const highThresholdPercent = formatPercent(runtime.context.getCompactionThresholdRatio());

  return [
    CONTEXT_CONTRACT_MARKER,
    "You manage two independent resources.",
    "1) State tape:",
    "- use `tape_handoff` for semantic phase boundaries and handoffs.",
    "- use `tape_info` to inspect tape/context pressure.",
    "- use `tape_search` when you need historical recall.",
    `- tape_pressure is based on entries_since_anchor (low=${tapeThresholds.low}, medium=${tapeThresholds.medium}, high=${tapeThresholds.high}).`,
    "2) Message buffer (LLM context window):",
    "- use `session_compact` to reduce message history tokens.",
    `- context_pressure >= high (${highThresholdPercent}) means compact soon.`,
    `- context_pressure == critical (${hardLimitPercent}) means compact immediately.`,
    "Hard rules:",
    "- `tape_handoff` does not reduce message tokens.",
    "- `session_compact` does not change tape state semantics.",
    "- never run `session_compact` through `exec` or shell; call the tool directly.",
    "- if context pressure is critical without recent compaction, runtime blocks non-`session_compact` tools.",
  ].join("\n");
}

function applyContextContract(systemPrompt: unknown, runtime: BrewvaRuntime): string {
  const base = typeof systemPrompt === "string" ? systemPrompt : "";
  if (base.includes(CONTEXT_CONTRACT_MARKER)) {
    return base;
  }
  const contract = buildContextContractBlock(runtime);
  if (base.trim().length === 0) return contract;
  return `${base}\n\n${contract}`;
}

export function registerContextTransform(
  pi: ExtensionAPI,
  runtime: BrewvaRuntime,
  options: ContextTransformOptions = {},
): void {
  const gateStateBySession = new Map<string, CompactionGateState>();
  const autoCompactionWatchdogMs = Math.max(
    1,
    Math.trunc(options.autoCompactionWatchdogMs ?? DEFAULT_AUTO_COMPACTION_WATCHDOG_MS),
  );

  pi.on("turn_start", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateGateState(gateStateBySession, sessionId);
    const runtimeTurn = observeRuntimeTurnStart(sessionId, event.turnIndex, event.timestamp);
    state.turnIndex = runtimeTurn;
    runtime.context.onTurnStart(sessionId, runtimeTurn);
    return undefined;
  });

  pi.on("context", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateGateState(gateStateBySession, sessionId);
    const usage = coerceContextBudgetUsage(ctx.getContextUsage());
    runtime.context.observeUsage(sessionId, usage);

    if (!runtime.context.checkAndRequestCompaction(sessionId, usage)) {
      return undefined;
    }

    if (ctx.hasUI) {
      // Missing UI-idle telemetry is unsafe for live-turn manual compaction.
      const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : false;
      if (!idle) {
        const pendingReason =
          runtime.context.getPendingCompactionReason(sessionId) ?? "usage_threshold";
        if (state.deferredAutoCompactionReason === pendingReason) {
          return undefined;
        }
        state.deferredAutoCompactionReason = pendingReason;
        // `ctx.compact()` maps to manual compaction and aborts the active agent run.
        // Triggering it from a live context hook can strand the current turn without auto-resume.
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
          usagePercent: usage?.percent ?? null,
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
        ctx.compact({
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
          onError: (error) => {
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
  });

  pi.on("session_compact", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateGateState(gateStateBySession, sessionId);
    const usage = coerceContextBudgetUsage(ctx.getContextUsage());
    const wasGated = state.lastRuntimeGateRequired;
    state.lastRuntimeGateRequired = false;
    clearAutoCompactionState(state);

    runtime.context.markCompacted(sessionId, {
      fromTokens: null,
      toTokens: usage?.tokens ?? null,
      summary: extractCompactionSummary(event),
      entryId: extractCompactionEntryId(event),
    });
    emitRuntimeEvent(runtime, {
      sessionId,
      turn: state.turnIndex,
      type: "session_compact",
      payload: {
        entryId: event.compactionEntry.id,
        fromExtension: event.fromExtension,
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
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = gateStateBySession.get(sessionId);
    if (state) {
      clearAutoCompactionState(state);
    }
    gateStateBySession.delete(sessionId);
    clearRuntimeTurnClock(sessionId);
    return undefined;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const state = getOrCreateGateState(gateStateBySession, sessionId);
    const injectionScopeId = resolveInjectionScopeId(ctx.sessionManager);
    const usage = coerceContextBudgetUsage(ctx.getContextUsage());
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

    let gateStatus = runtime.context.getCompactionGateStatus(sessionId, usage);
    const pendingCompactionReason = runtime.context.getPendingCompactionReason(sessionId);
    if (gateStatus.required) {
      emitGateEvents(gateStatus, "hard_limit");
    }
    const systemPromptWithContract = applyContextContract(
      (event as { systemPrompt?: unknown }).systemPrompt,
      runtime,
    );
    const originalPrompt = event.prompt;
    const allToolsGetter = (pi as { getAllTools?: () => ToolInfo[] }).getAllTools;
    const activeToolsGetter = (pi as { getActiveTools?: () => string[] }).getActiveTools;
    const capabilityView = buildCapabilityView({
      prompt: originalPrompt,
      allTools:
        typeof allToolsGetter === "function"
          ? allToolsGetter.call(pi).map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            }))
          : [],
      activeToolNames: typeof activeToolsGetter === "function" ? activeToolsGetter.call(pi) : [],
      resolveAccess: (toolName) =>
        runtime.tools.explainAccess({
          sessionId,
          toolName,
          usage,
        }),
    });

    if (gateStatus.required) {
      state.lastRuntimeGateRequired = true;
      runtime.skills.clearNextSelection(sessionId);
      const skippedReason = "critical_compaction_gate";
      emitRuntimeEvent(runtime, {
        sessionId,
        turn: state.turnIndex,
        type: "skill_routing_selection",
        payload: {
          status: "skipped",
          reason: skippedReason,
          selectedCount: 0,
          selectedSkills: [],
          inputChars: originalPrompt.length,
          error: null,
        },
      });

      const blocks: string[] = [
        buildTapeStatusBlock({
          runtime,
          sessionId,
          gateStatus,
          pendingCompactionReason,
        }),
      ];
      if (capabilityView.block) {
        blocks.push(capabilityView.block);
      }
      blocks.push(
        buildCompactionGateMessage({
          pressure: gateStatus.pressure,
        }),
      );

      return {
        systemPrompt: systemPromptWithContract,
        message: {
          customType: CONTEXT_INJECTION_MESSAGE_TYPE,
          content: blocks.join("\n\n"),
          display: false,
          details: {
            originalTokens: 0,
            finalTokens: 0,
            truncated: false,
            gateRequired: true,
            routingSelection: {
              status: "skipped",
              reason: skippedReason,
              selectedCount: 0,
            },
            capabilityView: {
              requested: capabilityView.requested,
              expanded: capabilityView.expanded,
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
    const routingProjection = resolveRoutingProjection(runtime, sessionId);
    const gateStatusAfterInjection = runtime.context.getCompactionGateStatus(sessionId, usage);
    if (!gateStatus.required && gateStatusAfterInjection.required) {
      emitGateEvents(gateStatusAfterInjection, "hard_limit");
    }
    gateStatus = gateStatusAfterInjection;
    state.lastRuntimeGateRequired = gateStatus.required;

    emitRuntimeEvent(runtime, {
      sessionId,
      turn: state.turnIndex,
      type: "skill_routing_selection",
      payload: {
        status: routingProjection.selection.status,
        reason: routingProjection.selection.reason,
        selectedCount: routingProjection.selection.selectedCount,
        selectedSkills: routingProjection.selection.selectedSkills,
        inputChars: originalPrompt.length,
        error: routingProjection.error,
      },
    });

    const blocks: string[] = [
      buildTapeStatusBlock({
        runtime,
        sessionId,
        gateStatus,
        pendingCompactionReason,
      }),
    ];
    if (capabilityView.block) {
      blocks.push(capabilityView.block);
    }
    if (gateStatus.required) {
      blocks.push(
        buildCompactionGateMessage({
          pressure: gateStatus.pressure,
        }),
      );
    }
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
      blocks.push(
        buildCompactionAdvisoryMessage({
          reason: pendingCompactionReason,
          pressure: gateStatus.pressure,
        }),
      );
    }
    if (injection.accepted && injection.text.trim().length > 0) {
      blocks.push(injection.text);
    }

    return {
      systemPrompt: systemPromptWithContract,
      message: {
        customType: CONTEXT_INJECTION_MESSAGE_TYPE,
        content: blocks.join("\n\n"),
        display: false,
        details: {
          originalTokens: injection.originalTokens,
          finalTokens: injection.finalTokens,
          truncated: injection.truncated,
          gateRequired: gateStatus.required,
          routingSelection: {
            status: routingProjection.selection.status,
            reason: routingProjection.selection.reason,
            selectedCount: routingProjection.selection.selectedCount,
          },
          capabilityView: {
            requested: capabilityView.requested,
            expanded: capabilityView.expanded,
            missing: capabilityView.missing,
          },
        },
      },
    };
  });
}
