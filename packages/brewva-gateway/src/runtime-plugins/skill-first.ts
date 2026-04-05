import {
  listSkillFallbackTools,
  listSkillOutputs,
  listSkillPreferredTools,
  type LoadableSkillCategory,
  type SkillContract,
  type TaskPhase,
} from "@brewva/brewva-runtime";

interface SkillRecommendationCandidate {
  name: string;
  description: string;
  category: LoadableSkillCategory;
  markdown?: string;
  contract: SkillContract;
}

type TaskStateLike = {
  spec?: unknown;
  status?: unknown;
  items?: unknown[];
  blockers?: unknown[];
};

interface TextSignalIndex {
  normalizedText: string;
  englishTokens: Set<string>;
  targetPaths: string[];
  hasContent: boolean;
}

interface TaskIntentSignals {
  prompt: TextSignalIndex;
  spec: TextSignalIndex;
  taskContext: TextSignalIndex;
  combinedNormalizedText: string;
  combinedEnglishTokens: Set<string>;
  phase: TaskPhase | null;
  targetPaths: string[];
  taskSpecReady: boolean;
}

interface ScoredSignal {
  score: number;
  reason?: string;
}

interface SignalWeights {
  exact: number;
  strong: number;
  partial: number;
}

export interface SkillFirstRuntimeLike {
  inspect: {
    skills: {
      list(): SkillRecommendationCandidate[];
      getActive(sessionId: string): Pick<SkillRecommendationCandidate, "name"> | null | undefined;
      getLoadReport(): {
        loadedSkills: readonly string[];
        routingEnabled: boolean;
        routingScopes: readonly string[];
        routableSkills: readonly string[];
        hiddenSkills: readonly string[];
      };
    };
    task: {
      getState(sessionId: string): TaskStateLike | undefined;
    };
  };
}

export interface SkillRecommendation {
  name: string;
  category: SkillRecommendationCandidate["category"];
  score: number;
  reasons: string[];
  primary: boolean;
}

export type SkillRecommendationGateMode = "none" | "task_spec_required" | "skill_load_required";

export interface SkillRecommendationSet {
  activeSkillName: string | null;
  gateMode: SkillRecommendationGateMode;
  taskSpecReady: boolean;
  recommendations: SkillRecommendation[];
}

export interface SkillRecommendationReceiptPayload {
  schema: "brewva.skill_recommendation.v2";
  gateMode: SkillRecommendationGateMode;
  taskSpecReady: boolean;
  recommendations: Array<{
    name: string;
    category: SkillRecommendation["category"];
    score: number;
    primary: boolean;
    reasons: string[];
  }>;
}

