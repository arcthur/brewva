import type {
  CockpitArchiveRef,
  ShellCockpitDecisionItem,
  ShellCockpitEffectLedgerItem,
  ShellCockpitProjection,
  ShellCockpitRecoveryAnchorOption,
} from "../../cockpit/index.js";
import type {
  CliCockpitArchiveOverlayItem,
  CliCockpitArchiveOverlayItemKind,
  CliCockpitArchiveOverlayPayload,
  CliCockpitAttentionOverlayPayload,
} from "../payloads.js";

const MAX_DETAIL_LINES = 80;
const MAX_LINE_WIDTH = 180;

function compactList(values: readonly string[], limit = 6): string {
  if (values.length === 0) {
    return "none";
  }
  if (values.length <= limit) {
    return values.join(", ");
  }
  return `${values.slice(0, limit).join(", ")} +${values.length - limit}`;
}

function formatMaybe(value: string | number | null | undefined, fallback = "none"): string {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : fallback;
  }
  return value && value.length > 0 ? value : fallback;
}

function boundLine(line: string): string {
  return line.length <= MAX_LINE_WIDTH ? line : `${line.slice(0, MAX_LINE_WIDTH - 1)}...`;
}

function boundLines(lines: readonly string[]): string[] {
  const bounded = lines.slice(0, MAX_DETAIL_LINES).map(boundLine);
  if (lines.length > MAX_DETAIL_LINES) {
    bounded.push(`... ${lines.length - MAX_DETAIL_LINES} lines omitted`);
  }
  return bounded;
}

function decisionDetailLines(item: ShellCockpitDecisionItem): string[] {
  const common = [
    `kind: ${item.kind}`,
    `ref: ${item.ref}`,
    `source: ${item.sourceRef}`,
    `freshness: ${item.freshness}`,
    `title: ${item.title}`,
    `actions: ${item.actions.map((action) => action.label).join(", ") || "none"}`,
  ];
  switch (item.kind) {
    case "approval":
      return boundLines([
        ...common,
        `request: ${item.requestId}`,
        `tool: ${item.toolName}`,
        `boundary: ${item.boundary}`,
        `diff: ${formatMaybe(item.diffRef)}`,
        `patch: ${formatMaybe(item.patchRef)}`,
        "",
        item.detail,
      ]);
    case "question":
      return boundLines([
        ...common,
        `question: ${item.questionId}`,
        `input: ${item.inputContract.kind}`,
        `options: ${item.inputContract.optionCount}`,
        `freeText: ${String(item.inputContract.allowFreeText)}`,
        "",
        item.detail,
      ]);
    case "cost_gate":
      return boundLines([
        ...common,
        `posture: ${item.posture.status}`,
        `cost: ${item.posture.shortLabel}`,
        "",
        item.detail,
      ]);
    case "adoption":
      return boundLines([...common, `patch: ${item.patchRef}`, "", item.detail]);
    case "recovery_confirm":
      return boundLines([
        ...common,
        `lastTrustedReceipt: ${formatMaybe(item.lastTrustedReceiptRef)}`,
        `effectsToRollback: ${item.effectsToRollbackCount}`,
        "",
        ...item.anchorOptions.map(renderAnchorOption),
        "",
        item.detail,
      ]);
    case "manual_gate":
      return boundLines([...common, "", item.detail]);
    default: {
      const exhaustiveCheck: never = item;
      return exhaustiveCheck;
    }
  }
}

function renderAnchorOption(option: ShellCockpitRecoveryAnchorOption): string {
  return [
    `anchor=${option.anchorRef}`,
    `turn=${option.turn}`,
    `rollback=${option.effectsToRollbackCount}`,
    `trusted=${formatMaybe(option.lastTrustedReceiptRef)}`,
    option.label,
  ].join(" | ");
}

function effectDetailLines(item: ShellCockpitEffectLedgerItem): string[] {
  return boundLines([
    `kind: ${item.kind}`,
    `consequence: ${item.consequence}`,
    `ref: ${item.ref}`,
    `source: ${item.sourceRef}`,
    `status: ${item.status}`,
    `verdict: ${item.verdict}`,
    `actionClass: ${formatMaybe(item.actionClass)}`,
    `duration: ${formatMaybe(item.durationText)}`,
    `rollback: ${formatMaybe(item.rollbackRef)}`,
    `expandable: ${String(item.expandable)}`,
    `archiveRefs: ${compactList(item.archiveRefs)}`,
    "",
    item.title,
    item.summary,
  ]);
}

