import type { ToolActionClass } from "@brewva/brewva-runtime/security";
import { SESSION_PHASE_KINDS, type SessionPhase } from "@brewva/brewva-substrate/session";
import { resolveContextUsageTokens } from "@brewva/brewva-token-estimation";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import type { PendingEffectCommitmentRequest } from "@brewva/brewva-vocabulary/iteration";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import {
  buildOperatorSafetyShellToolView,
  isOperatorSafetyShellReadOnlyActionClass,
} from "../operator-safety/shell-view.js";
import { resolveShellCockpitComposerPolicy } from "./composer-policy.js";
import { isCockpitPinned, resolveCockpitFreshness } from "./freshness.js";
import { orderCockpitDecisionItems, orderCockpitLedgerItems } from "./ordering.js";
import {
  SHELL_COCKPIT_PROJECTION_SCHEMA_V1,
  type CockpitArchiveRef,
  type ShellCockpitChannelProjection,
  type ShellCockpitDecisionItem,
  type ShellCockpitEffectLedger,
  type ShellCockpitEffectLedgerItem,
  type ShellCockpitFoldedAnswer,
  type ShellCockpitFoldedToolCall,
  type ShellCockpitPhaseTransition,
  type ShellCockpitPhysicsBar,
  type ShellCockpitProjection,
  type ShellCockpitProjectionSource,
  type ShellCockpitRecoveryAnchorOption,
  type ShellCockpitRuntimeActivity,
  type ShellCockpitSurfaceRegion,
} from "./types.js";
import { foldShellCockpitSessionWireFrames } from "./wire-fold.js";

const DECISION_LANE_VISIBLE_ROWS = 4;
const RECOVERY_ANCHOR_LIMIT = 4;
const EFFECT_LEDGER_ITEM_LIMIT = 12;

type CockpitQuestion = ShellCockpitProjectionSource["operator"]["questions"][number];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function phaseKind(phase: SessionPhase): ShellCockpitPhysicsBar["phase"]["kind"] {
  const kind = (phase as { readonly kind?: unknown }).kind;
  return typeof kind === "string" && SESSION_PHASE_KINDS.includes(kind as SessionPhase["kind"])
    ? (kind as SessionPhase["kind"])
    : "unknown";
}

function phaseLabel(phase: SessionPhase): string {
  switch (phase.kind) {
    case "idle":
      return "idle";
    case "model_streaming":
      return `model turn ${phase.turn}`;
    case "tool_executing":
      return `${phase.toolName} running`;
    case "waiting_approval":
      return `${phase.toolName} waiting approval`;
    case "recovering":
      return "recovering";
    case "crashed":
      return `crashed at ${phase.crashAt}`;
    case "terminated":
      return `terminated ${phase.reason}`;
    default:
      return "unknown phase";
  }
}

function phaseSalience(phase: SessionPhase): ShellCockpitPhysicsBar["phase"]["salience"] {
  switch (phase.kind) {
    case "crashed":
      return "alert";
    case "recovering":
    case "waiting_approval":
      return "elevated";
    case "model_streaming":
    case "tool_executing":
      return "default";
    case "idle":
    case "terminated":
    default:
      return "muted";
  }
}

function phaseTone(phase: SessionPhase): ShellCockpitPhysicsBar["phase"]["tone"] {
  switch (phase.kind) {
    case "crashed":
      return "critical";
    case "recovering":
    case "waiting_approval":
      return "blocked";
    case "model_streaming":
    case "tool_executing":
      return "working";
    case "idle":
      return "steady";
    case "terminated":
    default:
      return "quiet";
  }
}

function phaseRefs(phase: SessionPhase): string[] {
  switch (phase.kind) {
    case "model_streaming":
      return [phase.modelCallId, `turn:${phase.turn}`];
    case "tool_executing":
      return [phase.toolCallId, phase.toolName, `turn:${phase.turn}`];
    case "waiting_approval":
      return [phase.requestId, phase.toolCallId, phase.toolName, `turn:${phase.turn}`];
    case "recovering":
      return [phase.recoveryAnchor, `turn:${phase.turn}`].filter((ref): ref is string =>
        Boolean(ref),
      );
    case "crashed":
      return [
        phase.recoveryAnchor,
        phase.toolCallId,
        phase.modelCallId,
        phase.crashAt,
        `turn:${phase.turn}`,
      ].filter((ref): ref is string => Boolean(ref));
    case "terminated":
      return [phase.reason];
    case "idle":
    default:
      return [];
  }
}

