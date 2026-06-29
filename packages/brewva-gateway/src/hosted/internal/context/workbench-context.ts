import { redactedStableJsonSha256Hex } from "@brewva/brewva-std/hash";
import type { BrewvaAgentProtocolMessage } from "@brewva/brewva-substrate/agent-protocol";
import type { InternalHostPluginApi } from "@brewva/brewva-substrate/host-api";
import type {
  ContextBudgetUsage,
  ContextCompactionGateStatus,
} from "@brewva/brewva-vocabulary/context";
import type { DelegationRunRecord } from "@brewva/brewva-vocabulary/delegation";
import { decideContinuationAnchorRelevance } from "@brewva/brewva-vocabulary/session";
import {
  buildContextBundle,
  renderContextBundle,
  type ContextBundle,
} from "../../../context/api.js";
import type { HostedDelegationStore } from "../../../delegation/api.js";
import { applyWorkbenchEvictionsToMessages } from "../session/projection/workbench-visibility.js";
import {
  getRuntimeContextEvidenceLatest,
  getRuntimeContextStatus,
  getRuntimeTapeStatus,
  listRuntimeWorkbenchEntries,
  renderRuntimeTurnDigest,
  type HostedRuntimeAdapterPort,
} from "../session/runtime-ports.js";
import { renderCapabilityView, type BuildCapabilityViewResult } from "./capability-view.js";
import { applyContextContract } from "./context-contract.js";
import { decideContextNudge, decideContextPressure } from "./context-lifecycle.js";
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
import {
  buildRuntimeBriefBlock,
  renderCacheBreakSection,
  renderConsequenceSection,
  renderContextPressureSection,
  RUNTIME_BRIEF_MAX_CHARS,
} from "./runtime-brief.js";
import { selectStaleAwareWorkbenchEntriesForSession } from "./workbench-staleness.js";

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

