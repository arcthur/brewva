import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type {
  ContextBudgetUsage,
  ContextCompactionGateStatus,
} from "@brewva/brewva-runtime/context";
import type { DelegationRunRecord } from "@brewva/brewva-runtime/delegation";
import { redactedStableJsonSha256Hex } from "@brewva/brewva-std/hash";
import type { InternalHostPluginApi } from "@brewva/brewva-substrate/host-api";
import type { BrewvaTurnLoopMessage } from "@brewva/brewva-substrate/turn";
import type { HostedDelegationStore } from "../../../delegation/api.js";
import { applyWorkbenchEvictionsToMessages } from "../session/projection/workbench-visibility.js";
import { renderCapabilityView, type BuildCapabilityViewResult } from "./capability-view.js";
import { applyContextContract } from "./context-contract.js";
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
import {
  commitHostedContextMaterialization,
  planHostedContextMaterialization,
} from "./materialization.js";
import { buildReadPathRecoveryBlocks } from "./read-path-recovery.js";

export const HOSTED_WORKBENCH_CONTEXT_MESSAGE_TYPE = "brewva-workbench-context";
const COMPACTION_NUDGE_FULL_EVERY_TURNS = 5;

type CompactionNudgeMode = "full" | "brief";

interface CompactionNudgeState {
  key: string;
  firstTurn: number;
  lastTurn: number;
  renderCount: number;
}

const compactionNudgeStateBySession = new Map<string, CompactionNudgeState>();

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

export interface HostedWorkbenchContextController {
  beforeAgentStart: (input: HostedWorkbenchContextInput) => Promise<HostedWorkbenchContextResult>;
  transformContext: (input: {
    sessionId: string;
    messages: readonly BrewvaTurnLoopMessage[];
  }) => BrewvaTurnLoopMessage[];
}

