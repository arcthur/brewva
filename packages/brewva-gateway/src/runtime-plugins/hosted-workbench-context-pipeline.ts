import {
  type BrewvaHostedRuntimePort,
  type ContextBudgetUsage,
  type ContextCompactionGateStatus,
  type DelegationRunRecord,
} from "@brewva/brewva-runtime";
import { redactedStableJsonSha256Hex } from "@brewva/brewva-std/hash";
import type { InternalHostPluginApi } from "@brewva/brewva-substrate/host-api";
import type { BrewvaTurnLoopMessage } from "@brewva/brewva-substrate/turn";
import { applyWorkbenchEvictionsToMessages } from "../host/workbench-visibility.js";
import type { HostedDelegationStore } from "../subagents/delegation-store.js";
import { renderCapabilityView, type BuildCapabilityViewResult } from "./capability-view.js";
import { applyContextContract } from "./context-contract.js";
import { recordPromptStabilityEvidence } from "./context-evidence.js";
import { resolveContextScopeId } from "./context-shared.js";
import type { HostedContextGateStatePort } from "./hosted-compaction-controller.js";
import {
  makeHostedContextBlock,
  renderHostedContextBlocks,
  type HostedContextBlock,
  type HostedContextRenderResult,
} from "./hosted-context-blocks.js";
import { prepareHostedContextSupport } from "./hosted-context-support.js";
import type { HostedContextTelemetry } from "./hosted-context-telemetry.js";
import { buildPromptStabilityObservation } from "./prompt-stability.js";
import { buildReadPathRecoveryBlocks } from "./read-path-recovery.js";

export const HOSTED_WORKBENCH_CONTEXT_MESSAGE_TYPE = "brewva-workbench-context";

export interface HostedContextSessionManager {
  getLeafId?: () => string | null | undefined;
}

export interface HostedWorkbenchContextInput {
  sessionId: string;
  sessionManager: HostedContextSessionManager;
  prompt: string;
  systemPrompt: unknown;
  usage?: ContextBudgetUsage;
}

export interface HostedWorkbenchContextMessageDetails {
  originalTokens: number;
  finalTokens: number;
  truncated: boolean;
  gateRequired: boolean;
  dynamicTail: {
    blockCount: number;
    totalTokens: number;
    blockIds: string[];
  };
  capabilityView: {
    requested: string[];
    detailNames: string[];
    missing: string[];
  };
  workbench: {
    entries: number;
    notes: number;
    evictions: number;
    contentHash: string;
  };
}

export interface HostedWorkbenchContextResult {
  systemPrompt: string;
  message: {
    customType: typeof HOSTED_WORKBENCH_CONTEXT_MESSAGE_TYPE;
    content: string;
    display: false;
    details: HostedWorkbenchContextMessageDetails;
  };
}

export interface HostedWorkbenchContextPipeline {
  beforeAgentStart: (input: HostedWorkbenchContextInput) => Promise<HostedWorkbenchContextResult>;
  transformContext: (input: {
    sessionId: string;
    messages: readonly BrewvaTurnLoopMessage[];
  }) => BrewvaTurnLoopMessage[];
}

export interface HostedWorkbenchContextPipelineOptions {
  delegationStore?: HostedDelegationStore;
  contextProfile?: "minimal" | "standard" | "full";
}

function sortDelegationRuns(runs: readonly DelegationRunRecord[]): DelegationRunRecord[] {
  return runs.toSorted(
    (left, right) =>
      left.runId.localeCompare(right.runId) ||
      left.delegate.localeCompare(right.delegate) ||
      (left.label ?? "").localeCompare(right.label ?? "") ||
      left.status.localeCompare(right.status),
  );
}

function listPendingDelegations(
  delegationStore: HostedDelegationStore | undefined,
  sessionId: string,
): DelegationRunRecord[] {
  return sortDelegationRuns(
    delegationStore?.listRuns(sessionId, {
      statuses: ["pending", "running"],
      includeTerminal: false,
      limit: 6,
    }) ?? [],
  );
}

function listPendingDelegationOutcomes(
  delegationStore: HostedDelegationStore | undefined,
  sessionId: string,
): DelegationRunRecord[] {
  const pending = delegationStore?.listPendingOutcomes(sessionId, {
    limit: 6,
  });
  if (pending) {
    return sortDelegationRuns(pending);
  }
  return sortDelegationRuns(
    delegationStore
      ?.listRuns(sessionId, {
        statuses: ["completed", "failed", "timeout", "cancelled"],
        includeTerminal: true,
        limit: 6,
      })
      .filter((run) => run.delivery?.handoffState === "pending_parent_turn") ?? [],
  );
}