const MAX_RECOMMENDATIONS = 3;
const MIN_RECOMMENDATION_SCORE = 2.6;
const REQUIRED_RECOMMENDATION_SCORE = 4.2;
const SCORE_DELTA_WINDOW = 1.6;
const MAX_REASON_COUNT = 4;
const ENGLISH_TOKEN_PATTERN = /[a-z0-9]+/g;
const CJK_PATTERN = /[\u3400-\u9fff]/u;
const PATH_LIKE_PATTERN = /(?:^|[\s"'`(])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)/g;
const PHASE_VALUES: TaskPhase[] = [
  "align",
  "investigate",
  "execute",
  "verify",
  "ready_for_acceptance",
  "blocked",
  "done",
];
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "after",
  "before",
  "by",
  "for",
  "from",
  "in",
  "into",
  "needs",
  "on",
  "or",
  "the",
  "this",
  "that",
  "to",
  "use",
  "when",
  "with",
]);

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_/.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePath(value: string): string {
  return value
    .trim()
    .replace(/^['"`(]+|['"`),.:;]+$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .toLowerCase();
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => readString(entry)).filter((entry): entry is string => Boolean(entry));
}

function readTaskPhase(value: unknown): TaskPhase | null {
  if (typeof value !== "string") {
    return null;
  }
  return (PHASE_VALUES as string[]).includes(value) ? (value as TaskPhase) : null;
}

function extractPathLikeValues(value: string): string[] {
  const matches = [...value.matchAll(PATH_LIKE_PATTERN)]
    .map((match) => match[1])
    .filter((entry): entry is string => typeof entry === "string");
  return matches.map((entry) => normalizePath(entry)).filter(Boolean);
}

function extractEnglishTokens(text: string): Set<string> {
  const matches = text.match(ENGLISH_TOKEN_PATTERN) ?? [];
  return new Set(
    matches.map((token) => normalizeEnglishToken(token.trim())).filter((token) => token.length > 1),
  );
}

function normalizeEnglishToken(token: string): string {
  const normalized = token.toLowerCase();
  if (normalized.length > 4 && normalized.endsWith("ies")) {
    return `${normalized.slice(0, -3)}y`;
  }
  if (
    normalized.length > 3 &&
    normalized.endsWith("s") &&
    !normalized.endsWith("ss") &&
    !normalized.endsWith("us") &&
    !normalized.endsWith("is")
  ) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function tokenizeName(name: string): string[] {
  return normalizeText(name)
    .split(/[^a-z0-9]+/g)
    .map((part) => normalizeEnglishToken(part.trim()))
    .filter((part) => part.length > 1 && !STOP_WORDS.has(part));
}

function tokenizeSignalText(value: string): string[] {
  return normalizeText(value)
    .split(/[^a-z0-9]+/g)
    .map((part) => normalizeEnglishToken(part.trim()))
    .filter((part) => part.length > 2 && !STOP_WORDS.has(part));
}

function extractMarkdownSection(markdown: string | undefined, heading: string): string {
  if (!markdown) {
    return "";
  }
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|\\n)##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  const match = markdown.match(pattern);
  return (match?.[1] ?? "").trim();
}

function extractMarkdownBullets(markdown: string | undefined, heading: string): string[] {
  return extractMarkdownSection(markdown, heading)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function summarizeReasonText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 64) {
    return normalized;
  }
  return `${normalized.slice(0, 61).trimEnd()}...`;
}

function pushReason(reasons: string[], reason: string | undefined): void {
  if (!reason || reasons.includes(reason) || reasons.length >= MAX_REASON_COUNT) {
    return;
  }
  reasons.push(reason);
}

function createTextSignalIndex(parts: readonly string[]): TextSignalIndex {
  const normalizedParts = parts
    .map((part) => readString(part))
    .filter((part): part is string => !!part);
  const targetPaths = new Set<string>();

  for (const value of normalizedParts) {
    for (const path of extractPathLikeValues(value)) {
      targetPaths.add(path);
    }
  }

  const normalizedText = normalizeText(normalizedParts.join("\n"));
  return {
    normalizedText,
    englishTokens: extractEnglishTokens(normalizedText),
    targetPaths: [...targetPaths],
    hasContent: normalizedText.length > 0,
  };
}

function combineEnglishTokens(indexes: readonly TextSignalIndex[]): Set<string> {
  const combined = new Set<string>();
  for (const index of indexes) {
    for (const token of index.englishTokens) {
      combined.add(token);
    }
  }
  return combined;
}

function mergeNormalizedText(indexes: readonly TextSignalIndex[]): string {
  return indexes
    .map((index) => index.normalizedText)
    .filter((value) => value.length > 0)
    .join("\n");
}

function readTaskSpec(taskState: TaskStateLike | undefined):
  | {
      goal?: unknown;
      expectedBehavior?: unknown;
      constraints?: unknown;
      targets?: {
        files?: unknown;
        symbols?: unknown;
      };
    }
  | undefined {
  return taskState?.spec && typeof taskState.spec === "object"
    ? (taskState.spec as {
        goal?: unknown;
        expectedBehavior?: unknown;
        constraints?: unknown;
        targets?: {
          files?: unknown;
          symbols?: unknown;
        };
      })
    : undefined;
}

