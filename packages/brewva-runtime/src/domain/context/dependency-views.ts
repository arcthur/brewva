import type { RuntimeKernelContext } from "../../runtime/runtime-kernel.js";
import {
  resolveHistoryViewBaselineStateFromKernel,
  resolveRecoveryContextReadModels,
  type HistoryViewBaselineStateResolution,
} from "./read-models.js";
import { resolveReservedBudgetFromRatio } from "./reserved-budget.js";
import type { ToolFailureEntry } from "./tool-failures.js";
import type { ContextBudgetUsage } from "./types.js";

export interface RuntimeStatusView {
  verification: ReturnType<RuntimeKernelContext["getLatestVerificationOutcome"]>;
  failures: ToolFailureEntry[];
}

export function resolveRuntimeStatusView(
  kernel: RuntimeKernelContext,
  sessionId: string,
): RuntimeStatusView {
  return {
    verification: kernel.getLatestVerificationOutcome(sessionId),
    failures: kernel.turnReplay.getRecentToolFailures(sessionId, 12).map((entry) => ({
      toolName: entry.toolName,
      args: entry.args,
      outputText: kernel.sanitizeInput(entry.outputText),
      turn: Number.isFinite(entry.turn) ? Math.max(0, Math.floor(entry.turn)) : 0,
      failureClass: entry.failureClass,
    })),
  };
}

export function resolveTaskStateView(
  kernel: RuntimeKernelContext,
  sessionId: string,
): ReturnType<RuntimeKernelContext["getTaskState"]> {
  return kernel.getTaskState(sessionId);
}

export function resolveProjectionWorkingView(
  kernel: RuntimeKernelContext,
  sessionId: string,
): { content: string } | null {
  kernel.projectionEngine.refreshIfNeeded({ sessionId });
  const working = kernel.projectionEngine.getWorkingProjection(sessionId);
  const content = kernel.sanitizeInput(working?.content ?? "").trim();
  if (!content) {
    return null;
  }
  return { content };
}

export function resolveHistoryViewBaselineView(
  kernel: RuntimeKernelContext,
  input: {
    sessionId: string;
    usage?: ContextBudgetUsage;
    referenceContextDigest?: string | null;
    reservedBudgetRatio?: number;
  },
): HistoryViewBaselineStateResolution {
  return resolveHistoryViewBaselineStateFromKernel(kernel, {
    sessionId: input.sessionId,
    usage: input.usage,
    referenceContextDigest: input.referenceContextDigest,
    maxBaselineTokens:
      input.reservedBudgetRatio === undefined || !kernel.isContextBudgetEnabled()
        ? null
        : resolveReservedBudgetFromRatio(
            input.reservedBudgetRatio,
            kernel.contextBudget.getEffectiveDynamicTailTokenBudget(input.sessionId, input.usage),
          ),
  });
}

export function resolveRecoveryWorkingSetView(
  kernel: RuntimeKernelContext,
  input: {
    sessionId: string;
    usage?: ContextBudgetUsage;
    referenceContextDigest?: string | null;
    reservedBudgetRatio?: number;
  },
) {
  return resolveRecoveryContextReadModels(kernel, {
    sessionId: input.sessionId,
    usage: input.usage,
    referenceContextDigest: input.referenceContextDigest,
    maxBaselineTokens:
      input.reservedBudgetRatio === undefined || !kernel.isContextBudgetEnabled()
        ? null
        : resolveReservedBudgetFromRatio(
            input.reservedBudgetRatio,
            kernel.contextBudget.getEffectiveDynamicTailTokenBudget(input.sessionId, input.usage),
          ),
  });
}