export interface HostedWorkbenchContextOptions {
  delegationStore?: HostedDelegationStore;
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

function resolveCompactionNudgeMode(input: {
  sessionId: string;
  turn: number;
  gateRequired: boolean;
  pendingCompactionReason: string | null;
}): CompactionNudgeMode | null {
  const key = input.gateRequired
    ? "gate:required"
    : input.pendingCompactionReason
      ? `advisory:${input.pendingCompactionReason}`
      : null;
  if (!key) {
    compactionNudgeStateBySession.delete(input.sessionId);
    return null;
  }

  const previous = compactionNudgeStateBySession.get(input.sessionId);
  const next =
    previous?.key === key
      ? {
          ...previous,
          lastTurn: input.turn,
          renderCount: previous.renderCount + 1,
        }
      : {
          key,
          firstTurn: input.turn,
          lastTurn: input.turn,
          renderCount: 1,
        };
  compactionNudgeStateBySession.set(input.sessionId, next);

  if (next.renderCount === 1 || (next.renderCount - 1) % COMPACTION_NUDGE_FULL_EVERY_TURNS === 0) {
    return "full";
  }
  return "brief";
}

function buildCompactionGateBlock(input: {
  status: ContextCompactionGateStatus["status"];
  mode: CompactionNudgeMode;
}): HostedContextBlock {
  const content =
    input.mode === "brief"
      ? [
          "[ContextCompactionGate]",
          "required: yes",
          `tokens_until_forced_compact: ${input.status.tokensUntilForcedCompact ?? "unknown"}`,
          "action: call `workbench_compact` now.",
        ]
      : [
          "[ContextCompactionGate]",
          "Context has reached the forced compaction limit.",
          `usage_ratio: ${input.status.usageRatio ?? "unknown"}`,
          `hard_limit_ratio: ${input.status.hardLimitRatio}`,
          "Call tool `workbench_compact` immediately before any other tool call.",
          "Do not run `workbench_compact` via `exec` or shell.",
        ];
  return makeHostedContextBlock("compaction-gate", content.join("\n"))!;
}

function buildCompactionAdvisoryBlock(input: {
  reason: string;
  status: ContextCompactionGateStatus["status"];
  mode: CompactionNudgeMode;
}): HostedContextBlock {
  const content =
    input.mode === "brief"
      ? [
          "[ContextCompactionAdvisory]",
          `pending_compaction_reason: ${input.reason}`,
          "action: prefer `workbench_compact` before another long tool chain.",
        ]
      : [
          "[ContextCompactionAdvisory]",
          `pending_compaction_reason: ${input.reason}`,
          `usage_ratio: ${input.status.usageRatio ?? "unknown"}`,
          `compact_soon_threshold_ratio: ${input.status.compactionThresholdRatio}`,
          "Prefer `workbench_compact` before long tool chains or broad repository scans.",
          "If no further tool work is needed, answer directly instead of compacting first.",
        ];
  return makeHostedContextBlock("compaction-advisory", content.join("\n"))!;
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
  const status = runtime.inspect.context.usage.getStatus(input.sessionId, input.usage);
  const lines = [
    "[Context Status]",
    `tokens_used: ${status.tokensUsed ?? "unknown"}`,
    `tokens_total: ${status.tokensTotal}`,
    `effective_tokens_total: ${status.effectiveTokensTotal ?? "unknown"}`,
    `tokens_remaining: ${status.tokensRemaining ?? "unknown"}`,
    `auto_compact_limit_tokens: ${status.autoCompactLimitTokens ?? "unknown"}`,
    `controllable_tokens_remaining: ${status.controllableTokensRemaining ?? "unknown"}`,
    `controllable_context_remaining_ratio: ${
      status.controllableContextRemainingRatio ?? "unknown"
    }`,
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

function buildConsequenceDigestBlock(input: {
  runtime: BrewvaHostedRuntimePort;
  sessionId: string;
  turn: number;
}): HostedContextBlock | null {
  if (input.turn <= 0) {
    return null;
  }
  const digest = input.runtime.inspect.events.effects.renderTurnDigest(input.sessionId, {
    runtimeTurn: input.turn - 1,
    turnId: `turn-${input.turn - 1}`,
    maxChars:
      input.runtime.config.infrastructure.contextBudget.dynamicTail.consequenceDigestMaxChars,
  });
  if (digest.includes("effects=none_recorded")) {
    return null;
  }
  return makeHostedContextBlock("turn-consequence-digest", digest);
}

function buildHostedDynamicTail(input: {
  runtime: BrewvaHostedRuntimePort;
  sessionId: string;
  turn: number;
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
  const compactionNudgeMode = resolveCompactionNudgeMode({
    sessionId: input.sessionId,
    turn: input.turn,
    gateRequired: input.gateStatus.required,
    pendingCompactionReason: input.pendingCompactionReason,
  });
  return renderHostedContextBlocks({
    blocks: [
      input.gateStatus.required && compactionNudgeMode
        ? buildCompactionGateBlock({
            status: input.gateStatus.status,
            mode: compactionNudgeMode,
          })
        : null,
      !input.gateStatus.required && input.pendingCompactionReason
        ? buildCompactionAdvisoryBlock({
            reason: input.pendingCompactionReason,
            status: input.gateStatus.status,
            mode: compactionNudgeMode ?? "full",
          })
        : null,
      buildContextStatusBlock(input.runtime, {
        sessionId: input.sessionId,
        usage: input.usage,
      }),
      buildWorkbenchBlock(input.runtime, input.sessionId),
      buildPendingDelegationsBlock(input.delegationStore, input.sessionId),
      completed.block,
      buildConsequenceDigestBlock({
        runtime: input.runtime,
        sessionId: input.sessionId,
        turn: input.turn,
      }),
      ...buildCapabilityBlocks(input.capabilityView),
      ...buildReadPathRecoveryBlocks(input.runtime, input.sessionId),
    ],
    surfacedDelegationRunIds: completed.runIds,
  });
}

export function createHostedWorkbenchContextController(
  extensionApi: InternalHostPluginApi,
  runtime: BrewvaHostedRuntimePort,
  telemetry: HostedContextTelemetry,
  statePort: HostedContextGateStatePort,
  options: HostedWorkbenchContextOptions = {},
): HostedWorkbenchContextController {
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

      const { gateStatus, pendingCompactionReason, capabilityView } = prepareHostedContextSupport({
        runtime,
        extensionApi,
        sessionId: input.sessionId,
        prompt: input.prompt,
        usage: input.usage,
      });

      const systemPromptWithContract = applyContextContract(input.systemPrompt);
      statePort.setLastRuntimeGateRequired(input.sessionId, gateStatus.required);

      const rendered = buildHostedDynamicTail({
        runtime,
        sessionId: input.sessionId,
        turn,
        usage: input.usage,
        gateStatus,
        pendingCompactionReason,
        capabilityView,
        delegationStore: options.delegationStore,
      });
      const materializationPlan = planHostedContextMaterialization({
        sessionId: input.sessionId,
        turn,
        contextScopeId,
        systemPrompt: systemPromptWithContract,
        rendered,
        usage: input.usage,
        gateStatus,
        pendingCompactionReason,
        workbenchContextRendered: rendered.blocks.some((block) => block.id === "active-workbench"),
        capabilityDisclosureRendered:
          capabilityView.requested.length > 0 ||
          capabilityView.details.length > 0 ||
          capabilityView.missing.length > 0,
        consequenceDigestRendered: rendered.blocks.some(
          (block) => block.id === "turn-consequence-digest",
        ),
        surfacedDelegationRunIds: rendered.surfacedDelegationRunIds,
      });
      commitHostedContextMaterialization(materializationPlan, {
        runtime,
        telemetry,
        delegationStore: options.delegationStore,
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
