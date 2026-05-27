import { redactedStableJsonSha256Hex } from "@brewva/brewva-std/hash";
import type { BrewvaAgentProtocolMessage } from "@brewva/brewva-substrate/agent-protocol";
import type { InternalHostPluginApi } from "@brewva/brewva-substrate/host-api";
import type {
  ContextBudgetUsage,
  ContextCompactionGateStatus,
} from "@brewva/brewva-vocabulary/context";
import type { DelegationRunRecord } from "@brewva/brewva-vocabulary/delegation";
import {
  buildContextBundle,
  renderContextBundle,
  type ContextBundle,
} from "../../../context/api.js";
import type { HostedDelegationStore } from "../../../delegation/api.js";
import { applyWorkbenchEvictionsToMessages } from "../session/projection/workbench-visibility.js";
import {
  getRuntimeContextStatus,
  getRuntimeTapeStatus,
  listRuntimeWorkbenchEntries,
  renderRuntimeTurnDigest,
  type HostedRuntimeAdapterPort,
} from "../session/runtime-ports.js";
import { renderCapabilityView, type BuildCapabilityViewResult } from "./capability-view.js";
import { applyContextContract } from "./context-contract.js";
import { resolveContextScopeId } from "./context-shared.js";
import type { HostedContextGateStatePort } from "./hosted-compaction-controller.js";
import {
  makeHostedContextBlock,
  type HostedContextBlock,
  type HostedContextRenderResult,
} from "./hosted-context-blocks.js";
import { prepareHostedContextSupport } from "./hosted-context-support.js";
import type { HostedContextTelemetry } from "./hosted-context-telemetry.js";
import {
  applyContextMaterializationReceipt,
  buildContextMaterializationReceipt,
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
    messages: readonly BrewvaAgentProtocolMessage[];
  }) => BrewvaAgentProtocolMessage[];
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

async function listPendingDelegations(
  delegationStore: HostedDelegationStore | undefined,
  sessionId: string,
): Promise<DelegationRunRecord[]> {
  const runs = await delegationStore?.listRunsFromReadModel(sessionId, {
    statuses: ["pending", "running"],
    includeTerminal: false,
    limit: 6,
  });
  return sortDelegationRuns(runs ?? []);
}

async function listPendingDelegationOutcomes(
  delegationStore: HostedDelegationStore | undefined,
  sessionId: string,
): Promise<DelegationRunRecord[]> {
  const pending = await delegationStore?.listPendingOutcomesFromReadModel(sessionId, {
    limit: 6,
  });
  if (pending) {
    return sortDelegationRuns(pending);
  }
  const runs = await delegationStore?.listRunsFromReadModel(sessionId, {
    statuses: ["completed", "failed", "cancelled"],
    includeTerminal: true,
    limit: 6,
  });
  return sortDelegationRuns(
    runs?.filter((run) => run.delivery?.handoffState === "pending_parent_turn") ?? [],
  );
}

function formatDelegationRuns(runs: readonly DelegationRunRecord[]): string {
  return runs.map((run) => `${run.delegate}/${run.label ?? run.runId}:${run.status}`).join(", ");
}

async function buildPendingDelegationsBlock(
  delegationStore: HostedDelegationStore | undefined,
  sessionId: string,
): Promise<HostedContextBlock | null> {
  const runs = await listPendingDelegations(delegationStore, sessionId);
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

async function buildCompletedDelegationOutcomes(input: {
  delegationStore?: HostedDelegationStore;
  sessionId: string;
}): Promise<{ block: HostedContextBlock | null; runIds: string[] }> {
  const runs = await listPendingDelegationOutcomes(input.delegationStore, input.sessionId);
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
  workbenchEntries: ReturnType<HostedRuntimeAdapterPort["ops"]["workbench"]["list"]>;
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
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
): HostedContextBlock | null {
  const entries = listRuntimeWorkbenchEntries(runtime, sessionId);
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
    if ((entry.content?.length ?? 0) > 0) {
      lines.push(`  note: ${entry.content}`);
    }
    if (Array.isArray(entry.preservedQuotes) && entry.preservedQuotes.length > 0) {
      lines.push(`  preserved_quotes: ${entry.preservedQuotes.join(" | ")}`);
    }
  }
  return makeHostedContextBlock("active-workbench", lines.join("\n"));
}

function buildContextStatusBlock(
  runtime: HostedRuntimeAdapterPort,
  input: {
    sessionId: string;
    usage?: ContextBudgetUsage;
  },
): HostedContextBlock {
  const status = getRuntimeContextStatus(runtime, input.sessionId, input.usage);
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

export function buildLatestHandoffBlock(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
): HostedContextBlock | null {
  const anchor = getRuntimeTapeStatus(runtime, sessionId).lastAnchor;
  if (!anchor || (!anchor.name && !anchor.summary && !anchor.nextSteps)) {
    return null;
  }
  const lines = [
    "[LatestHandoff]",
    `anchor: ${anchor.id}`,
    ...(anchor.name ? [`name: ${anchor.name}`] : []),
    ...(anchor.summary ? [`summary: ${anchor.summary}`] : []),
    ...(anchor.nextSteps ? [`next_steps: ${anchor.nextSteps}`] : []),
  ];
  return makeHostedContextBlock("latest-handoff", lines.join("\n"));
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
  runtime: HostedRuntimeAdapterPort;
  sessionId: string;
  turn: number;
}): HostedContextBlock | null {
  if (input.turn <= 0) {
    return null;
  }
  const digest = renderRuntimeTurnDigest(input.runtime, input.sessionId, {
    runtimeTurn: input.turn - 1,
    turnId: `turn-${input.turn - 1}`,
    maxChars: input.runtime.config.infrastructure.contextBudget.consequenceDigestMaxChars,
  });
  if (digest.includes("effects=none_recorded")) {
    return null;
  }
  return makeHostedContextBlock("turn-consequence-digest", digest);
}

