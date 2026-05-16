import type {
  ContextBudgetUsage,
  ContextCompactionGateStatus,
  ContextCompactionReason,
  ContextStatus,
  HistoryViewBaselineSnapshot,
  PromptStabilityState,
  ProviderCacheObservationState,
  TransientReductionState,
} from "@brewva/brewva-runtime/context";
import type {
  ProducerContract,
  SkillDocument,
  SkillRegistryLoadReport,
} from "@brewva/brewva-runtime/skills";
import type { OperatorSurfaceSnapshot } from "../../operator-snapshot.js";
import type {
  CliAuthorityOverlayPayload,
  CliContextOverlayPayload,
  CliSkillsOverlayPayload,
} from "../payloads.js";

function formatOptionalString(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "none";
}

function formatOptionalNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "unknown";
}

function formatBoolean(value: boolean): string {
  return value ? "true" : "false";
}

function formatRatio(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${(value * 100).toFixed(1)}%`
    : "unknown";
}

function formatTimestamp(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : "unknown";
}

function formatShortHash(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 12) : "none";
}

function formatList(values: readonly string[], limit: number): string {
  if (values.length === 0) {
    return "none";
  }
  const visible = values.slice(0, limit).join(",");
  const remaining = values.length - limit;
  return remaining > 0 ? `${visible},+${remaining}` : visible;
}

function formatUsage(usage: ContextBudgetUsage | undefined): string {
  if (!usage) {
    return "tokens=unknown window=unknown ratio=unknown maxOutput=unknown";
  }
  return [
    `tokens=${formatOptionalNumber(usage.tokens)}`,
    `window=${formatOptionalNumber(usage.contextWindow)}`,
    `ratio=${formatRatio(usage.percent)}`,
    `maxOutput=${formatOptionalNumber(usage.maxOutputTokens)}`,
  ].join(" ");
}

function formatPromptStability(state: PromptStabilityState | undefined): string {
  if (!state) {
    return "state=none";
  }
  return [
    `turn=${state.turn}`,
    `scope=${state.scopeKey}`,
    `stablePrefixHash=${formatShortHash(state.stablePrefixHash)}`,
    `dynamicTailHash=${formatShortHash(state.dynamicTailHash)}`,
    `stablePrefix=${formatBoolean(state.stablePrefix)}`,
    `stableTail=${formatBoolean(state.stableTail)}`,
    `updatedAt=${formatTimestamp(state.updatedAt)}`,
  ].join(" ");
}

function formatTransientReduction(state: TransientReductionState | undefined): string {
  if (!state) {
    return "state=none";
  }
  return [
    `turn=${state.turn}`,
    `status=${state.status}`,
    `reason=${formatOptionalString(state.reason)}`,
    `eligible=${state.eligibleToolResults}`,
    `cleared=${state.clearedToolResults}`,
    `clearedChars=${state.clearedChars}`,
    `estimatedTokenSavings=${state.estimatedTokenSavings}`,
    `expectedCacheBreak=${formatBoolean(state.expectedCacheBreak)}`,
    `classification=${formatOptionalString(state.classification)}`,
  ].join(" ");
}

function formatProviderCache(state: ProviderCacheObservationState | undefined): string {
  if (!state) {
    return "state=none";
  }
  return [
    `turn=${state.turn}`,
    `source=${state.source}`,
    `provider=${state.fingerprint.provider}`,
    `api=${state.fingerprint.api}`,
    `model=${state.fingerprint.model}`,
    `render=${state.render.status}`,
    `retention=${state.render.renderedRetention}`,
    `break=${state.breakObservation.status}`,
    `classification=${state.breakObservation.classification}`,
    `expected=${formatBoolean(state.breakObservation.expected)}`,
    `changedFields=${formatList(state.breakObservation.changedFields, 4)}`,
  ].join(" ");
}

function formatHistoryBaseline(snapshot: HistoryViewBaselineSnapshot | undefined): string {
  if (!snapshot) {
    return "state=none";
  }
  return [
    `compactId=${snapshot.compactId}`,
    `origin=${snapshot.origin}`,
    `sourceTurn=${snapshot.sourceTurn}`,
    `fromTokens=${formatOptionalNumber(snapshot.fromTokens)}`,
    `toTokens=${formatOptionalNumber(snapshot.toTokens)}`,
    `summaryDigest=${formatShortHash(snapshot.summaryDigest)}`,
    `rebuildSource=${snapshot.rebuildSource}`,
    `diagnostics=${snapshot.diagnostics.length}`,
  ].join(" ");
}

export function buildContextOverlayPayload(input: {
  sessionId: string;
  usage: ContextBudgetUsage | undefined;
  status: ContextStatus;
  pendingCompactionReason: ContextCompactionReason | null;
  gateStatus: ContextCompactionGateStatus;
  promptStability: PromptStabilityState | undefined;
  transientReduction: TransientReductionState | undefined;
  providerCache: ProviderCacheObservationState | undefined;
  visibleReadEpoch: number;
  historyViewBaseline: HistoryViewBaselineSnapshot | undefined;
}): CliContextOverlayPayload {
  const status = input.status;
  const gate = input.gateStatus;
  return {
    kind: "context",
    sessionId: input.sessionId,
    canRequestCompaction: true,
    lines: [
      `Session: ${input.sessionId}`,
      `Usage: ${formatUsage(input.usage)}`,
      `Pressure: used=${formatOptionalNumber(status.tokensUsed)} remaining=${formatOptionalNumber(status.tokensRemaining)} total=${status.tokensTotal} effectiveTotal=${status.effectiveTokensTotal} ratio=${formatRatio(status.usageRatio)}`,
      `Limits: threshold=${formatRatio(status.compactionThresholdRatio)} hard=${formatRatio(status.hardLimitRatio)} autoCompactLimit=${status.autoCompactLimitTokens} forcedRemaining=${formatOptionalNumber(status.tokensUntilForcedCompact)}`,
      `Controllable: baseline=${status.controllableBaselineTokens} used=${formatOptionalNumber(status.controllableTokensUsed)} remaining=${formatOptionalNumber(status.controllableTokensRemaining)} total=${status.controllableTokensTotal} remainingRatio=${formatRatio(status.controllableContextRemainingRatio)}`,
      `Prediction: growth=${status.predictedTurnGrowthTokens} overflow=${formatBoolean(status.predictedOverflow)} untilOverflow=${formatOptionalNumber(status.tokensUntilPredictedOverflow)}`,
      `Compaction: advised=${formatBoolean(status.compactionAdvised)} forced=${formatBoolean(status.forcedCompaction)} pending=${formatOptionalString(input.pendingCompactionReason)}`,
      `Gate: required=${formatBoolean(gate.required)} reason=${formatOptionalString(gate.reason)} recent=${formatBoolean(gate.recentCompaction)} windowTurns=${gate.windowTurns} lastTurn=${formatOptionalNumber(gate.lastCompactionTurn)} turnsSince=${formatOptionalNumber(gate.turnsSinceCompaction)}`,
      `Prompt: ${formatPromptStability(input.promptStability)}`,
      `Reduction: ${formatTransientReduction(input.transientReduction)}`,
      `Provider cache: ${formatProviderCache(input.providerCache)}`,
      `History baseline: ${formatHistoryBaseline(input.historyViewBaseline)}`,
      `Visible read: visibleReadEpoch=${input.visibleReadEpoch}`,
      "Action: Request compaction with c or Command Palette > Context: request compaction.",
    ],
  };
}

export function buildAuthorityOverlayPayload(input: {
  snapshot: OperatorSurfaceSnapshot;
  capabilitySummary?: {
    managedTools: number;
    capabilityScopedTools: number;
    requiredCapabilities: readonly string[];
    selectedCapabilities?: readonly string[];
    conflicts?: number;
  };
  toolAccess?: readonly {
    toolName: string;
    allowed: boolean;
    warning?: string;
    reason?: string;
  }[];
}): CliAuthorityOverlayPayload {
  const capabilitySummary = input.capabilitySummary;
  const selected = capabilitySummary
    ? capabilitySummary.selectedCapabilities?.join(",") || "not surfaced"
    : "not surfaced";
  const requiredCapabilities = capabilitySummary
    ? formatList(capabilitySummary.requiredCapabilities, 4)
    : "not surfaced";
  const toolAccessWarnings =
    input.toolAccess?.filter((access) => !access.allowed || access.warning || access.reason) ?? [];
  const toolAccessSummary = input.toolAccess
    ? `checked=${input.toolAccess.length} warnings=${toolAccessWarnings.filter((access) => access.warning).length} blocked=${toolAccessWarnings.filter((access) => !access.allowed).length}`
    : "not surfaced";
  const lines = [
    `Pending approvals: ${input.snapshot.approvals.length}`,
    `Operator questions: ${input.snapshot.questions.length}`,
    `Task runs: ${input.snapshot.taskRuns.length}`,
    `Capabilities: managedTools=${capabilitySummary?.managedTools ?? "not surfaced"} capabilityScopedTools=${capabilitySummary?.capabilityScopedTools ?? "not surfaced"} selected=${selected} required=${requiredCapabilities} conflicts=${capabilitySummary?.conflicts ?? "not surfaced"}`,
    "Scopes: network=not surfaced gateway=not surfaced channel=not surfaced",
    `Tool access: ${toolAccessSummary}`,
  ];
  if (toolAccessWarnings.length > 0) {
    for (const access of toolAccessWarnings) {
      const suffix = access.warning
        ? ` warning=${access.warning}`
        : access.reason
          ? ` reason=${access.reason}`
          : "";
      lines.push(`- ${access.toolName} allowed=${access.allowed}${suffix}`);
    }
  }
  return { kind: "authority", lines };
}

function formatSkillRoute(skill: SkillDocument, loadReport: SkillRegistryLoadReport): string {
  if (loadReport.selectableSkills.includes(skill.name)) {
    return "selectable";
  }
  if (loadReport.overlaySkills.includes(skill.name)) {
    return "overlay";
  }
  return "loaded";
}

function formatSkillSelection(skill: SkillDocument): string {
  const triggers = skill.card.selection?.triggers ?? [];
  const globs = skill.card.selection?.pathGlobs ?? [];
  const hints = [
    triggers.length > 0 ? `triggers=${formatList(triggers, 3)}` : undefined,
    globs.length > 0 ? `pathGlobs=${formatList(globs, 3)}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return hints.length > 0 ? hints.join(" ") : "routingHints=none";
}