function collectTaskIntentSignals(
  prompt: string,
  taskState: TaskStateLike | undefined,
): TaskIntentSignals {
  const spec = readTaskSpec(taskState);
  const specGoal = readString(spec?.goal);
  const promptIndex = createTextSignalIndex([prompt]);
  const specParts: string[] = [];

  if (specGoal) {
    specParts.push(specGoal);
  }
  const expectedBehavior = readString(spec?.expectedBehavior);
  if (expectedBehavior) {
    specParts.push(expectedBehavior);
  }
  for (const value of readStringArray(spec?.constraints)) {
    specParts.push(value);
  }
  for (const value of readStringArray(spec?.targets?.files)) {
    specParts.push(value);
  }
  for (const value of readStringArray(spec?.targets?.symbols)) {
    specParts.push(value);
  }

  const taskContextParts: string[] = [];
  for (const item of Array.isArray(taskState?.items) ? taskState.items : []) {
    if (item && typeof item === "object") {
      const text = readString((item as { text?: unknown }).text);
      if (text) {
        taskContextParts.push(text);
      }
    }
  }
  for (const blocker of Array.isArray(taskState?.blockers) ? taskState.blockers : []) {
    if (blocker && typeof blocker === "object") {
      const fields = blocker as { message?: unknown; text?: unknown; reason?: unknown };
      for (const candidate of [fields.message, fields.text, fields.reason]) {
        const value = readString(candidate);
        if (value) {
          taskContextParts.push(value);
        }
      }
    }
  }

  const specIndex = createTextSignalIndex(specParts);
  const taskContextIndex = createTextSignalIndex(taskContextParts);
  const targetPaths = new Set<string>([
    ...promptIndex.targetPaths,
    ...specIndex.targetPaths,
    ...taskContextIndex.targetPaths,
    ...readStringArray(spec?.targets?.files)
      .map((value) => normalizePath(value))
      .filter(Boolean),
  ]);

  return {
    prompt: promptIndex,
    spec: specIndex,
    taskContext: taskContextIndex,
    combinedNormalizedText: mergeNormalizedText([promptIndex, specIndex, taskContextIndex]),
    combinedEnglishTokens: combineEnglishTokens([promptIndex, specIndex, taskContextIndex]),
    phase:
      taskState?.status && typeof taskState.status === "object"
        ? readTaskPhase((taskState.status as { phase?: unknown }).phase)
        : null,
    targetPaths: [...targetPaths],
    taskSpecReady: Boolean(specGoal),
  };
}

function scoreNaturalLanguageSignal(
  signal: string | undefined,
  input: TextSignalIndex,
  weights: SignalWeights,
): ScoredSignal {
  if (!signal || !input.hasContent) {
    return { score: 0 };
  }
  const normalizedSignal = normalizeText(signal);
  if (!normalizedSignal) {
    return { score: 0 };
  }

  if (input.normalizedText.includes(normalizedSignal)) {
    return {
      score: weights.exact,
      reason: summarizeReasonText(signal),
    };
  }
  if (CJK_PATTERN.test(signal)) {
    return { score: 0 };
  }

  const tokens = tokenizeSignalText(signal);
  if (tokens.length === 0) {
    return { score: 0 };
  }

  const overlap = tokens.filter((token) => input.englishTokens.has(token)).length;
  if (overlap === 0) {
    return { score: 0 };
  }

  const ratio = overlap / tokens.length;
  if ((tokens.length <= 2 && overlap === tokens.length) || (overlap >= 3 && ratio >= 0.5)) {
    return {
      score: weights.strong,
      reason: summarizeReasonText(signal),
    };
  }
  if ((overlap >= 4 && ratio >= 0.28) || (overlap >= 2 && ratio >= 0.34)) {
    return {
      score: weights.partial,
      reason: summarizeReasonText(signal),
    };
  }

  return { score: 0 };
}