function frameRef(frame: SessionWireFrame): string {
  return frame.sourceEventId ?? frame.frameId;
}

function eventRef(event: BrewvaEventRecord): string {
  return event.id;
}

function latestClockRef(sourceClock: ReadonlyMap<string, number>, fallback: string): string {
  let latestRef = fallback;
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  for (const [ref, timestamp] of sourceClock) {
    if (timestamp > latestTimestamp || (timestamp === latestTimestamp && ref < latestRef)) {
      latestRef = ref;
      latestTimestamp = timestamp;
    }
  }
  return latestRef;
}

function buildSourceClock(source: ShellCockpitProjectionSource): Map<string, number> {
  const sourceClock = new Map<string, number>();
  sourceClock.set(`work-card:${source.sessionId}`, 0);
  if (source.wireFold) {
    for (const [ref, timestamp] of source.wireFold.sourceClock) {
      sourceClock.set(ref, timestamp);
    }
  } else {
    for (const frame of source.sessionWire) {
      sourceClock.set(frameRef(frame), frame.ts);
    }
  }
  for (const event of source.runtimeEvents) {
    sourceClock.set(eventRef(event), event.timestamp);
  }
  for (const approval of source.operator.approvals) {
    sourceClock.set(approval.requestId, approval.createdAt ?? 0);
  }
  for (const question of source.operator.questions) {
    sourceClock.set(question.questionId, question.createdAt);
  }
  for (const target of source.rewindTargets) {
    sourceClock.set(target.checkpointId, target.timestamp);
  }
  return sourceClock;
}

function latestCostEvent(source: ShellCockpitProjectionSource): BrewvaEventRecord | undefined {
  let latest: BrewvaEventRecord | undefined;
  for (const event of source.runtimeEvents) {
    if (event.type !== "cost.observed") {
      continue;
    }
    if (
      !latest ||
      event.timestamp > latest.timestamp ||
      (event.timestamp === latest.timestamp && event.id.localeCompare(latest.id) > 0)
    ) {
      latest = event;
    }
  }
  return latest;
}