function isRequiredHostedContextBlock(block: HostedContextBlock): boolean {
  return block.id === "compaction-gate";
}

interface HostedDynamicTail {
  bundle: ContextBundle;
  rendered: HostedContextRenderResult;
}

async function buildHostedDynamicTail(input: {
  runtime: HostedRuntimeAdapterPort;
  sessionId: string;
  turn: number;
  usage?: ContextBudgetUsage;
  gateStatus: ContextCompactionGateStatus;
  pendingCompactionReason: string | null;
  capabilityView: BuildCapabilityViewResult;
  delegationStore?: HostedDelegationStore;
}): Promise<HostedDynamicTail> {
  const completed = await buildCompletedDelegationOutcomes({
    delegationStore: input.delegationStore,
    sessionId: input.sessionId,
  });
  const compactionNudgeMode = resolveCompactionNudgeMode({
    sessionId: input.sessionId,
    turn: input.turn,
    gateRequired: input.gateStatus.required ?? false,
    pendingCompactionReason: input.pendingCompactionReason,
  });
  const pendingDelegationsBlock = await buildPendingDelegationsBlock(
    input.delegationStore,
    input.sessionId,
  );
  const blocks = [
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
    buildLatestHandoffBlock(input.runtime, input.sessionId),
    buildWorkbenchBlock(input.runtime, input.sessionId),
    pendingDelegationsBlock,
    completed.block,
    buildConsequenceDigestBlock({
      runtime: input.runtime,
      sessionId: input.sessionId,
      turn: input.turn,
    }),
    ...buildCapabilityBlocks(input.capabilityView),
    ...buildReadPathRecoveryBlocks(input.runtime, input.sessionId),
  ].filter((block): block is HostedContextBlock => Boolean(block));
  const bundleResult = buildContextBundle({
    scope: "hosted_dynamic_tail",
    blocks: blocks.map((block) => ({
      id: block.id,
      content: block.content,
      admission: isRequiredHostedContextBlock(block)
        ? ("required" as const)
        : ("advisory" as const),
      priority: isRequiredHostedContextBlock(block) ? 0 : 100,
    })),
    budget: input.runtime.config.infrastructure.contextBudget.enabled
      ? {
          maxTokens: input.runtime.config.infrastructure.contextBudget.dynamicTailTokens,
          overflow: "compaction_required",
        }
      : { overflow: "compaction_required" },
    createdAt: input.turn,
  });
  if (!bundleResult.ok) {
    throw new Error(`hosted_context_bundle_blocked:${bundleResult.blocker.reason}`);
  }
  const rendered = renderContextBundle(bundleResult.bundle);
  return {
    bundle: bundleResult.bundle,
    rendered: {
      ...rendered,
      surfacedDelegationRunIds: completed.runIds,
    },
  };
}

export function createHostedWorkbenchContextController(
  extensionApi: InternalHostPluginApi,
  runtime: HostedRuntimeAdapterPort,
  telemetry: HostedContextTelemetry,
  statePort: HostedContextGateStatePort,
  options: HostedWorkbenchContextOptions = {},
): HostedWorkbenchContextController {
  return {
    transformContext(input) {
      return applyWorkbenchEvictionsToMessages({
        messages: input.messages,
        workbenchEntries: listRuntimeWorkbenchEntries(runtime, input.sessionId),
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

      const dynamicTail = await buildHostedDynamicTail({
        runtime,
        sessionId: input.sessionId,
        turn,
        usage: input.usage,
        gateStatus,
        pendingCompactionReason,
        capabilityView,
        delegationStore: options.delegationStore,
      });
      const rendered = dynamicTail.rendered;
      const materializationReceipt = buildContextMaterializationReceipt({
        sessionId: input.sessionId,
        turn,
        contextScopeId,
        systemPrompt: systemPromptWithContract,
        contextBundle: dynamicTail.bundle,
        rendered,
        usage: input.usage,
        gateStatus,
        pendingCompactionReason,
        workbenchContextRendered: rendered.blocks.some((block) => block.id === "active-workbench"),
        surfacedDelegationRunIds: rendered.surfacedDelegationRunIds,
      });
      applyContextMaterializationReceipt({
        runtime,
        telemetry,
        delegationStore: options.delegationStore,
        receipt: materializationReceipt,
        usage: input.usage,
      });

      return buildHiddenContextResult({
        systemPrompt: systemPromptWithContract,
        rendered,
        details: buildMessageDetails({
          originalTokens: 0,
          finalTokens: 0,
          truncated: false,
          gateRequired: gateStatus.required === true,
          rendered,
          capabilityView,
          workbenchEntries: listRuntimeWorkbenchEntries(runtime, input.sessionId),
        }),
      });
    },
  };
}