export function buildSkillsOverlayPayload(input: {
  loadReport: SkillRegistryLoadReport;
  skills: readonly SkillDocument[];
  producers: readonly ProducerContract[];
}): CliSkillsOverlayPayload {
  const lines = [
    `Skills: loaded=${input.loadReport.loadedSkills.length} selectable=${input.loadReport.selectableSkills.length} overlay=${input.loadReport.overlaySkills.length} roots=${input.loadReport.roots.length}`,
    `Project guidance: ${input.loadReport.projectGuidance.length}`,
  ];
  for (const skill of input.skills) {
    lines.push(
      [
        `- skill=${skill.name}`,
        `category=${skill.category}`,
        `route=${formatSkillRoute(skill, input.loadReport)}`,
        formatSkillSelection(skill),
        `resources=${skill.resources.references.length}/${skill.resources.scripts.length}/${skill.resources.invariants.length}`,
        `file=${skill.filePath}`,
      ].join(" "),
    );
  }
  if (input.skills.length === 0) {
    lines.push("No skills are currently loaded.");
  }
  for (const producer of input.producers) {
    lines.push(
      [
        `- producer=${producer.producer}`,
        `source=${producer.source}`,
        `outputs=${formatList(producer.outputs, 5)}`,
        `semanticBindings=${Object.keys(producer.semanticBindings).length}`,
        `file=${producer.filePath}`,
      ].join(" "),
    );
  }
  if (input.producers.length === 0) {
    lines.push("No skill producers are currently loaded.");
  }
  return {
    kind: "skills",
    lines,
  };
}