function formatDelegationRuns(runs: readonly DelegationRunRecord[]): string {
  return runs.map((run) => `${run.delegate}/${run.label ?? run.runId}:${run.status}`).join(", ");
}

function buildPendingDelegationsBlock(
  delegationStore: HostedDelegationStore | undefined,
  sessionId: string,
): HostedContextBlock | null {
  const runs = listPendingDelegations(delegationStore, sessionId);
  if (runs.length === 0) {
    return null;
  }
  return makeHostedContextBlock(
    "pending-delegations",
    ["[PendingDelegations]", `count: ${runs.length}`, `runs: ${formatDelegationRuns(runs)}`].join(
      "\n",
    ),
  );
}

function buildCompletedDelegationOutcomes(input: {
  delegationStore?: HostedDelegationStore;
  sessionId: string;
}): { block: HostedContextBlock | null; runIds: string[] } {
  const runs = listPendingDelegationOutcomes(input.delegationStore, input.sessionId);
  if (runs.length === 0) {
    return { block: null, runIds: [] };
  }
  return {
    block: makeHostedContextBlock(
      "completed-delegation-outcomes",
      [
        "[CompletedDelegationOutcomes]",
        `count: ${runs.length}`,
        ...runs.map(
          (run) =>
            `- ${run.delegate}/${run.label ?? run.runId}: ${run.status}${
              run.summary ? ` :: ${run.summary}` : ""
            }`,
        ),
      ].join("\n"),
    ),
    runIds: runs.map((run) => run.runId),
  };
}

function markSurfacedDelegationOutcomes(
  delegationStore: HostedDelegationStore | undefined,
  input: {
    sessionId: string;
    turn: number;
    runIds: readonly string[];
  },
): void {
  delegationStore?.markSurfaced(input);
}

function buildMessageDetails(input: {
  originalTokens: number;
  finalTokens: number;
  truncated: boolean;
  gateRequired: boolean;
  rendered: HostedContextRenderResult;
  capabilityView: BuildCapabilityViewResult;
  workbenchEntries: ReturnType<BrewvaHostedRuntimePort["inspect"]["workbench"]["list"]>;
}): HostedWorkbenchContextMessageDetails {
  const notes = input.workbenchEntries.filter((entry) => entry.kind === "note").length;
  const evictions = input.workbenchEntries.filter((entry) => entry.kind === "eviction").length;
  return {
    originalTokens: input.originalTokens,
    finalTokens: input.finalTokens,
    truncated: input.truncated,
    gateRequired: input.gateRequired,
    dynamicTail: {
      blockCount: input.rendered.blocks.length,
      totalTokens: input.rendered.totalTokens,
      blockIds: input.rendered.blocks.map((block) => block.id),
    },
    capabilityView: {
      requested: input.capabilityView.requested,
      detailNames: input.capabilityView.details.map((detail) => detail.name),
      missing: input.capabilityView.missing,
    },
    workbench: {
      entries: input.workbenchEntries.length,
      notes,
      evictions,
      contentHash: redactedStableJsonSha256Hex(
        input.workbenchEntries.map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          digest: entry.digest,
        })),
      ),
    },
  };
}

function buildHiddenContextResult(input: {
  systemPrompt: string;
  rendered: HostedContextRenderResult;
  details: HostedWorkbenchContextMessageDetails;
}): HostedWorkbenchContextResult {
  return {
    systemPrompt: input.systemPrompt,
    message: {
      customType: HOSTED_WORKBENCH_CONTEXT_MESSAGE_TYPE,
      content: input.rendered.content,
      display: false,
      details: input.details,
    },
  };
}

function observePromptStability(
  runtime: BrewvaHostedRuntimePort,
  input: {
    sessionId: string;
    turn: number;
    contextScopeId?: string;
    systemPrompt: string;
    rendered: HostedContextRenderResult;
    usage?: ContextBudgetUsage;
    pendingCompactionReason?: string | null;
    gateRequired: boolean;
  },
): void {
  const observation = buildPromptStabilityObservation({
    systemPrompt: input.systemPrompt,
    composedContent: input.rendered.content,
    contextScopeId: input.contextScopeId,
    turn: input.turn,
  });
  const observed = runtime.maintain.context.observePromptStability(input.sessionId, observation);
  const contextStatus = runtime.inspect.context.getStatus(input.sessionId, input.usage);
  recordPromptStabilityEvidence({
    workspaceRoot: runtime.workspaceRoot,
    sessionId: input.sessionId,
    observed,
    compactionAdvised: contextStatus.compactionAdvised,
    forcedCompaction: contextStatus.forcedCompaction,
    usageRatio: contextStatus.usageRatio,
    pendingCompactionReason: input.pendingCompactionReason,
    gateRequired: input.gateRequired,
  });
}

