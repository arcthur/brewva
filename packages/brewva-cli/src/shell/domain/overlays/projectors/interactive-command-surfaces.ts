import { estimateModelTokens } from "@brewva/brewva-token-estimation";
import type {
  ContextBudgetUsage,
  ContextCompactionGateStatus,
  ContextCompactionReason,
  ContextEvidenceSample,
  ContextStatus,
} from "@brewva/brewva-vocabulary/context";
import type { SkillDocument, SkillRegistryLoadReport } from "@brewva/brewva-vocabulary/session";
import {
  listSkillResourceRefs,
  type HistoryViewBaselineSnapshot,
} from "@brewva/brewva-vocabulary/session";
import type { OperatorSurfaceSnapshot } from "../../operator-snapshot.js";
import { fuzzyScore } from "../../search-scoring.js";
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

function formatPromptStabilityEvidence(sample: ContextEvidenceSample | undefined): string {
  if (!sample) {
    return "evidence=none";
  }
  const p = sample.payload;
  return [
    `turn=${sample.turn}`,
    `scope=${(p.scopeKey as string) ?? "?"}`,
    `stablePrefix=${formatBoolean(p.stablePrefix as boolean)}`,
    `stableTail=${formatBoolean(p.stableTail as boolean)}`,
    `updatedAt=${formatTimestamp(sample.timestamp)}`,
  ].join(" ");
}

function formatTransientReductionEvidence(sample: ContextEvidenceSample | undefined): string {
  if (!sample) {
    return "evidence=none";
  }
  const p = sample.payload;
  return [
    `turn=${sample.turn}`,
    `status=${(p.status as string) ?? "?"}`,
    `reason=${formatOptionalString(p.reason as string | null)}`,
    `cleared=${(p.clearedToolResults as number) ?? "?"}`,
    `updatedAt=${formatTimestamp(sample.timestamp)}`,
  ].join(" ");
}