function topArchiveDetailLines(
  projection: ShellCockpitProjection,
  archiveRef: CockpitArchiveRef,
): string[] {
  switch (archiveRef.kind) {
    case "transcript":
      return boundLines([
        `kind: ${archiveRef.kind}`,
        `ref: ${archiveRef.ref}`,
        `session: ${projection.sessionId}`,
        "",
        "Transcript details stay outside the default cockpit surface. Use the transcript archive command or external pager for the full transcript.",
      ]);
    case "event_tape":
      return boundLines([
        `kind: ${archiveRef.kind}`,
        `ref: ${archiveRef.ref}`,
        `session: ${projection.sessionId}`,
        `latestProjectionRef: ${projection.generatedAtRef}`,
        "",
        "The event tape remains the replay authority. The cockpit archive exposes bounded anchors, not raw tape payloads.",
      ]);
    case "context":
      return boundLines([
        `kind: ${archiveRef.kind}`,
        `ref: ${archiveRef.ref}`,
        `pressure: ${projection.physicsBar.context.pressure}`,
        `workbench: ${projection.attentionGlance.activeWorkbenchCount}`,
        `tokens: ${formatMaybe(projection.attentionGlance.tokenEstimate)}`,
        `compactBaseline: ${formatMaybe(projection.attentionGlance.compactBaselineRef)}`,
      ]);
    case "receipt":
    case "tool_output":
    case "replay":
      return boundLines([
        `kind: ${archiveRef.kind}`,
        `ref: ${archiveRef.ref}`,
        "",
        "This cockpit anchor has a bounded summary. Full raw content remains in replay/archive storage.",
      ]);
    default: {
      const exhaustiveCheck: never = archiveRef.kind;
      return exhaustiveCheck;
    }
  }
}

function workDetailLines(projection: ShellCockpitProjection): string[] {
  const work = projection.currentWorkCard.summary;
  return boundLines([
    `ref: ${projection.currentWorkCard.ref}`,
    `freshness: ${projection.currentWorkCard.freshness}`,
    `goal: ${formatMaybe(work.goal, "no active goal")}`,
    `phase: ${formatMaybe(work.phase, "unknown")}`,
    `health: ${formatMaybe(work.health, "unknown")}`,
    `contextPressure: ${work.contextPressure}`,
    `workbench: ${work.workbenchEntryCount}`,
    `activeRuns: ${work.activeRunCount}`,
    `pendingAsks: ${work.pendingAskCount}`,
    `verification: ${formatMaybe(work.verificationOutcome, "pending")}`,
    `verificationDebt: ${work.verificationDebtCount}`,
    `missingChecks: ${compactList(work.missingChecks)}`,
    `missingEvidence: ${compactList(work.missingEvidence)}`,
    `refs: ${compactList(work.refs)}`,
  ]);
}

function attentionDetailLines(projection: ShellCockpitProjection): string[] {
  const attention = projection.attentionGlance;
  return boundLines([
    `workbench: ${attention.activeWorkbenchCount}`,
    `tokens: ${formatMaybe(attention.tokenEstimate)}`,
    `runway: ${formatMaybe(attention.runway.turnsUntilHighPressure)} turns`,
    `burnRate: ${formatMaybe(attention.runway.burnRateTokensPerTurn)} tokens/turn`,
    `compactBaseline: ${formatMaybe(attention.compactBaselineRef)}`,
    `pinned: ${compactList(attention.workbenchPinnedRefs)}`,
    `consumed: ${compactList(attention.workbenchConsumedRefs)}`,
    `evicted: ${compactList(attention.evictedRefs)}`,
    `stale: ${compactList(attention.staleRefs)}`,
    `recall: ${compactList(attention.recallRefs)}`,
  ]);
}

function recoveryDetailLines(projection: ShellCockpitProjection): string[] {
  const recovery = projection.recoveryLane;
  return boundLines([
    `active: ${String(recovery.active)}`,
    `anchor: ${formatMaybe(recovery.anchorRef)}`,
    `targets: ${recovery.targetCount}`,
    `lastTrustedReceipt: ${formatMaybe(recovery.lastTrustedReceiptRef)}`,
    "",
    ...recovery.anchorOptions.map(renderAnchorOption),
  ]);
}

function channelDetailLines(projection: ShellCockpitProjection): string[] {
  return boundLines(
    projection.channels.length > 0
      ? projection.channels.map(
          (channel) =>
            `${channel.kind}:${channel.id} | ${channel.status} | ${channel.label} | session=${formatMaybe(channel.sessionId)}`,
        )
      : ["No parallel channels are visible in this projection."],
  );
}

function transitionDetailLines(projection: ShellCockpitProjection): string[] {
  return boundLines(
    projection.transitionsSince.length > 0
      ? projection.transitionsSince.map(
          (transition) =>
            `${transition.from} -> ${transition.to} | ref=${transition.sourceRef} | at=${transition.changedAt}`,
        )
      : ["No recent phase transitions are visible in this projection."],
  );
}

export function buildCockpitAttentionOverlayPayload(input: {
  projection: ShellCockpitProjection;
}): CliCockpitAttentionOverlayPayload {
  return {
    kind: "cockpitAttention",
    title: "Attention",
    sessionId: input.projection.sessionId,
    sourceProjectionRef: input.projection.generatedAtRef,
    lines: attentionDetailLines(input.projection),
  };
}