function buildCompactionGateBlock(
  status: ContextCompactionGateStatus["status"],
): HostedContextBlock {
  const content = [
    "[ContextCompactionGate]",
    "Context has reached the forced compaction limit.",
    `usage_ratio: ${status.usageRatio ?? "unknown"}`,
    `hard_limit_ratio: ${status.hardLimitRatio}`,
    "Call tool `workbench_compact` immediately before any other tool call.",
    "Do not run `workbench_compact` via `exec` or shell.",
  ].join("\n");
  return makeHostedContextBlock("compaction-gate", content)!;
}

function buildCompactionAdvisoryBlock(input: {
  reason: string;
  status: ContextCompactionGateStatus["status"];
}): HostedContextBlock {
  const content = [
    "[ContextCompactionAdvisory]",
    `pending_compaction_reason: ${input.reason}`,
    `usage_ratio: ${input.status.usageRatio ?? "unknown"}`,
    `compact_soon_threshold_ratio: ${input.status.compactionThresholdRatio}`,
    "Prefer `workbench_compact` before long tool chains or broad repository scans.",
    "If no further tool work is needed, answer directly instead of compacting first.",
  ].join("\n");
  return makeHostedContextBlock("compaction-advisory", content)!;
}

function buildWorkbenchBlock(
  runtime: BrewvaHostedRuntimePort,
  sessionId: string,
): HostedContextBlock | null {
  const entries = runtime.inspect.workbench.list(sessionId);
  if (entries.length === 0) {
    return null;
  }
  const lines = ["[Workbench]"];
  for (const entry of entries.slice(-12)) {
    lines.push(
      [
        `- id=${entry.id}`,
        `kind=${entry.kind}`,
        `turn=${entry.createdTurn}`,
        `digest=${entry.digest.slice(0, 12)}`,
        `reversible=${entry.reversible ? "true" : "false"}`,
        `reason=${entry.reason}`,
      ].join(" "),
    );
    if (entry.sourceRefs.length > 0) {
      lines.push(`  source_refs: ${entry.sourceRefs.join(", ")}`);
    }
    if (entry.content.length > 0) {
      lines.push(`  note: ${entry.content}`);
    }
    if (entry.preservedQuotes && entry.preservedQuotes.length > 0) {
      lines.push(`  preserved_quotes: ${entry.preservedQuotes.join(" | ")}`);
    }
  }
  return makeHostedContextBlock("active-workbench", lines.join("\n"));
}

function buildContextStatusBlock(
  runtime: BrewvaHostedRuntimePort,
  input: {
    sessionId: string;
    usage?: ContextBudgetUsage;
  },
): HostedContextBlock {
  const status = runtime.inspect.context.getStatus(input.sessionId, input.usage);
  const lines = [
    "[Context Status]",
    `tokens_used: ${status.tokensUsed ?? "unknown"}`,
    `tokens_total: ${status.tokensTotal}`,
    `tokens_remaining: ${status.tokensRemaining ?? "unknown"}`,
    `tokens_until_forced_compact: ${status.tokensUntilForcedCompact ?? "unknown"}`,
    `predicted_turn_growth_tokens: ${status.predictedTurnGrowthTokens}`,
    `tokens_until_predicted_overflow: ${status.tokensUntilPredictedOverflow ?? "unknown"}`,
    `predicted_overflow: ${status.predictedOverflow ? "yes" : "no"}`,
    `usage_ratio: ${status.usageRatio ?? "unknown"}`,
    `compaction_advised: ${status.compactionAdvised ? "yes" : "no"}`,
    `forced_compaction: ${status.forcedCompaction ? "yes" : "no"}`,
  ];
  return makeHostedContextBlock("context-status", lines.join("\n"))!;
}

function buildCapabilityBlocks(capabilityView: BuildCapabilityViewResult): HostedContextBlock[] {
  if (capabilityView.requested.length === 0 && capabilityView.missing.length === 0) {
    return [];
  }
  return renderCapabilityView({
    capabilityView,
    mode: "full",
    includeInventory: false,
  })
    .filter((block) => block.priority === "requested")
    .flatMap((block) => {
      const rendered = makeHostedContextBlock(block.id, block.content);
      return rendered ? [rendered] : [];
    });
}