function scoreSignalAcrossSources(
  signal: string | undefined,
  input: TaskIntentSignals,
  weights: {
    spec: SignalWeights;
    taskContext: SignalWeights;
    prompt: SignalWeights;
  },
): ScoredSignal {
  const candidates = [
    scoreNaturalLanguageSignal(signal, input.spec, weights.spec),
    scoreNaturalLanguageSignal(signal, input.taskContext, weights.taskContext),
    scoreNaturalLanguageSignal(signal, input.prompt, weights.prompt),
  ];

  let best: ScoredSignal = { score: 0 };
  for (const candidate of candidates) {
    if (candidate.score > best.score) {
      best = candidate;
    }
  }
  return best;
}

function scoreSignalSetAcrossSources(
  signals: readonly string[],
  input: TaskIntentSignals,
  weights: {
    spec: SignalWeights;
    taskContext: SignalWeights;
    prompt: SignalWeights;
  },
): ScoredSignal {
  let best: ScoredSignal = { score: 0 };
  for (const signal of signals) {
    const scored = scoreSignalAcrossSources(signal, input, weights);
    if (scored.score > best.score) {
      best = scored;
    }
  }
  return best;
}

function hasMatchingPath(pathPattern: string, targetPaths: readonly string[]): boolean {
  const normalizedPattern = normalizePath(pathPattern);
  if (!normalizedPattern) {
    return false;
  }
  return targetPaths.some(
    (targetPath) =>
      targetPath === normalizedPattern ||
      targetPath.startsWith(`${normalizedPattern}/`) ||
      normalizedPattern.startsWith(`${targetPath}/`) ||
      targetPath.includes(normalizedPattern),
  );
}

function scoreSelectionPaths(
  selectionPaths: readonly string[] | undefined,
  input: TaskIntentSignals,
): ScoredSignal {
  if (!selectionPaths || selectionPaths.length === 0 || input.targetPaths.length === 0) {
    return { score: 0 };
  }
  const matchedPath = selectionPaths.find((pathPattern) =>
    hasMatchingPath(pathPattern, input.targetPaths),
  );
  if (matchedPath) {
    return {
      score: 1.2,
      reason: `path:${matchedPath}`,
    };
  }
  return { score: -0.9 };
}

function scoreSelectionPhases(
  phases: readonly TaskPhase[] | undefined,
  input: TaskIntentSignals,
): ScoredSignal {
  if (!phases || phases.length === 0 || !input.phase) {
    return { score: 0 };
  }
  if (phases.includes(input.phase)) {
    return {
      score: 0.9,
      reason: `phase:${input.phase}`,
    };
  }
  return { score: -1.1 };
}