export function buildCockpitArchiveOverlayPayload(input: {
  projection: ShellCockpitProjection;
  selectedRef?: string;
}): CliCockpitArchiveOverlayPayload {
  const items: CliCockpitArchiveOverlayItem[] = [];
  const seen = new Set<string>();
  const addItem = (
    kind: CliCockpitArchiveOverlayItemKind,
    ref: string,
    label: string,
    detailLines: readonly string[],
  ) => {
    if (!ref || seen.has(ref)) {
      return;
    }
    seen.add(ref);
    items.push({ kind, ref, label, detailLines: boundLines([...detailLines]) });
  };

  for (const archiveRef of input.projection.archiveRefs) {
    addItem(
      archiveRef.kind,
      archiveRef.ref,
      archiveRef.label,
      topArchiveDetailLines(input.projection, archiveRef),
    );
  }

  addItem(
    "work",
    input.projection.currentWorkCard.ref,
    "Current work",
    workDetailLines(input.projection),
  );
  for (const ref of input.projection.currentWorkCard.archiveRefs) {
    addItem("work", ref, `Work evidence ${ref}`, workDetailLines(input.projection));
  }

  const decisions = [
    input.projection.decisionLane.active,
    ...input.projection.decisionLane.queued,
  ].filter((item): item is ShellCockpitDecisionItem => Boolean(item));
  for (const decision of decisions) {
    addItem("decision", decision.ref, decision.title, decisionDetailLines(decision));
    addItem("decision", decision.sourceRef, `Decision source ${decision.sourceRef}`, [
      `source: ${decision.sourceRef}`,
      ...decisionDetailLines(decision),
    ]);
    if (decision.kind === "approval" && decision.diffRef) {
      addItem("decision", decision.diffRef, `Decision diff ${decision.diffRef}`, [
        `diff: ${decision.diffRef}`,
        ...decisionDetailLines(decision),
      ]);
    }
    if (
      (decision.kind === "approval" || decision.kind === "adoption") &&
      "patchRef" in decision &&
      decision.patchRef
    ) {
      addItem("decision", decision.patchRef, `Decision patch ${decision.patchRef}`, [
        `patch: ${decision.patchRef}`,
        ...decisionDetailLines(decision),
      ]);
    }
  }

  for (const item of input.projection.effectLedger.items) {
    addItem("effect", item.ref, item.title, effectDetailLines(item));
    addItem("effect", item.sourceRef, `Effect source ${item.sourceRef}`, effectDetailLines(item));
    for (const ref of item.archiveRefs) {
      addItem("effect", ref, `Effect archive ${ref}`, effectDetailLines(item));
    }
  }

  for (const ref of [
    ...input.projection.attentionGlance.workbenchPinnedRefs,
    ...input.projection.attentionGlance.workbenchConsumedRefs,
    ...input.projection.attentionGlance.evictedRefs,
    ...input.projection.attentionGlance.staleRefs,
    ...input.projection.attentionGlance.recallRefs,
  ]) {
    addItem("attention", ref, `Attention ${ref}`, attentionDetailLines(input.projection));
  }
  if (input.projection.attentionGlance.compactBaselineRef) {
    addItem(
      "attention",
      input.projection.attentionGlance.compactBaselineRef,
      "Compact baseline",
      attentionDetailLines(input.projection),
    );
  }

  if (input.projection.recoveryLane.active || input.projection.recoveryLane.anchorOptions.length) {
    addItem(
      "recovery",
      input.projection.recoveryLane.anchorRef ?? "recovery:active",
      "Recovery",
      recoveryDetailLines(input.projection),
    );
    for (const option of input.projection.recoveryLane.anchorOptions) {
      addItem("recovery", option.anchorRef, option.label, recoveryDetailLines(input.projection));
    }
  }

  addItem("channel", "channels", "Channels", channelDetailLines(input.projection));
  addItem(
    "transition",
    "transitions",
    "Phase transitions",
    transitionDetailLines(input.projection),
  );

  if (input.selectedRef && !seen.has(input.selectedRef)) {
    addItem("unknown", input.selectedRef, `Unavailable ${input.selectedRef}`, [
      `ref: ${input.selectedRef}`,
      "",
      "No bounded cockpit detail is available for this ref.",
    ]);
  }

  const selectedIndex = Math.max(
    0,
    input.selectedRef ? items.findIndex((item) => item.ref === input.selectedRef) : 0,
  );
  return {
    kind: "cockpitArchive",
    title: "Cockpit archive",
    sessionId: input.projection.sessionId,
    generatedAtRef: input.projection.generatedAtRef,
    selectedIndex,
    items,
    scrollOffsets: items.map(() => 0),
  };
}