function buildHostedDynamicTail(input: {
  runtime: BrewvaHostedRuntimePort;
  sessionId: string;
  usage?: ContextBudgetUsage;
  gateStatus: ContextCompactionGateStatus;
  pendingCompactionReason: string | null;
  capabilityView: BuildCapabilityViewResult;
  delegationStore?: HostedDelegationStore;
}): HostedContextRenderResult {
  const completed = buildCompletedDelegationOutcomes({
    delegationStore: input.delegationStore,
    sessionId: input.sessionId,
  });
  return renderHostedContextBlocks({
    blocks: [
      input.gateStatus.required ? buildCompactionGateBlock(input.gateStatus.status) : null,
      !input.gateStatus.required && input.pendingCompactionReason
        ? buildCompactionAdvisoryBlock({
            reason: input.pendingCompactionReason,
            status: input.gateStatus.status,
          })
        : null,
      buildContextStatusBlock(input.runtime, {
        sessionId: input.sessionId,
        usage: input.usage,
      }),
      buildWorkbenchBlock(input.runtime, input.sessionId),
      buildPendingDelegationsBlock(input.delegationStore, input.sessionId),
      completed.block,
      ...buildCapabilityBlocks(input.capabilityView),
      ...buildReadPathRecoveryBlocks(input.runtime, input.sessionId),
    ],
    surfacedDelegationRunIds: completed.runIds,
  });
}

export function createHostedWorkbenchContextPipeline(
  extensionApi: InternalHostPluginApi,
  runtime: BrewvaHostedRuntimePort,
  telemetry: HostedContextTelemetry,
  statePort: HostedContextGateStatePort,
  options: HostedWorkbenchContextPipelineOptions = {},
): HostedWorkbenchContextPipeline {
  return {
    transformContext(input) {
      return applyWorkbenchEvictionsToMessages({
        messages: input.messages,
        workbenchEntries: runtime.inspect.workbench.list(input.sessionId),
      }).messages;
    },

    async beforeAgentStart(input) {
      const turn = statePort.getTurnIndex(input.sessionId);
      const contextScopeId = resolveContextScopeId(input.sessionManager);
      runtime.maintain.context.observeUsage(input.sessionId, input.usage);

      const { gateStatus, pendingCompactionReason, capabilityView } = prepareHostedContextSupport({
        runtime,
        extensionApi,
        sessionId: input.sessionId,
        prompt: input.prompt,
        usage: input.usage,
      });

      if (gateStatus.required) {
        telemetry.emitHardGateRequired({
          sessionId: input.sessionId,
          turn,
          reason: "hard_limit",
          gateStatus,
        });
      }
      const systemPromptWithContract = applyContextContract(input.systemPrompt);
      statePort.setLastRuntimeGateRequired(input.sessionId, gateStatus.required);

      if (pendingCompactionReason && !gateStatus.required) {
        telemetry.emitCompactionAdvisory({
          sessionId: input.sessionId,
          turn,
          reason: pendingCompactionReason,
          gateStatus,
        });
      }

      const rendered = buildHostedDynamicTail({
        runtime,
        sessionId: input.sessionId,
        usage: input.usage,
        gateStatus,
        pendingCompactionReason,
        capabilityView,
        delegationStore: options.delegationStore,
      });
      telemetry.emitContextComposed({
        sessionId: input.sessionId,
        turn,
        rendered,
        workbenchContextRendered: rendered.blocks.some((block) => block.id === "active-workbench"),
      });
      observePromptStability(runtime, {
        sessionId: input.sessionId,
        turn,
        contextScopeId,
        systemPrompt: systemPromptWithContract,
        rendered,
        usage: input.usage,
        pendingCompactionReason,
        gateRequired: gateStatus.required,
      });
      markSurfacedDelegationOutcomes(options.delegationStore, {
        sessionId: input.sessionId,
        turn,
        runIds: rendered.surfacedDelegationRunIds,
      });

      return buildHiddenContextResult({
        systemPrompt: systemPromptWithContract,
        rendered,
        details: buildMessageDetails({
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
          gateRequired: gateStatus.required,
          rendered,
          capabilityView,
          workbenchEntries: runtime.inspect.workbench.list(input.sessionId),
        }),
      });
    },
  };
}