function scoreSkill(
  skill: SkillRecommendationCandidate,
  input: TaskIntentSignals,
): SkillRecommendation | null {
  if (!skill.contract.routing?.scope || !skill.contract.selection) {
    return null;
  }

  let score = 0;
  const reasons: string[] = [];

  const whenToUse = scoreSignalAcrossSources(skill.contract.selection.whenToUse, input, {
    spec: { exact: 2.95, strong: 2.6, partial: 2.1 },
    taskContext: { exact: 1.9, strong: 1.55, partial: 1.25 },
    prompt: { exact: 0.8, strong: 0.65, partial: 0.45 },
  });
  score += whenToUse.score;
  pushReason(reasons, whenToUse.reason);

  const exampleSignal = scoreSignalSetAcrossSources(
    skill.contract.selection.examples ?? [],
    input,
    {
      spec: { exact: 1.75, strong: 1.5, partial: 1.2 },
      taskContext: { exact: 1.1, strong: 0.9, partial: 0.7 },
      prompt: { exact: 0.45, strong: 0.35, partial: 0.25 },
    },
  );
  score += exampleSignal.score;
  pushReason(reasons, exampleSignal.reason);

  const triggerSignal = scoreSignalSetAcrossSources(
    extractMarkdownBullets(skill.markdown, "Trigger"),
    input,
    {
      spec: { exact: 1.55, strong: 1.25, partial: 1.0 },
      taskContext: { exact: 0.95, strong: 0.75, partial: 0.55 },
      prompt: { exact: 0.35, strong: 0.25, partial: 0.18 },
    },
  );
  score += triggerSignal.score;
  pushReason(reasons, triggerSignal.reason);

  const pathSignal = scoreSelectionPaths(skill.contract.selection.paths, input);
  score += pathSignal.score;
  pushReason(reasons, pathSignal.reason);

  const phaseSignal = scoreSelectionPhases(skill.contract.selection.phases, input);
  score += phaseSignal.score;
  pushReason(reasons, phaseSignal.reason);

  const normalizedName = normalizeText(skill.name);
  if (normalizedName && input.combinedNormalizedText.includes(normalizedName)) {
    score += 1.5;
    pushReason(reasons, skill.name);
  } else {
    for (const token of tokenizeName(skill.name)) {
      if (input.combinedEnglishTokens.has(token)) {
        score += 0.5;
        pushReason(reasons, token);
      }
    }
  }

  for (const token of tokenizeSignalText(skill.description).slice(0, 8)) {
    if (input.combinedEnglishTokens.has(token)) {
      score += 0.25;
      pushReason(reasons, token);
    }
  }

  for (const token of listSkillOutputs(skill.contract).flatMap((entry) => tokenizeName(entry))) {
    if (input.combinedEnglishTokens.has(token)) {
      score += 0.24;
      pushReason(reasons, token);
    }
  }

  for (const toolName of [
    ...listSkillPreferredTools(skill.contract),
    ...listSkillFallbackTools(skill.contract),
  ]) {
    const normalizedTool = normalizeText(toolName);
    if (normalizedTool && input.combinedNormalizedText.includes(normalizedTool)) {
      score += 0.2;
      pushReason(reasons, normalizedTool);
    }
  }

  if (score < MIN_RECOMMENDATION_SCORE) {
    return null;
  }

  return {
    name: skill.name,
    category: skill.category,
    score: Number(score.toFixed(2)),
    reasons,
    primary: false,
  };
}