function buildCompactionGateBlock(input: {
  status: ContextCompactionGateStatus["status"];
  mode: "full" | "brief";
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
  mode: "full" | "brief";
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
  // Read-time staleness companion to RCR's reversal check: a note whose digest-bound
  // anchors no longer resolve is flagged and, when the rendered set is capped, dropped
  // before live notes (downgraded, never deleted). The same stale-aware selection
  // feeds the workbench-primary compaction fallback, so neither path diverges.
  const rendered = selectStaleAwareWorkbenchEntriesForSession(runtime, sessionId, 12);
  if (rendered.length === 0) {
    return null;
  }

  const lines = ["[Workbench]"];
  for (const { entry, stale } of rendered) {
    lines.push(
      [
        `- id=${entry.id}`,
        `kind=${entry.kind}`,
        `turn=${entry.createdTurn}`,
        `digest=${entry.digest.slice(0, 12)}`,
        `reversible=${entry.reversible ? "true" : "false"}`,
        ...(stale ? ["stale=true"] : []),
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

// Model-facing runtime intelligence brief: a legible `[RuntimeBrief]` block under
// a provenance frame (see runtime-brief.ts), composing relevance-gated sections —
// context-pressure posture, an unexpected cache-break, and last-turn effects.
// Each section is silent when not decision-relevant, so the block is absent on a
// fully calm turn. Replaces the former always-on 16-line `[Context Status]` ledger
// dump and the bare consequence-digest block.
export function buildRuntimeBriefBlockForSession(
  runtime: HostedRuntimeAdapterPort,
  input: {
    sessionId: string;
    turn: number;
    usage?: ContextBudgetUsage;
  },
): HostedContextBlock | null {
  const status = getRuntimeContextStatus(runtime, input.sessionId, input.usage);
  const pressure = renderContextPressureSection({
    tokensUsed: status.tokensUsed ?? null,
    tokensTotal: status.tokensTotal ?? 0,
    compactionAdvised: status.compactionAdvised ?? false,
    forcedCompaction: status.forcedCompaction ?? false,
    predictedOverflow: status.predictedOverflow ?? false,
  });
  const effects =
    input.turn > 0 ? buildConsequenceSection(runtime, input.sessionId, input.turn) : null;
  const cache = buildCacheBreakSection(runtime, input.sessionId);
  return buildRuntimeBriefBlock({
    sections: [pressure, cache, effects],
    maxChars: RUNTIME_BRIEF_MAX_CHARS,
  });
}

function buildCacheBreakSection(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
): ReturnType<typeof renderCacheBreakSection> {
  const latest = getRuntimeContextEvidenceLatest(runtime, sessionId, "provider_cache_observation");
  const payload = latest?.payload;
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const cacheMissTokens =
    typeof record.cacheMissTokens === "number" && Number.isFinite(record.cacheMissTokens)
      ? record.cacheMissTokens
      : 0;
  return renderCacheBreakSection({
    status: typeof record.status === "string" ? record.status : "",
    expected: record.expected === true,
    reason: typeof record.reason === "string" ? record.reason : null,
    cacheMissTokens,
  });
}

function buildConsequenceSection(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
  turn: number,
): ReturnType<typeof renderConsequenceSection> {
  const digest = renderRuntimeTurnDigest(runtime, sessionId, {
    runtimeTurn: turn - 1,
    turnId: `turn-${turn - 1}`,
    maxChars: runtime.config.infrastructure.contextBudget.consequenceDigestMaxChars,
  });
  // Relevance gating lives in renderConsequenceSection (suppresses all-zero turns);
  // the digest never emits an "effects=none_recorded" sentinel, so no string guard.
  return renderConsequenceSection(digest);
}

export function buildLatestContinuationAnchorBlock(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
): HostedContextBlock | null {
  const anchor = getRuntimeTapeStatus(runtime, sessionId).lastAnchor;
  const relevance = decideContinuationAnchorRelevance(anchor);
  if (!relevance.include || !anchor) {
    return null;
  }
  const lines = [
    "[LatestContinuationAnchor]",
    `anchor: ${anchor.id}`,
    ...(anchor.name ? [`name: ${anchor.name}`] : []),
    ...(anchor.summary ? [`summary: ${anchor.summary}`] : []),
    ...(anchor.nextSteps ? [`next_steps: ${anchor.nextSteps}`] : []),
  ];
  return makeHostedContextBlock("latest-continuation-anchor", lines.join("\n"));
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
  statePort: HostedContextGateStatePort;
}): Promise<HostedDynamicTail> {
  const completed = await buildCompletedDelegationOutcomes({
    delegationStore: input.delegationStore,
    sessionId: input.sessionId,
  });
  const pressure = decideContextPressure({
    gateStatus: input.gateStatus,
    pendingCompactionReason: input.pendingCompactionReason,
  });
  const nudge = decideContextNudge({
    sessionId: input.sessionId,
    turn: input.turn,
    pressure,
    tracker: input.statePort.nudgeTracker,
  });
  const continuationAnchor = decideContinuationAnchorRelevance(
    getRuntimeTapeStatus(input.runtime, input.sessionId).lastAnchor,
  );
  const pendingDelegationsBlock = await buildPendingDelegationsBlock(
    input.delegationStore,
    input.sessionId,
  );
  const blocks = [
    nudge.kind === "gate" && nudge.mode
      ? buildCompactionGateBlock({
          status: input.gateStatus.status,
          mode: nudge.mode,
        })
      : null,
    nudge.kind === "advisory" && nudge.mode
      ? buildCompactionAdvisoryBlock({
          reason: pressure.reason ?? input.pendingCompactionReason ?? "unknown",
          status: input.gateStatus.status,
          mode: nudge.mode,
        })
      : null,
    buildRuntimeBriefBlockForSession(input.runtime, {
      sessionId: input.sessionId,
      turn: input.turn,
      usage: input.usage,
    }),
    continuationAnchor.include
      ? buildLatestContinuationAnchorBlock(input.runtime, input.sessionId)
      : null,
    buildWorkbenchBlock(input.runtime, input.sessionId),
    pendingDelegationsBlock,
    completed.block,
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
        statePort,
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