function readLatestCostLabel(
  source: ShellCockpitProjectionSource,
  key: "provider" | "model",
  latestCost?: BrewvaEventRecord,
): string | null {
  const payload = asRecord(latestCost?.payload);
  const value = payload?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function decisionFreshness(
  source: ShellCockpitProjectionSource,
  sourceClock: ReadonlyMap<string, number>,
  sourceRef: string,
  stateChangedAt: number,
) {
  return resolveCockpitFreshness({
    cursor: source.observation,
    sourceClock,
    sourceRef,
    stateChangedAt,
  });
}

function approvalDecision(
  source: ShellCockpitProjectionSource,
  sourceClock: ReadonlyMap<string, number>,
  request: PendingEffectCommitmentRequest,
): ShellCockpitDecisionItem {
  const ref = request.requestId;
  const stateChangedAt = request.createdAt ?? sourceClock.get(ref) ?? 0;
  return {
    kind: "approval",
    ref,
    requestId: request.requestId,
    title: request.subject,
    toolName: request.toolName,
    boundary: request.boundary,
    detail: `${request.boundary} ${request.toolName}`,
    sourceRef: ref,
    stateChangedAt,
    freshness: decisionFreshness(source, sourceClock, ref, stateChangedAt),
    pinned: isCockpitPinned(source.observation, ref),
    actions: [
      { kind: "approve", label: "Allow once", ref },
      { kind: "deny", label: "Deny", ref },
    ],
  };
}

function questionInputContract(
  question: CockpitQuestion,
): Extract<ShellCockpitDecisionItem, { kind: "question" }>["inputContract"] {
  const optionCount = Array.isArray(question.options) ? question.options.length : 0;
  return optionCount > 0
    ? { kind: "choice", optionCount, allowFreeText: false }
    : { kind: "free_text", optionCount: 0, allowFreeText: true };
}

function questionDecision(
  source: ShellCockpitProjectionSource,
  sourceClock: ReadonlyMap<string, number>,
  question: CockpitQuestion,
): ShellCockpitDecisionItem {
  const ref = question.questionId;
  const title =
    question.header && question.header.trim().length > 0 ? question.header : question.questionText;
  const stateChangedAt = question.createdAt;
  return {
    kind: "question",
    ref,
    questionId: question.questionId,
    title,
    inputContract: questionInputContract(question),
    detail: `${question.sourceKind} ${question.sourceLabel}`,
    sourceRef: ref,
    stateChangedAt,
    freshness: decisionFreshness(source, sourceClock, ref, stateChangedAt),
    pinned: isCockpitPinned(source.observation, ref),
    actions: [{ kind: "answer", label: "Answer", ref }],
  };
}

function costGateDecision(
  source: ShellCockpitProjectionSource,
  sourceClock: ReadonlyMap<string, number>,
  latestCost?: BrewvaEventRecord,
): ShellCockpitDecisionItem | undefined {
  if (!source.cost.softGate.required) {
    return undefined;
  }
  const costObservedAtRef = latestCost?.id ?? `work-card:${source.sessionId}`;
  const stateChangedAt = sourceClock.get(costObservedAtRef) ?? 0;
  return {
    kind: "cost_gate",
    ref: `cost:${source.sessionId}`,
    title: source.cost.status === "blocked" ? "cost budget blocked" : "cost budget warning",
    posture: source.cost,
    detail: source.cost.label,
    sourceRef: costObservedAtRef,
    stateChangedAt,
    freshness: decisionFreshness(source, sourceClock, costObservedAtRef, stateChangedAt),
    pinned: isCockpitPinned(source.observation, costObservedAtRef),
    actions: [{ kind: "review_cost", label: "Review cost", ref: costObservedAtRef }],
  };
}

function buildRecoveryAnchorOptions(
  source: ShellCockpitProjectionSource,
): ShellCockpitRecoveryAnchorOption[] {
  return source.rewindTargets
    .filter((target) => target.lineage.kind === "active")
    .toSorted(
      (left, right) =>
        right.timestamp - left.timestamp || left.checkpointId.localeCompare(right.checkpointId),
    )
    .slice(0, RECOVERY_ANCHOR_LIMIT)
    .map((target) => ({
      anchorRef: target.checkpointId,
      label: target.promptPreview || `turn ${target.turn}`,
      turn: target.turn,
      effectsToRollbackCount: target.patchSetCountAfter,
      lastTrustedReceiptRef: target.checkpointId,
    }));
}

function recoveryDecision(
  source: ShellCockpitProjectionSource,
  sourceClock: ReadonlyMap<string, number>,
  anchorOptions: readonly ShellCockpitRecoveryAnchorOption[],
): ShellCockpitDecisionItem | undefined {
  if (source.phase.kind !== "recovering" && source.phase.kind !== "crashed") {
    return undefined;
  }
  const anchorRef = source.phase.recoveryAnchor ?? anchorOptions[0]?.anchorRef ?? null;
  const sourceRef = anchorRef ?? `recovery:${source.sessionId}`;
  const stateChangedAt =
    sourceClock.get(sourceRef) ?? sourceClock.get(`work-card:${source.sessionId}`) ?? 0;
  const effectsToRollbackCount = anchorOptions.reduce(
    (max, option) => Math.max(max, option.effectsToRollbackCount),
    0,
  );
  return {
    kind: "recovery_confirm",
    ref: `recovery:${source.sessionId}`,
    title: source.phase.kind === "crashed" ? "confirm recovery anchor" : "recovery in progress",
    detail:
      anchorOptions.length > 0
        ? `${anchorOptions.length} rewind anchors available`
        : "no rewind anchor is available",
    anchorOptions,
    lastTrustedReceiptRef: anchorRef,
    effectsToRollbackCount,
    sourceRef,
    stateChangedAt,
    freshness: decisionFreshness(source, sourceClock, sourceRef, stateChangedAt),
    pinned: anchorRef ? isCockpitPinned(source.observation, anchorRef) : false,
    actions: anchorOptions.map((option) => ({
      kind: "rewind" as const,
      label: `Rewind turn ${option.turn}`,
      ref: option.anchorRef,
    })),
  };
}

function buildDecisionLane(
  source: ShellCockpitProjectionSource,
  sourceClock: ReadonlyMap<string, number>,
  anchorOptions: readonly ShellCockpitRecoveryAnchorOption[],
  latestCost?: BrewvaEventRecord,
): ShellCockpitProjection["decisionLane"] {
  const costDecision = costGateDecision(source, sourceClock, latestCost);
  const recovery = recoveryDecision(source, sourceClock, anchorOptions);
  const decisions = orderCockpitDecisionItems([
    ...(recovery ? [recovery] : []),
    ...source.operator.approvals.map((approval) => approvalDecision(source, sourceClock, approval)),
    ...source.operator.questions.map((question) => questionDecision(source, sourceClock, question)),
    ...(costDecision ? [costDecision] : []),
  ]);
  const visible = decisions.slice(0, DECISION_LANE_VISIBLE_ROWS);
  return {
    active: visible[0],
    queued: visible.slice(1),
    overflowCount: Math.max(0, decisions.length - visible.length),
  };
}

function ledgerFreshness(
  source: ShellCockpitProjectionSource,
  sourceClock: ReadonlyMap<string, number>,
  sourceRef: string,
  stateChangedAt: number,
) {
  return resolveCockpitFreshness({
    cursor: source.observation,
    sourceClock,
    sourceRef,
    stateChangedAt,
  });
}

function formatDuration(startedAt: number | undefined, finishedAt: number): string | undefined {
  if (startedAt === undefined || finishedAt < startedAt) {
    return undefined;
  }
  const durationMs = finishedAt - startedAt;
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

function idleRuntimeActivity(source: ShellCockpitProjectionSource): ShellCockpitRuntimeActivity {
  if (source.phase.kind === "terminated") {
    return {
      status: "closed",
      turnId: null,
      attemptId: null,
      startedAt: null,
      lastProgressAt: null,
      lastProgressRef: null,
      promptPreview: null,
      thinkingPreview: null,
      progressLabel: `Session terminated: ${source.phase.reason}`,
      streamedChars: 0,
      providerBuffered: false,
    };
  }
  return {
    status: "idle",
    turnId: null,
    attemptId: null,
    startedAt: null,
    lastProgressAt: null,
    lastProgressRef: null,
    promptPreview: null,
    thinkingPreview: null,
    progressLabel: "Idle",
    streamedChars: 0,
    providerBuffered: false,
  };
}

function phaseFallbackRuntimeActivity(
  source: ShellCockpitProjectionSource,
): ShellCockpitRuntimeActivity {
  switch (source.phase.kind) {
    case "model_streaming":
      return {
        status: "waiting_provider",
        turnId: `turn:${source.phase.turn}`,
        attemptId: null,
        startedAt: null,
        lastProgressAt: null,
        lastProgressRef: source.phase.modelCallId,
        promptPreview: null,
        thinkingPreview: null,
        progressLabel: "Waiting for provider response",
        streamedChars: 0,
        providerBuffered: true,
      };
    case "tool_executing":
      return {
        status: "running_tool",
        turnId: `turn:${source.phase.turn}`,
        attemptId: null,
        startedAt: null,
        lastProgressAt: null,
        lastProgressRef: source.phase.toolCallId,
        promptPreview: null,
        thinkingPreview: null,
        progressLabel: `${source.phase.toolName} running`,
        streamedChars: 0,
        providerBuffered: false,
      };
    case "waiting_approval":
      return {
        status: "waiting_approval",
        turnId: `turn:${source.phase.turn}`,
        attemptId: null,
        startedAt: null,
        lastProgressAt: null,
        lastProgressRef: source.phase.requestId,
        promptPreview: null,
        thinkingPreview: null,
        progressLabel: `${source.phase.toolName} waiting approval`,
        streamedChars: 0,
        providerBuffered: false,
      };
    case "recovering":
      return {
        status: "recovering",
        turnId: `turn:${source.phase.turn}`,
        attemptId: null,
        startedAt: null,
        lastProgressAt: null,
        lastProgressRef: source.phase.recoveryAnchor ?? null,
        promptPreview: null,
        thinkingPreview: null,
        progressLabel: "Recovering session",
        streamedChars: 0,
        providerBuffered: false,
      };
    case "crashed":
      return {
        status: "crashed",
        turnId: `turn:${source.phase.turn}`,
        attemptId: null,
        startedAt: null,
        lastProgressAt: null,
        lastProgressRef:
          source.phase.toolCallId ??
          source.phase.modelCallId ??
          source.phase.recoveryAnchor ??
          null,
        promptPreview: null,
        thinkingPreview: null,
        progressLabel: `Crashed at ${source.phase.crashAt}`,
        streamedChars: 0,
        providerBuffered: false,
      };
    default:
      return idleRuntimeActivity(source);
  }
}

function buildRuntimeActivity(source: ShellCockpitProjectionSource): ShellCockpitRuntimeActivity {
  if (source.wireFold?.runtimeActivity) {
    return source.wireFold.runtimeActivity;
  }
  return phaseFallbackRuntimeActivity(source);
}

function answerLedgerRef(input: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly attemptId: string;
}): string {
  return `answer:${input.sessionId}:${input.turnId}:${input.attemptId}`;
}

function newerFoldedAnswer(
  candidate: ShellCockpitFoldedAnswer,
  current: ShellCockpitFoldedAnswer | undefined,
): boolean {
  return (
    !current ||
    candidate.ts > current.ts ||
    (candidate.ts === current.ts && candidate.latestFrameRef > current.latestFrameRef)
  );
}

function buildFoldedAnswerLedgerItem(
  source: ShellCockpitProjectionSource,
  sourceClock: ReadonlyMap<string, number>,
): ShellCockpitEffectLedgerItem | undefined {
  const streaming = source.wireFold?.latestStreamingAnswer;
  const committed = source.wireFold?.latestCommittedAnswer;
  const answer =
    streaming && newerFoldedAnswer(streaming, committed)
      ? streaming
      : committed && committed.text.trim().length > 0
        ? committed
        : undefined;
  if (!answer) {
    return undefined;
  }

  const answerText = answer.text.trim();
  if (answerText.length === 0) {
    return undefined;
  }
  const ref = answerLedgerRef({
    sessionId: source.sessionId,
    turnId: answer.turnId,
    attemptId: answer.attemptId,
  });
  const active = answer.status === "active";
  return {
    kind: "answer",
    consequence: "answer",
    ref,
    title: "Assistant answer",
    status: active ? "active" : "committed",
    verdict: active ? "running" : "committed",
    summary: answerText,
    content: answerText,
    ...(active ? {} : { durationText: formatDuration(answer.startedAt, answer.ts) }),
    expandable: true,
    sourceRef: answer.latestFrameRef,
    stateChangedAt: answer.ts,
    freshness: ledgerFreshness(source, sourceClock, answer.latestFrameRef, answer.ts),
    pinned:
      isCockpitPinned(source.observation, ref) ||
      isCockpitPinned(source.observation, answer.latestFrameRef),
    archiveRefs: [answer.latestFrameRef],
  };
}

function buildAnswerLedgerItem(
  source: ShellCockpitProjectionSource,
  sourceClock: ReadonlyMap<string, number>,
): ShellCockpitEffectLedgerItem | undefined {
  return source.wireFold ? buildFoldedAnswerLedgerItem(source, sourceClock) : undefined;
}

function toolActionClass(toolName: string, status?: string): ToolActionClass | undefined {
  return buildOperatorSafetyShellToolView({ toolName, status }).actionClass;
}

function toolConsequence(input: {
  readonly toolName: string;
  readonly status: "running" | "failed" | "completed";
}): {
  readonly actionClass?: ToolActionClass;
  readonly readOnly: boolean;
  readonly consequence: ShellCockpitEffectLedgerItem["consequence"];
} {
  const actionClass = toolActionClass(
    input.toolName,
    input.status === "failed" ? "error" : input.status === "completed" ? "completed" : "running",
  );
  if (!actionClass) {
    return { actionClass, readOnly: false, consequence: "unknown_receipt" };
  }
  const readOnly = isOperatorSafetyShellReadOnlyActionClass(actionClass);
  if (input.status === "failed") {
    return {
      actionClass,
      readOnly,
      consequence: readOnly ? "failed_observation" : "failed_effect",
    };
  }
  if (input.status === "running") {
    return {
      actionClass,
      readOnly,
      consequence: readOnly ? "active_observation" : "active_effect",
    };
  }
  return {
    actionClass,
    readOnly,
    consequence: readOnly ? "ordinary_receipt" : "effect_receipt",
  };
}

function buildFoldedToolLedgerItems(
  source: ShellCockpitProjectionSource,
  sourceClock: ReadonlyMap<string, number>,
  toolCalls: readonly ShellCockpitFoldedToolCall[],
): ShellCockpitEffectLedger {
  const items: ShellCockpitEffectLedgerItem[] = [];
  const ordinaryRefs: string[] = [];
  let ordinaryStartedAt = Number.POSITIVE_INFINITY;
  let ordinarySourceRef = "";

  for (const tool of toolCalls) {
    const classification = toolConsequence({
      toolName: tool.toolName,
      status: tool.status,
    });
    if (tool.status === "failed") {
      items.push({
        kind: "failed_tool",
        consequence: classification.consequence,
        ref: tool.latestRef,
        title: `${tool.toolName} failed`,
        status: "failed",
        verdict: "failed",
        actionClass: classification.actionClass,
        summary: classification.readOnly
          ? "Observation failed; no effect receipt was committed."
          : "Effectful tool failed before a committed receipt.",
        durationText: formatDuration(tool.startedAt, tool.latestAt),
        expandable: true,
        sourceRef: tool.latestRef,
        stateChangedAt: tool.latestAt,
        freshness: ledgerFreshness(source, sourceClock, tool.latestRef, tool.latestAt),
        pinned: isCockpitPinned(source.observation, tool.latestRef),
        archiveRefs: [tool.latestRef],
      });
      continue;
    }
    if (tool.status === "completed") {
      if (classification.readOnly) {
        ordinaryRefs.push(tool.latestRef);
        if (tool.latestAt < ordinaryStartedAt) {
          ordinaryStartedAt = tool.latestAt;
          ordinarySourceRef = tool.latestRef;
        }
        continue;
      }
      items.push({
        kind: "effect_receipt",
        consequence: classification.consequence,
        ref: tool.latestRef,
        title: `${tool.toolName} committed`,
        status: "committed",
        verdict: "committed",
        actionClass: classification.actionClass,
        summary:
          classification.consequence === "unknown_receipt"
            ? "Receipt was archived; action class is unavailable."
            : "Effect receipt committed and archived.",
        durationText: formatDuration(tool.startedAt, tool.latestAt),
        expandable: true,
        rollbackRef:
          source.workCard.evidence.latestPatchSetRef ??
          source.workCard.handoff.anchorId ??
          undefined,
        sourceRef: tool.latestRef,
        stateChangedAt: tool.latestAt,
        freshness: ledgerFreshness(source, sourceClock, tool.latestRef, tool.latestAt),
        pinned: isCockpitPinned(source.observation, tool.latestRef),
        archiveRefs: [tool.latestRef],
      });
      continue;
    }

    items.push({
      kind: "active_tool",
      consequence: classification.consequence,
      ref: tool.startedRef ?? tool.latestRef,
      title: `${tool.toolName} running`,
      status: "active",
      verdict: "running",
      actionClass: classification.actionClass,
      summary: classification.readOnly ? "Observation is running." : "Effectful tool is running.",
      expandable: true,
      sourceRef: tool.latestRef,
      stateChangedAt: tool.latestAt,
      freshness: ledgerFreshness(source, sourceClock, tool.latestRef, tool.latestAt),
      pinned: isCockpitPinned(source.observation, tool.latestRef),
      archiveRefs: [tool.latestRef],
    });
  }

  if (ordinaryRefs.length > 0) {
    const ref = "ordinary-receipts";
    items.push({
      kind: "ordinary_receipt_summary",
      consequence: "ordinary_receipt",
      ref,
      title: `+${ordinaryRefs.length} read/search receipts`,
      status: "summarized",
      verdict: "summarized",
      summary: "Read-only receipts are archived outside the main ledger.",
      expandable: true,
      sourceRef: ordinarySourceRef,
      stateChangedAt: ordinaryStartedAt,
      freshness: ledgerFreshness(source, sourceClock, ordinarySourceRef, ordinaryStartedAt),
      pinned: ordinaryRefs.some((ordinaryRef) => isCockpitPinned(source.observation, ordinaryRef)),
      receiptCount: ordinaryRefs.length,
      archiveRefs: ordinaryRefs,
    });
  }

  const answer = buildAnswerLedgerItem(source, sourceClock);
  if (answer) {
    items.push(answer);
  }
  const orderedItems = orderCockpitLedgerItems(items);
  const visibleItems = orderedItems.slice(0, EFFECT_LEDGER_ITEM_LIMIT);

  return {
    items: visibleItems,
    collapsedReceiptCount: ordinaryRefs.length,
    overflowCount: Math.max(0, orderedItems.length - visibleItems.length),
  };
}

function buildToolLedgerItems(
  source: ShellCockpitProjectionSource,
  sourceClock: ReadonlyMap<string, number>,
): ShellCockpitEffectLedger {
  if (!source.wireFold) {
    return {
      items: [],
      collapsedReceiptCount: 0,
      overflowCount: 0,
    };
  }
  return buildFoldedToolLedgerItems(source, sourceClock, source.wireFold.toolCalls);
}

function buildArchiveRefs(source: ShellCockpitProjectionSource): CockpitArchiveRef[] {
  return [
    {
      kind: "transcript",
      ref: `transcript:${source.sessionId}`,
      label: "Transcript archive",
    },
    {
      kind: "event_tape",
      ref: `tape:${source.sessionId}`,
      label: "Event tape",
    },
    {
      kind: "context",
      ref: `context:${source.sessionId}`,
      label: "Context cockpit",
    },
  ];
}

function buildSurfaceRegions(input: {
  readonly projectionPhase: SessionPhase;
  readonly recoveryActive: boolean;
}): ShellCockpitSurfaceRegion[] {
  const regions: ShellCockpitSurfaceRegion[] = [
    "physics_bar",
    "current_work_card",
    "decision_lane",
    "effect_ledger",
    "attention_glance",
  ];
  if (input.recoveryActive) {
    regions.push("recovery_lane");
  }
  if (input.projectionPhase.kind !== "terminated") {
    regions.push("composer");
  }
  return regions;
}

function buildCurrentWorkCard(
  source: ShellCockpitProjectionSource,
  sourceClock: ReadonlyMap<string, number>,
): ShellCockpitProjection["currentWorkCard"] {
  const workCardRef = `work-card:${source.sessionId}`;
  return {
    source: "task_work_card_projection",
    ref: workCardRef,
    freshness: resolveCockpitFreshness({
      cursor: source.observation,
      sourceClock,
      sourceRef: workCardRef,
      stateChangedAt: sourceClock.get(workCardRef) ?? 0,
    }),
    pinned: isCockpitPinned(source.observation, workCardRef),
    summary: {
      goal: source.workCard.goal.current,
      persistentGoal: {
        objective: source.workCard.persistentGoal?.objective ?? null,
        status: source.workCard.persistentGoal?.status ?? null,
        tokensUsed: source.workCard.persistentGoal?.tokensUsed ?? 0,
        tokenBudget: source.workCard.persistentGoal?.tokenBudget ?? null,
        latestContinuationRef: source.workCard.persistentGoal?.latestContinuationRef ?? null,
        latestCompletionEvidenceRef:
          source.workCard.persistentGoal?.latestCompletionEvidenceRef ?? null,
        latestBlockEvidenceRef: source.workCard.persistentGoal?.latestBlockEvidenceRef ?? null,
      },
      phase: source.workCard.goal.phase,
      health: source.workCard.goal.health,
      contextPressure: source.workCard.context.pressure,
      workbenchEntryCount: source.workCard.context.workbenchEntryCount,
      activeRunCount: source.workCard.work.activeRunCount,
      pendingAskCount: source.workCard.authority.pendingAskCount,
      verificationOutcome: source.workCard.evidence.verificationOutcome,
      verificationDebtCount: source.workCard.evidence.verificationDebtCount,
      missingChecks: source.workCard.evidence.missingChecks,
      missingEvidence: source.workCard.evidence.missingEvidence,
      refs: source.workCard.refs,
    },
    archiveRefs: source.workCard.refs,
  };
}

function buildAttentionGlance(
  source: ShellCockpitProjectionSource,
): ShellCockpitProjection["attentionGlance"] {
  const tokenEstimate = resolveContextUsageTokens(source.contextCockpit.context.usage);
  const highPressureNow =
    source.workCard.context.pressure === "high" || source.workCard.context.pressure === "forced";
  return {
    activeWorkbenchCount: source.contextCockpit.workbench.activeCount,
    tokenEstimate,
    workbenchPinnedRefs: source.workCard.options.pinnedRefs,
    workbenchConsumedRefs: source.workCard.options.consumedRefs,
    evictedRefs: [],
    staleRefs: source.workCard.options.ignoredRefs,
    recallRefs: source.workCard.context.recallResultRefs,
    compactBaselineRef: source.workCard.context.compactBaselineRef,
    runway: {
      turnsUntilHighPressure: highPressureNow ? 0 : null,
      burnRateTokensPerTurn: null,
    },
  };
}

function buildRecoveryLane(input: {
  readonly source: ShellCockpitProjectionSource;
  readonly anchorOptions: readonly ShellCockpitRecoveryAnchorOption[];
}): ShellCockpitProjection["recoveryLane"] {
  const active = input.source.phase.kind === "recovering" || input.source.phase.kind === "crashed";
  const anchorRef =
    active && "recoveryAnchor" in input.source.phase
      ? (input.source.phase.recoveryAnchor ?? input.anchorOptions[0]?.anchorRef ?? null)
      : null;
  return {
    active,
    anchorRef,
    targetCount: input.source.rewindTargets.length,
    lastTrustedReceiptRef: anchorRef,
    anchorOptions: input.anchorOptions,
  };
}

function buildChannels(source: ShellCockpitProjectionSource): ShellCockpitChannelProjection[] {
  if (source.channels && source.channels.length > 0) {
    return [...source.channels];
  }
  return [
    {
      kind: "cli",
      id: `cli:${source.sessionId}`,
      label: "CLI",
      status: source.phase.kind === "crashed" ? "blocked" : "active",
      sessionId: source.sessionId,
    },
  ];
}

function buildTransitions(source: ShellCockpitProjectionSource): ShellCockpitPhaseTransition[] {
  return [...(source.transitionsSince ?? [])].slice(-5);
}

function normalizeProjectionSource(
  input: ShellCockpitProjectionSource,
): ShellCockpitProjectionSource {
  if (input.wireFold || input.sessionWire.length === 0) {
    return input;
  }
  return {
    ...input,
    sessionWire: [],
    wireFold: foldShellCockpitSessionWireFrames({
      sessionId: input.sessionId,
      frames: input.sessionWire,
    }),
  };
}

export function projectShellCockpitProjection(
  input: ShellCockpitProjectionSource,
): ShellCockpitProjection {
  const source = normalizeProjectionSource(input);
  const sourceClock = buildSourceClock(source);
  const workCardRef = `work-card:${source.sessionId}`;
  const generatedAtRef = latestClockRef(sourceClock, workCardRef);
  const anchorOptions = buildRecoveryAnchorOptions(source);
  const latestCost = latestCostEvent(source);
  const decisionLane = buildDecisionLane(source, sourceClock, anchorOptions, latestCost);
  const effectLedger = buildToolLedgerItems(source, sourceClock);
  const recoveryLane = buildRecoveryLane({ source, anchorOptions });
  const costObservedAtRef = latestCost?.id ?? null;
  const composerPolicy = resolveShellCockpitComposerPolicy({
    phase: source.phase,
    activeDecision: decisionLane.active,
    costStatus: source.cost.status,
  });

  return {
    schema: SHELL_COCKPIT_PROJECTION_SCHEMA_V1,
    version: 1,
    sessionId: source.sessionId,
    generatedAtRef,
    surfaceRegions: buildSurfaceRegions({
      projectionPhase: source.phase,
      recoveryActive: recoveryLane.active,
    }),
    observation: source.observation,
    physicsBar: {
      phase: {
        kind: phaseKind(source.phase),
        label: phaseLabel(source.phase),
        tone: phaseTone(source.phase),
        salience: phaseSalience(source.phase),
        blockingComposer: composerPolicy === "block",
        refs: phaseRefs(source.phase),
      },
      providerLabel:
        source.runtimeLabels?.providerLabel ?? readLatestCostLabel(source, "provider", latestCost),
      modelLabel:
        source.runtimeLabels?.modelLabel ?? readLatestCostLabel(source, "model", latestCost),
      context: {
        pressure: source.workCard.context.pressure,
        workbenchEntryCount: source.contextCockpit.workbench.activeCount,
        compactBaselineRef: source.workCard.context.compactBaselineRef,
      },
      cost: source.cost,
      costObservedAtRef,
      cachePosture: source.contextCockpit.cachePosture,
      sandboxPosture: source.runtimeLabels?.sandboxPosture ?? "unknown",
    },
    runtimeActivity: buildRuntimeActivity(source),
    currentWorkCard: buildCurrentWorkCard(source, sourceClock),
    decisionLane,
    effectLedger,
    attentionGlance: buildAttentionGlance(source),
    recoveryLane,
    channels: buildChannels(source),
    transitionsSince: buildTransitions(source),
    composerPolicy,
    archiveRefs: buildArchiveRefs(source),
  };
}
