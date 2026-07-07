import { redactedStableJsonSha256Hex } from "@brewva/brewva-std/hash";
import type { BrewvaAgentProtocolMessage } from "@brewva/brewva-substrate/agent-protocol";
import type { InternalHostPluginApi } from "@brewva/brewva-substrate/host-api";
import {
  buildTapeRequirementDebtSummary,
  buildTapeReviewDebt,
  type TapeRequirementDebtSummary,
} from "@brewva/brewva-tools/runtime-port";
import type {
  ContextBudgetUsage,
  ContextCompactionGateStatus,
  ContextCompactionReason,
} from "@brewva/brewva-vocabulary/context";
import {
  deriveParallelBudgetStateFromEvents,
  type DelegationRunRecord,
} from "@brewva/brewva-vocabulary/delegation";
import { decideContinuationAnchorRelevance } from "@brewva/brewva-vocabulary/session";
import { TASK_REQUIREMENT_RECORDED_EVENT_TYPE } from "@brewva/brewva-vocabulary/task";
import { isAttentionPinnedWorkbenchEntry } from "@brewva/brewva-vocabulary/workbench";
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
  listRuntimeEvents,
  renderRuntimeTurnDigest,
  type HostedRuntimeAdapterPort,
} from "../session/runtime-ports.js";
import { estimateTokens } from "../session/tools/tool-output-distiller.js";
import { renderCapabilityView, type BuildCapabilityViewResult } from "./capability-view.js";
import { applyContextContract } from "./context-contract.js";
import {
  decideContextNudge,
  decideContextPressure,
  type ContextLifecyclePressureDecision,
  type ContextNudgeCadenceTracker,
} from "./context-lifecycle.js";
import { resolveContextScopeId } from "./context-shared.js";
import { buildFailureRecurrenceSection } from "./failure-recurrence.js";
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
  formatTokens,
  renderCacheBreakSection,
  renderConsequenceSection,
  renderContextPressureSection,
  renderDelegationAdvisorySection,
  renderRequirementDebtSection,
  RUNTIME_BRIEF_MAX_CHARS,
} from "./runtime-brief.js";
import {
  listActiveWorkbenchEntriesForSession,
  selectStaleAwareWorkbenchEntriesForSession,
} from "./workbench-staleness.js";

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
    pinnedEntries: number;
    pinnedEstimatedTokens: number;
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
  workbenchEntries: Readonly<ReturnType<HostedRuntimeAdapterPort["ops"]["workbench"]["list"]>>;
}): HostedWorkbenchContextMessageDetails {
  const notes = input.workbenchEntries.filter((entry) => entry.kind === "note").length;
  const evictions = input.workbenchEntries.filter((entry) => entry.kind === "eviction").length;
  const pinnedMass = measurePinnedWorkbenchMass(input.workbenchEntries);
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
      pinnedEntries: pinnedMass.entries,
      pinnedEstimatedTokens: pinnedMass.estimatedTokens,
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

interface PinnedWorkbenchMass {
  entries: number;
  estimatedTokens: number;
}

/**
 * Token mass of `attention_pin` entries — the accounted cost of the retention
 * contract (R2b): pins are excluded from every drop candidate set, so their
 * size must stay a paid, visible choice instead of silent permanent weight.
 */
export function measurePinnedWorkbenchMass(
  entries: readonly {
    readonly content?: string;
    readonly text?: string;
    readonly sourceRefs: readonly string[];
    readonly preservedQuotes?: readonly string[];
    readonly retentionHint?: string;
  }[],
): PinnedWorkbenchMass {
  const pinned = entries.filter((entry) => isAttentionPinnedWorkbenchEntry(entry));
  const estimatedTokens = pinned.reduce(
    (sum, entry) =>
      sum +
      estimateTokens(
        [
          entry.content ?? entry.text,
          entry.sourceRefs.join(", "),
          entry.preservedQuotes?.join(" | "),
        ]
          .filter((part): part is string => Boolean(part))
          .join("\n"),
      ),
    0,
  );
  return { entries: pinned.length, estimatedTokens };
}

function buildWorkbenchBlock(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
): HostedContextBlock | null {
  // Read-time staleness companion to RCR's reversal check: a note whose digest-bound
  // anchors no longer resolve is flagged and, when the rendered set is capped, dropped
  // before live notes (downgraded, never deleted). The same stale-aware selection
  // feeds the workbench-primary compaction fallback, so neither path diverges.
  // `attention_pin` entries sit outside the drop candidate set (retention contract);
  // their token mass is stated in the header so pinning stays a paid, visible choice.
  const rendered = selectStaleAwareWorkbenchEntriesForSession(runtime, sessionId, 12);
  if (rendered.length === 0) {
    return null;
  }

  const pinnedMass = measurePinnedWorkbenchMass(rendered.map((item) => item.entry));
  const lines = [
    pinnedMass.entries > 0
      ? `[Workbench] pinned=${pinnedMass.entries} (~${formatTokens(pinnedMass.estimatedTokens)} tokens held by attention_pin)`
      : "[Workbench]",
  ];
  for (const { entry, stale } of rendered) {
    lines.push(
      [
        `- id=${entry.id}`,
        `kind=${entry.kind}`,
        `turn=${entry.createdTurn}`,
        `digest=${entry.digest.slice(0, 12)}`,
        `reversible=${entry.reversible ? "true" : "false"}`,
        ...(isAttentionPinnedWorkbenchEntry(entry) ? ["pinned=true"] : []),
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
// context-pressure posture, an unexpected cache-break, last-turn effects,
// repeated identical tool failures (failure-recurrence.ts), requirement debt
// (R4), and the delegation advisory (Lever 2, when a delegation context is
// threaded in).
// Each section is silent when not decision-relevant, so the block is absent on a
// fully calm turn. Replaces the former always-on 16-line `[Context Status]` ledger
// dump and the bare consequence-digest block.
/**
 * Inputs the delegation advisory (Lever 2) needs that the brief's own section
 * builders do not — the compaction gate/pressure state (for the ADVISORY-tier
 * pressure-relief reason and the "would the gate reject" budget suppression) and
 * the delegation cadence tracker. Threaded from `buildHostedDynamicTail`, which
 * already holds them, so the section can live in the brief's sections array
 * (after `requirements`) exactly like every other section. Absent → the
 * advisory is silent (e.g. a caller with no delegation store).
 */
export interface DelegationAdvisoryContext {
  readonly gateStatus: ContextCompactionGateStatus;
  readonly pendingCompactionReason: ContextCompactionReason | null;
  readonly cadenceTracker: ContextNudgeCadenceTracker;
  /**
   * The session has a delegation store (delegation is available at all). False →
   * the advisory is suppressed: recommending an action with no store to serve it
   * is worse than silence.
   */
  readonly delegationEnabled: boolean;
}

export function buildRuntimeBriefBlockForSession(
  runtime: HostedRuntimeAdapterPort,
  input: {
    sessionId: string;
    turn: number;
    usage?: ContextBudgetUsage;
    delegationAdvisory?: DelegationAdvisoryContext;
  },
): HostedContextBlock | null {
  const status = getRuntimeContextStatus(runtime, input.sessionId, input.usage);
  // Pinned mass is a paid-choice signal that only renders WITH pressure, so a
  // calm turn never pays the workbench scan for it.
  const pressureRelevant =
    (status.forcedCompaction ?? false) ||
    (status.compactionAdvised ?? false) ||
    (status.predictedOverflow ?? false);
  const pressure = renderContextPressureSection({
    tokensUsed: status.tokensUsed ?? null,
    tokensTotal: status.tokensTotal ?? 0,
    compactionAdvised: status.compactionAdvised ?? false,
    forcedCompaction: status.forcedCompaction ?? false,
    predictedOverflow: status.predictedOverflow ?? false,
    pinnedTokens: pressureRelevant
      ? measurePinnedWorkbenchMass(listActiveWorkbenchEntriesForSession(runtime, input.sessionId))
          .estimatedTokens
      : 0,
  });
  const effects =
    input.turn > 0 ? buildConsequenceSection(runtime, input.sessionId, input.turn) : null;
  const cache = buildCacheBreakSection(runtime, input.sessionId);
  const recurrence = buildFailureRecurrenceSection(runtime, input.sessionId);
  // Single-home the whole-tape requirement fitness: derive it ONCE (short-circuit
  // when no requirement atoms were recorded) and feed BOTH the requirement-debt
  // section and the delegation advisory's independence-debt reason, so a turn never
  // re-projects fitness twice.
  const requirementEvents = listRuntimeEvents(runtime, input.sessionId);
  const requirementDebtSummary = requirementEvents.some(
    (event) => event.type === TASK_REQUIREMENT_RECORDED_EVENT_TYPE,
  )
    ? buildTapeRequirementDebtSummary(requirementEvents)
    : null;
  const requirements = buildRequirementDebtSection(requirementDebtSummary);
  const delegation = input.delegationAdvisory
    ? buildDelegationAdvisorySection(
        runtime,
        input.sessionId,
        input.turn,
        input.delegationAdvisory,
        requirementDebtSummary,
      )
    : null;
  return buildRuntimeBriefBlock({
    sections: [pressure, cache, effects, recurrence, requirements, delegation],
    maxChars: RUNTIME_BRIEF_MAX_CHARS,
  });
}

/**
 * R4: surface the requirement debt run-report already computes for the operator
 * to the PRODUCING model at turn tail — so "done" is not declared blind. Reuses
 * the SINGLE shared tape-debt read (`buildTapeRequirementDebtSummary`, one fitness
 * derivation) so the operator and model views can never diverge. Relevance-gated
 * inside the renderer: silent when there is no ladder/coverage debt AND no
 * presence-only high-risk atom.
 */
function buildRequirementDebtSection(
  summary: TapeRequirementDebtSummary | null,
): ReturnType<typeof renderRequirementDebtSection> {
  // The whole-tape fitness is derived ONCE by the caller (single-home) and passed
  // in — null on the (common) turns that recorded no requirement atoms (the cheap
  // short-circuit now lives at the caller).
  if (!summary) {
    return null;
  }
  return renderRequirementDebtSection({
    unverifiedMustCount: summary.debt.unverifiedMustCount,
    debtReason: summary.debt.reason,
    insufficientGradeCount: summary.fitness.insufficientGradeAtoms.length,
  });
}

/**
 * Would the parallel-admission gate reject a NEW delegation right now, given only
 * tape-derived budget state + config? A pure mirror of the gate's own `evaluate`
 * reject predicate (parallel-admission.ts): reject when concurrency is at the
 * ceiling OR the session lifetime cap is exhausted. Deliberately uses the BASE
 * `maxConcurrent` ceiling, ignoring the lease-raised ceiling the live gate can
 * grant — leases only RAISE the ceiling, so this over-predicts rejection at
 * worst, keeping the advisory silent slightly more often (the safe direction: an
 * advisory the gate would refuse is worse than silence). No side effects, unlike
 * a probe `acquire`.
 */
function parallelGateWouldReject(runtime: HostedRuntimeAdapterPort, sessionId: string): boolean {
  const config = runtime.config.parallel;
  if (!config.enabled) {
    return false;
  }
  const budget = deriveParallelBudgetStateFromEvents(listRuntimeEvents(runtime, sessionId));
  if (budget.totalStarted >= config.maxTotalPerSession) {
    return true;
  }
  return budget.activeCount >= config.maxConcurrent;
}

/**
 * Lever 2: the render-time delegation advisory. Names delegation as an instrument
 * at turn tail, inform-only (axiom 18 — derives NO gate). Two reasons decided
 * here from runtime state, then rendered by {@link renderDelegationAdvisorySection}:
 *
 *  - pressure-relief: context pressure is at the ADVISORY tier
 *    (`decideContextPressure(...).action === "workbench_compact_soon"`, NOT the
 *    gate tier).
 *  - review-debt-closure: the shared tape read (`buildTapeReviewDebt`, the SAME
 *    projection the CLI operator surfaces use) reports open review debt.
 *
 * SUPPRESSION — silent unless actionable, because an advisory recommending an
 * action the gate will refuse is worse than silence:
 *  - no delegation store (`delegationEnabled === false`);
 *  - a delegation is already pending/running on the tape;
 *  - the parallel gate would reject a new delegation (no budget).
 *
 * CADENCE — the delegation tracker (its own instance) is keyed `delegation:<reason>`
 * via a synthetic ADVISORY-tier pressure decision, so the advisory renders
 * full-then-brief (the runtime brief has no stub-vs-full distinction, so a
 * `brief` verdict simply suppresses this turn) and never nags every turn.
 */
function buildDelegationAdvisorySection(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
  turn: number,
  context: DelegationAdvisoryContext,
  requirementDebtSummary: TapeRequirementDebtSummary | null,
): ReturnType<typeof renderDelegationAdvisorySection> {
  // Suppression 1: no store to serve the recommendation.
  if (!context.delegationEnabled) {
    return null;
  }
  const pressure = decideContextPressure({
    gateStatus: context.gateStatus,
    pendingCompactionReason: context.pendingCompactionReason,
  });
  const pressureRelief = pressure.action === "workbench_compact_soon";
  // NOTE (Open Question, Lever 2): on a post-implementation turn the R4
  // requirement-debt section also says "dispatch an independent review", so this
  // review-debt reason DELIBERATELY complements it with the economic framing (the
  // one `independent` receipt the model cannot mint for itself) rather than
  // repeating it. Salience-ordered (this section is `low`, requirement debt is
  // `normal`), so under budget the delegation line demotes to its stub first. A
  // maintainer may gate this on `requirementDebtRendered` if the overlap outweighs
  // the framing — tracked in the RFC.
  const reviewDebtClosure = buildTapeReviewDebt(listRuntimeEvents(runtime, sessionId)).debt;
  // Independence debt reuses the SAME single fitness derivation the requirement-debt
  // section reads (passed in), never re-projecting: high-risk `must` atoms that
  // reached close with no independent OR deterministic pass at the risk-floor grade.
  const independenceDebt = (requirementDebtSummary?.fitness.independenceDebtAtoms.length ?? 0) > 0;
  // Nothing to say → silent before paying for any suppression checks.
  if (!pressureRelief && !reviewDebtClosure && !independenceDebt) {
    return null;
  }
  // Suppression 2: a delegation is already in flight — the model has already
  // reached for the instrument; recommending it again is noise.
  const alreadyPending =
    deriveParallelBudgetStateFromEvents(listRuntimeEvents(runtime, sessionId)).activeCount > 0;
  if (alreadyPending) {
    return null;
  }
  // Suppression 3: the gate would refuse a new delegation (no budget).
  if (parallelGateWouldReject(runtime, sessionId)) {
    return null;
  }
  // Cadence: full-then-brief. The reason string picks the cadence bucket, so a
  // change of reason resets the window to full (a genuinely new actionable reason
  // deserves a fresh render); the tracker holds one state per session.
  // Independence debt is the most specific reason (it names high-risk atoms), so it
  // takes the cadence bucket over the coarser review-debt when both are live.
  // KNOWN LIMITATION (low): the bucket key is the lead reason, so were independence
  // and review-debt to alternate turn-by-turn the full-then-brief window would reset
  // each turn and bypass the anti-nag cadence. Independence debt is near-monotone on
  // the tape (it clears only when an at-grade pass binds an atom), so that alternation
  // is not realistic — left keyed by reason rather than widened to a reason-agnostic
  // bucket, which would lose the "a genuinely new actionable reason deserves a fresh
  // render" semantics.
  const reason = pressureRelief
    ? "delegation:pressure_relief"
    : independenceDebt
      ? "delegation:independence_debt"
      : "delegation:review_debt";
  if (!delegationAdvisoryCadenceAllows(context.cadenceTracker, sessionId, turn, reason)) {
    return null;
  }
  return renderDelegationAdvisorySection({ pressureRelief, reviewDebtClosure, independenceDebt });
}

/**
 * Full-then-brief cadence for the delegation advisory, reusing the compaction
 * nudge tracker's shape (a SEPARATE instance, so no cross-talk). A synthetic
 * ADVISORY-tier pressure decision carrying the delegation reason drives the
 * tracker to key `advisory:delegation:<reason>` and emit `full` on the first
 * render then `brief` within the cooldown window. The runtime brief has no
 * stub-vs-full form for this section, so `brief` is treated as "hold this turn":
 * the advisory renders on the full turns and stays silent between them, which is
 * exactly the anti-nag behavior wanted.
 */
function delegationAdvisoryCadenceAllows(
  tracker: ContextNudgeCadenceTracker,
  sessionId: string,
  turn: number,
  reason: string,
): boolean {
  const syntheticPressure: ContextLifecyclePressureDecision = {
    action: "workbench_compact_soon",
    reason,
  };
  const decision = tracker.decide({ sessionId, turn, pressure: syntheticPressure });
  return decision.mode === "full";
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
      delegationAdvisory: {
        gateStatus: input.gateStatus,
        pendingCompactionReason: input.pendingCompactionReason,
        cadenceTracker: input.statePort.delegationAdvisoryTracker,
        // The advisory only makes sense where delegation can actually be served;
        // absent a store, suppress it (a recommendation with no store is noise).
        delegationEnabled: input.delegationStore !== undefined,
      },
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
        workbenchEntries: listActiveWorkbenchEntriesForSession(runtime, input.sessionId),
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
          workbenchEntries: listActiveWorkbenchEntriesForSession(runtime, input.sessionId),
        }),
      });
    },
  };
}
