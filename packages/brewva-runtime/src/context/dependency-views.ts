import type { ContextBudgetUsage } from "../contracts/index.js";
import type { RuntimeKernelContext } from "../runtime-kernel.js";
import {
  resolveHistoryViewBaselineStateFromKernel,
  resolveRecoveryContextReadModels,
  type HistoryViewBaselineStateResolution,
} from "./read-models.js";
import type { ToolFailureEntry } from "./tool-failures.js";
import type { ToolOutputDistillationEntry } from "./tool-output-distilled.js";

function resolveReservedBudgetFromRatio(
  kernel: RuntimeKernelContext,
  sessionId: string,
  usage: ContextBudgetUsage | undefined,
  ratio: number | undefined,
): number | null {
  if (ratio === undefined || !kernel.isContextBudgetEnabled()) {
    return null;
  }
  const totalBudget = kernel.contextBudget.getEffectiveInjectionTokenBudget(sessionId, usage);
  const total = Math.max(0, Math.floor(totalBudget));
  if (total <= 0) {
    return 0;
  }
  return Math.max(1, Math.floor(total * ratio));
}

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

export function resolveToolOutputDistillationView(
  kernel: RuntimeKernelContext,
  sessionId: string,
): ToolOutputDistillationEntry[] {
  return kernel
    .getRecentToolOutputDistillations(sessionId, 12)
    .map((entry) => ({
      toolName: entry.toolName,
      strategy: entry.strategy,
      summaryText: kernel.sanitizeInput(entry.summaryText),
      rawTokens: entry.rawTokens,
      summaryTokens: entry.summaryTokens,
      compressionRatio: entry.compressionRatio,
      artifactRef: entry.artifactRef ? kernel.sanitizeInput(entry.artifactRef) : null,
      isError: entry.isError,
      verdict: entry.verdict,
      turn: entry.turn,
      timestamp: entry.timestamp,
    }))
    .filter((entry) => entry.summaryText.trim().length > 0);
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
    maxBaselineTokens: resolveReservedBudgetFromRatio(
      kernel,
      input.sessionId,
      input.usage,
      input.reservedBudgetRatio,
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
    maxBaselineTokens: resolveReservedBudgetFromRatio(
      kernel,
      input.sessionId,
      input.usage,
      input.reservedBudgetRatio,
    ),
  });
}