function resolveRoutableSkills(runtime: SkillFirstRuntimeLike): SkillRecommendationCandidate[] {
  const loadReport = runtime.inspect.skills.getLoadReport();
  if (!loadReport.routingEnabled || loadReport.routableSkills.length === 0) {
    return [];
  }
  const routableNames = new Set(loadReport.routableSkills);
  return runtime.inspect.skills
    .list()
    .filter((skill) => routableNames.has(skill.name))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function formatReasons(reasons: readonly string[]): string {
  return reasons.slice(0, MAX_REASON_COUNT).join(", ");
}

export function buildSkillRecommendationReceiptPayload(
  input: SkillRecommendationSet,
): SkillRecommendationReceiptPayload | null {
  if (input.activeSkillName) {
    return null;
  }
  if (input.gateMode === "none" && input.recommendations.length === 0) {
    return null;
  }
  return {
    schema: "brewva.skill_recommendation.v2",
    gateMode: input.gateMode,
    taskSpecReady: input.taskSpecReady,
    recommendations: input.recommendations.map((entry) => ({
      name: entry.name,
      category: entry.category,
      score: entry.score,
      primary: entry.primary,
      reasons: entry.reasons,
    })),
  };
}

export function computeSkillRecommendationReceiptKey(input: SkillRecommendationSet): string {
  const payload = buildSkillRecommendationReceiptPayload(input);
  return payload ? JSON.stringify(payload) : "";
}

function isTaskSpecReady(taskState: TaskStateLike | undefined): boolean {
  return !!readString(readTaskSpec(taskState)?.goal);
}

export function deriveSkillRecommendations(
  runtime: SkillFirstRuntimeLike,
  input: {
    sessionId: string;
    prompt: string;
  },
): SkillRecommendationSet {
  const taskState = runtime.inspect.task.getState(input.sessionId);
  const activeSkillName = runtime.inspect.skills.getActive(input.sessionId)?.name ?? null;
  const taskSpecReady = isTaskSpecReady(taskState);

  if (activeSkillName) {
    return {
      activeSkillName,
      gateMode: "none",
      taskSpecReady,
      recommendations: [],
    };
  }

  const routableSkills = resolveRoutableSkills(runtime);
  if (routableSkills.length === 0) {
    return {
      activeSkillName: null,
      gateMode: "none",
      taskSpecReady,
      recommendations: [],
    };
  }

  const signals = collectTaskIntentSignals(input.prompt, taskState);
  if (!signals.taskSpecReady) {
    if (!signals.prompt.hasContent && !signals.taskContext.hasContent) {
      return {
        activeSkillName: null,
        gateMode: "none",
        taskSpecReady: false,
        recommendations: [],
      };
    }
    return {
      activeSkillName: null,
      gateMode: "task_spec_required",
      taskSpecReady: false,
      recommendations: [],
    };
  }

  const scored = routableSkills
    .map((skill) => scoreSkill(skill, signals))
    .filter((entry): entry is SkillRecommendation => entry !== null)
    .toSorted((left, right) => right.score - left.score || left.name.localeCompare(right.name));

  const top = scored[0];
  if (!top) {
    return {
      activeSkillName: null,
      gateMode: "none",
      taskSpecReady: true,
      recommendations: [],
    };
  }

  const retained = scored
    .filter((entry, index) => {
      if (index === 0) {
        return true;
      }
      return top.score - entry.score <= SCORE_DELTA_WINDOW;
    })
    .slice(0, MAX_RECOMMENDATIONS);

  retained.forEach((entry, index) => {
    entry.primary = index === 0;
  });

  return {
    activeSkillName: null,
    gateMode: top.score >= REQUIRED_RECOMMENDATION_SCORE ? "skill_load_required" : "none",
    taskSpecReady: true,
    recommendations: retained,
  };
}

export function buildSkillFirstPolicyBlock(input: SkillRecommendationSet): string | null {
  if (input.activeSkillName) {
    return null;
  }
  if (input.gateMode === "none" && input.recommendations.length === 0) {
    return null;
  }

  const lines = [
    "[Brewva Skill-First Policy]",
    "Brewva is skill-first.",
    "No active skill is currently loaded.",
  ];

  if (input.gateMode === "task_spec_required") {
    lines.push("No TaskSpec is currently recorded for this session.");
    lines.push(
      "Before deeper repository reads, searches, execution, or edits, call `task_set_spec` to record the task goal, constraints, targets, and verification intent.",
    );
    lines.push("After `task_set_spec`, Brewva will re-evaluate whether `skill_load` is required.");
    return lines.join("\n");
  }

  const primary = input.recommendations[0];
  if (!primary) {
    return null;
  }

  if (input.gateMode === "skill_load_required") {
    lines.push(
      "This TaskSpec now matches loaded skills strongly. Before substantive repository reads, searches, execution, or edits, call `skill_load` with the best match.",
    );
  } else {
    lines.push("TaskSpec is present. Prefer `skill_load` before deeper tool work.");
  }

  lines.push(`primary_skill: ${primary.name}`);
  if (primary.reasons.length > 0) {
    lines.push(`primary_reasons: ${formatReasons(primary.reasons)}`);
  }

  if (input.recommendations.length > 1) {
    lines.push(
      `alternate_skills: ${input.recommendations
        .slice(1)
        .map((entry) =>
          entry.reasons.length > 0 ? `${entry.name} (${formatReasons(entry.reasons)})` : entry.name,
        )
        .join("; ")}`,
    );
  }

  lines.push("After loading a skill, stay inside it until `skill_complete` or an explicit switch.");
  return lines.join("\n");
}