function formatProviderCacheEvidence(sample: ContextEvidenceSample | undefined): string {
  if (!sample) {
    return "evidence=none";
  }
  const p = sample.payload;
  return [
    `turn=${sample.turn}`,
    `source=${(p.source as string) ?? "?"}`,
    `updatedAt=${formatTimestamp(sample.timestamp)}`,
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
  promptStabilityEvidence: ContextEvidenceSample | undefined;
  transientReductionEvidence: ContextEvidenceSample | undefined;
  providerCacheEvidence: ContextEvidenceSample | undefined;
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
      `Prediction: growth=${status.predictedTurnGrowthTokens} overflow=${formatBoolean(status.predictedOverflow ?? false)} untilOverflow=${formatOptionalNumber(status.tokensUntilPredictedOverflow)}`,
      `Compaction: advised=${formatBoolean(status.compactionAdvised ?? false)} forced=${formatBoolean(status.forcedCompaction ?? false)} pending=${formatOptionalString(input.pendingCompactionReason)}`,
      `Gate: required=${formatBoolean(gate.required ?? false)} reason=${formatOptionalString(gate.reason)} recent=${formatBoolean(gate.recentCompaction ?? false)} windowTurns=${gate.windowTurns} lastTurn=${formatOptionalNumber(gate.lastCompactionTurn)} turnsSince=${formatOptionalNumber(gate.turnsSinceCompaction)}`,
      `Prompt: ${formatPromptStabilityEvidence(input.promptStabilityEvidence)}`,
      `Reduction: ${formatTransientReductionEvidence(input.transientReductionEvidence)}`,
      `Provider cache: ${formatProviderCacheEvidence(input.providerCacheEvidence)}`,
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
    selectedReceiptId?: string;
    sourceDiscovery?: string;
    conflicts?: number;
  };
  operatorSafety?: {
    pendingAsks: number;
    denials: number;
    receiptIds: readonly string[];
    recentDecisions?: readonly {
      decision: string;
      toolName: string;
      actionClass?: string | null;
      requestId?: string | null;
      reason?: string | null;
      receiptIds: readonly string[];
    }[];
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
    ? formatList(capabilitySummary.selectedCapabilities ?? [], 4)
    : "unavailable";
  const requiredCapabilities = capabilitySummary
    ? formatList(capabilitySummary.requiredCapabilities, 4)
    : "unavailable";
  const selectedReceipt = capabilitySummary
    ? (capabilitySummary.selectedReceiptId ?? "none")
    : "unavailable";
  const sourceDiscovery = capabilitySummary
    ? (capabilitySummary.sourceDiscovery ?? "tool_metadata")
    : "unavailable";
  const manifestAvailability = capabilitySummary
    ? `managedTools=${capabilitySummary.managedTools} capabilityScopedTools=${capabilitySummary.capabilityScopedTools}`
    : "unavailable";
  const toolAccessWarnings =
    input.toolAccess?.filter((access) => !access.allowed || access.warning || access.reason) ?? [];
  const toolAccessSummary = input.toolAccess
    ? `checked=${input.toolAccess.length} warnings=${toolAccessWarnings.filter((access) => access.warning).length} blocked=${toolAccessWarnings.filter((access) => !access.allowed).length}`
    : "unavailable";
  const pendingAskTools = formatList(
    input.snapshot.approvals.map((approval) => approval.toolName),
    4,
  );
  const operatorSafetySummary = input.operatorSafety
    ? `pendingAsks=${input.operatorSafety.pendingAsks} denials=${input.operatorSafety.denials} receipts=${formatList(input.operatorSafety.receiptIds, 4)}`
    : `pendingAsks=${input.snapshot.approvals.length} denials=unavailable receipts=unavailable`;
  const lines = [
    `Pending asks: ${input.snapshot.approvals.length}`,
    `Operator questions: ${input.snapshot.questions.length}`,
    `Task runs: ${input.snapshot.taskRuns.length}`,
    `Capabilities: ${manifestAvailability} selected=${selected} required=${requiredCapabilities} conflicts=${capabilitySummary?.conflicts ?? "unavailable"}`,
    `Operator safety: ${operatorSafetySummary}`,
    `Authority facts: sourceDiscovery=${sourceDiscovery} manifestAvailability=${manifestAvailability} selectedReceipt=${selectedReceipt} actionPolicy=${toolAccessSummary}`,
    `Scopes: selectedCapabilities=${selected} requiredCapabilities=${requiredCapabilities} pendingAskTools=${pendingAskTools}`,
    `Tool access: ${toolAccessSummary}`,
  ];
  for (const ask of input.snapshot.approvals.slice(0, 3)) {
    // Recoverability answers "can this be undone" at the approval point; the
    // world-rewindable suffix flags that a `/rewind code` can restore the
    // workspace even when the per-effect tier cannot.
    const recovery = ask.recoverability
      ? ` recovery=${ask.recoverability}${ask.workspaceRewindable ? "+rewindable" : ""}`
      : "";
    lines.push(
      `- Ask ${ask.requestId} tool=${ask.toolName} boundary=${ask.boundary} effects=${formatList(ask.effects ?? [], 4)}${recovery} evidence=${formatList(
        (ask.evidenceRefs ?? []).map((ref) => ref.id),
        4,
      )}`,
    );
  }
  for (const decision of input.operatorSafety?.recentDecisions?.slice(-3) ?? []) {
    lines.push(
      `- Safety ${decision.decision} tool=${decision.toolName} action=${decision.actionClass ?? "n/a"} request=${decision.requestId ?? "n/a"} reason=${decision.reason ?? "n/a"} receipts=${formatList(decision.receiptIds, 4)}`,
    );
  }
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

const SKILL_CATEGORY_ORDER = new Map(
  ["core", "project", "domain", "operator", "meta"].map((category, index) => [category, index]),
);

function formatPlural(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function normalizeInlineText(value: string | null | undefined): string {
  return value?.trim().replace(/\s+/gu, " ") ?? "";
}

function formatCategoryTitle(category: string): string {
  const normalized = normalizeInlineText(category).replace(/[_-]+/gu, " ");
  if (!normalized) {
    return "Other";
  }
  return normalized
    .split(" ")
    .map((part) => (part ? `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}` : part))
    .join(" ");
}

function categoryRank(category: string): number {
  return SKILL_CATEGORY_ORDER.get(category.toLowerCase()) ?? SKILL_CATEGORY_ORDER.size;
}

function compareSkills(left: SkillDocument, right: SkillDocument): number {
  const categoryDelta = categoryRank(left.category) - categoryRank(right.category);
  if (categoryDelta !== 0) {
    return categoryDelta;
  }
  const categoryNameDelta = left.category.localeCompare(right.category);
  if (categoryNameDelta !== 0) {
    return categoryNameDelta;
  }
  return left.name.localeCompare(right.name);
}

function skillSearchScore(query: string, skill: SkillDocument): number | null {
  const fields = [
    skill.name,
    skill.category,
    skill.description,
    skill.card.description,
    skill.card.selection?.whenToUse,
  ].filter((field): field is string => typeof field === "string");
  let best: number | null = null;
  for (const field of fields) {
    const score = fuzzyScore(query, field);
    if (score === null) {
      continue;
    }
    best = best === null ? score : Math.max(best, score);
  }
  return best;
}

function buildSkillsSummary(loadReport: SkillRegistryLoadReport): string {
  const outOfScopeCount = loadReport.outOfScopeSkills?.length ?? 0;
  const outOfScopeSuffix =
    outOfScopeCount > 0
      ? `; ${formatPlural(outOfScopeCount, "project skill")} out of workspace scope`
      : "";
  return `${formatPlural(loadReport.loadedSkills.length, "skill")} available; ${formatPlural(
    loadReport.selectableSkills.length,
    "selectable skill",
  )}; ${formatPlural(loadReport.overlaySkills.length, "project overlay", "project overlays")}; ${formatPlural(
    loadReport.roots.length,
    "source root",
  )}${outOfScopeSuffix}.`;
}

function skillTokenEstimate(skill: SkillDocument): number {
  return estimateModelTokens(
    [skill.name, skill.description, skill.card.selection?.whenToUse, skill.markdown]
      .filter((entry): entry is string => Boolean(entry))
      .join("\n"),
  ).tokens;
}

function formatSkillCardDetail(input: {
  readonly source: string;
  readonly whyRelevant: string;
  readonly tokenEstimate: number;
  readonly resourceRefs: readonly string[];
  readonly outputArtifacts: readonly string[];
}): string {
  return [
    `source=${input.source}`,
    `why=${input.whyRelevant}`,
    `tokens=${input.tokenEstimate}`,
    `resources=${formatList(input.resourceRefs, 3)}`,
    `outputs=${formatList(input.outputArtifacts, 3)}`,
    "authority=none",
  ].join(" | ");
}

export function buildSkillsOverlayPayload(input: {
  query?: string;
  selectedIndex?: number;
  loadReport: SkillRegistryLoadReport;
  skills: readonly SkillDocument[];
}): CliSkillsOverlayPayload {
  const query = input.query ?? "";
  const selectableSkillNames = new Set(input.loadReport.selectableSkills);
  const scoredSkills = input.skills
    .filter((skill) => selectableSkillNames.has(skill.name))
    .map((skill) => ({ skill, score: skillSearchScore(query, skill) }))
    .filter((entry): entry is { skill: SkillDocument; score: number } => entry.score !== null)
    .toSorted((left, right) => {
      if (query.trim()) {
        const scoreDelta = right.score - left.score;
        if (scoreDelta !== 0) {
          return scoreDelta;
        }
      }
      return compareSkills(left.skill, right.skill);
    });
  const items = scoredSkills.map(({ skill }) => {
    const description = normalizeInlineText(skill.description || skill.card.description);
    const whyRelevant = normalizeInlineText(skill.card.selection?.whenToUse) || description;
    const resourceRefs = listSkillResourceRefs(skill).map((ref) => `${ref.kind}:${ref.path}`);
    const outputArtifacts = skill.card.outputArtifacts ?? [];
    const tokenEstimate = skillTokenEstimate(skill);
    return {
      id: `skill:${skill.name}`,
      skillName: skill.name,
      category: skill.category,
      source: skill.filePath,
      whyRelevant,
      tokenEstimate,
      resourceRefs,
      outputArtifacts,
      authorityPosture: "none" as const,
      section: formatCategoryTitle(skill.category),
      label: skill.name,
      detail: formatSkillCardDetail({
        source: skill.filePath,
        whyRelevant,
        tokenEstimate,
        resourceRefs,
        outputArtifacts,
      }),
    };
  });
  const selectedIndex =
    items.length === 0 ? 0 : Math.max(0, Math.min(input.selectedIndex ?? 0, items.length - 1));
  return {
    kind: "skills",
    title: "Skills",
    query,
    selectedIndex,
    summary: buildSkillsSummary(input.loadReport),
    items,
    emptyMessage: query.trim()
      ? "No skills match the current search."
      : "No selectable skills are loaded.",
  };
}
