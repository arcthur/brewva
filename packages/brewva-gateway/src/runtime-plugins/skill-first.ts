import {
  listSkillFallbackTools,
  listSkillOutputs,
  listSkillPreferredTools,
  type LoadableSkillCategory,
  type SkillCompletionFailureRecord,
  type SkillContract,
  type SkillReadinessEntry,
  type TaskPhase,
} from "@brewva/brewva-runtime";

interface SkillDiagnosisCatalogEntry {
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
      list(): SkillDiagnosisCatalogEntry[];
      getActive(sessionId: string): Pick<SkillDiagnosisCatalogEntry, "name"> | null | undefined;
      getReadiness?(sessionId: string): readonly SkillReadinessEntry[];
      getLatestFailure?(sessionId: string): SkillCompletionFailureRecord | undefined;
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

export interface SkillClassificationHint {
  readonly skillNames?: readonly string[];
  readonly reason?: string;
}

export type SkillDiagnosisBasis = "cold_start" | "artifact_aware" | "classification_hint";
export type SkillDiagnosisReadiness = SkillReadinessEntry["readiness"] | "unknown";

export interface SkillDiagnosisCandidate {
  name: string;
  category: SkillDiagnosisCatalogEntry["category"];
  score: number;
  reasons: string[];
  primary: boolean;
  basis: SkillDiagnosisBasis;
  readiness: SkillDiagnosisReadiness;
  missingRequires: string[];
  satisfiedConsumes: string[];
  shallowOutputRisk: string | null;
}

export interface RejectedSkillDiagnosisCandidate {
  name: string;
  category: SkillDiagnosisCatalogEntry["category"];
  score: number;
  basis: SkillDiagnosisBasis;
  readiness: SkillDiagnosisReadiness;
  reasons: string[];
  missingRequires: string[];
  satisfiedConsumes: string[];
  shallowOutputRisk: string | null;
  rejectionReason: string;
}

export type SkillActivationPosture =
  | { readonly kind: "none" }
  | { readonly kind: "recommend_task_spec"; readonly reason: string }
  | { readonly kind: "require_task_spec"; readonly boundary: "execute" | "mutation" }
  | {
      readonly kind: "recommend_skill_load";
      readonly skillNames: readonly string[];
      readonly reason: string;
    }
  | {
      readonly kind: "require_skill_load";
      readonly skillNames: readonly string[];
      readonly boundary: "execute" | "verify" | "contract";
    }
  | {
      readonly kind: "require_skill_inputs";
      readonly skillName: string;
      readonly missingRequires: readonly string[];
      readonly boundary: "execute" | "verify";
      readonly reason: string;
    }
  | { readonly kind: "repair_failed_contract"; readonly failedSkillNames: readonly string[] };

export type ToolAvailabilityPosture =
  | "none"
  | "recommend"
  | "require_explore"
  | "require_execute"
  | "contract_failed";

export interface SkillDiagnosisSet {
  activeSkillName: string | null;
  activationPosture: SkillActivationPosture;
  toolAvailabilityPosture: ToolAvailabilityPosture;
  taskSpecReady: boolean;
  candidates: SkillDiagnosisCandidate[];
  rejectedCandidates: RejectedSkillDiagnosisCandidate[];
  failedSkill?: {
    name: string;
    missing: string[];
    invalid: string[];
  };
}

export interface SkillDiagnosisReceiptPayload {
  schema: "brewva.skill_diagnosis.v1";
  activationPosture: SkillActivationPosture;
  toolAvailabilityPosture: ToolAvailabilityPosture;
  taskSpecReady: boolean;
  shortestNextAction: string;
  selectedCandidate: {
    name: string;
    category: SkillDiagnosisCandidate["category"];
    score: number;
    basis: SkillDiagnosisBasis;
    readiness: SkillDiagnosisReadiness;
    reasons: string[];
    missingRequires: string[];
    satisfiedConsumes: string[];
    shallowOutputRisk: string | null;
  } | null;
  candidates: Array<{
    name: string;
    category: SkillDiagnosisCandidate["category"];
    score: number;
    primary: boolean;
    basis: SkillDiagnosisBasis;
    readiness: SkillDiagnosisReadiness;
    reasons: string[];
    missingRequires: string[];
    satisfiedConsumes: string[];
    shallowOutputRisk: string | null;
  }>;
  rejectedCandidates: RejectedSkillDiagnosisCandidate[];
  failedSkill?: {
    name: string;
    missing: string[];
    invalid: string[];
  };
}

const MAX_DIAGNOSIS_CANDIDATES = 3;
const MIN_DIAGNOSIS_SCORE = 2.6;
const SCORE_DELTA_WINDOW = 1.6;
const MAX_REASON_COUNT = 4;
const ENGLISH_TOKEN_PATTERN = /[a-z0-9]+/g;
const CJK_PATTERN = /[\u3400-\u9fff]/u;
const PATH_LIKE_PATTERN = /(?:^|[\s"'`(])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)/g;
const MUTATION_INTENT_PATTERN =
  /\b(add|apply|build|change|commit|delete|edit|execute|fix|implement|modify|patch|promote|refactor|remove|rename|run|ship|test|update|verify|write)\b/i;
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
  skill: SkillDiagnosisCatalogEntry,
  input: TaskIntentSignals,
): SkillDiagnosisCandidate | null {
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

  if (score < MIN_DIAGNOSIS_SCORE) {
    return null;
  }

  return {
    name: skill.name,
    category: skill.category,
    score: Number(score.toFixed(2)),
    reasons,
    primary: false,
    basis: "cold_start",
    readiness: "unknown",
    missingRequires: [],
    satisfiedConsumes: [],
    shallowOutputRisk: null,
  };
}

function resolveRoutableSkills(runtime: SkillFirstRuntimeLike): SkillDiagnosisCatalogEntry[] {
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

function isExecutionPhase(phase: TaskPhase | null): boolean {
  return phase === "execute" || phase === "verify" || phase === "ready_for_acceptance";
}

function isVerificationPhase(phase: TaskPhase | null): boolean {
  return phase === "verify" || phase === "ready_for_acceptance";
}

function hasMutationIntent(signals: TaskIntentSignals): boolean {
  return MUTATION_INTENT_PATTERN.test(signals.combinedNormalizedText);
}

function candidateSkillNames(candidates: readonly SkillDiagnosisCandidate[]): readonly string[] {
  return candidates.map((entry) => entry.name);
}

function applyReadinessToCandidate(
  candidate: SkillDiagnosisCandidate,
  readiness: SkillReadinessEntry | undefined,
  hinted: boolean,
): SkillDiagnosisCandidate {
  const basis: SkillDiagnosisBasis =
    readiness &&
    (readiness.missingRequires.length > 0 ||
      readiness.satisfiedRequires.length > 0 ||
      readiness.satisfiedConsumes.length > 0)
      ? "artifact_aware"
      : hinted
        ? "classification_hint"
        : candidate.basis;
  const shallowOutputRisk =
    readiness && readiness.missingRequires.length > 0
      ? `missing required inputs: ${readiness.missingRequires.join(", ")}`
      : null;
  return {
    ...candidate,
    basis,
    readiness: readiness?.readiness ?? candidate.readiness,
    missingRequires: readiness?.missingRequires ?? [],
    satisfiedConsumes: readiness?.satisfiedConsumes ?? [],
    shallowOutputRisk,
  };
}

const READINESS_SELECTION_WEIGHT: Record<SkillDiagnosisReadiness, number> = {
  ready: 3,
  available: 2,
  unknown: 1,
  blocked: 0,
};

function compareActionableCandidates(
  left: SkillDiagnosisCandidate,
  right: SkillDiagnosisCandidate,
): number {
  const readinessDelta =
    READINESS_SELECTION_WEIGHT[right.readiness] - READINESS_SELECTION_WEIGHT[left.readiness];
  if (readinessDelta !== 0) {
    return readinessDelta;
  }

  const consumedDelta = right.satisfiedConsumes.length - left.satisfiedConsumes.length;
  if (consumedDelta !== 0) {
    return consumedDelta;
  }

  return right.score - left.score || left.name.localeCompare(right.name);
}

function rejectedCandidateReason(input: {
  candidate: SkillDiagnosisCandidate;
  selected: SkillDiagnosisCandidate;
}): string {
  const scoreDelta = Number((input.selected.score - input.candidate.score).toFixed(2));
  if (input.candidate.missingRequires.length > 0) {
    return `blocked by missing required inputs: ${input.candidate.missingRequires.join(", ")}`;
  }
  if (scoreDelta > SCORE_DELTA_WINDOW) {
    return `outside score window by ${scoreDelta}`;
  }
  return "lower ranked than selected candidate";
}

function hasMissingRequiredInputs(candidate: SkillDiagnosisCandidate | undefined): boolean {
  return Boolean(candidate && candidate.missingRequires.length > 0);
}

function normalizeHintSkillNames(
  hints: readonly SkillClassificationHint[] | undefined,
): Set<string> {
  const names = new Set<string>();
  for (const hint of hints ?? []) {
    for (const skillName of hint.skillNames ?? []) {
      const normalized = skillName.trim();
      if (normalized.length > 0) {
        names.add(normalized);
      }
    }
  }
  return names;
}

function firstHintReasonForSkill(
  hints: readonly SkillClassificationHint[] | undefined,
  skillName: string,
): string | undefined {
  return (hints ?? []).find((hint) => hint.skillNames?.includes(skillName))?.reason;
}

export function buildSkillDiagnosisReceiptPayload(
  input: SkillDiagnosisSet,
): SkillDiagnosisReceiptPayload | null {
  if (input.activeSkillName) {
    return null;
  }
  if (input.activationPosture.kind === "none" && input.candidates.length === 0) {
    return null;
  }
  const selected = input.candidates[0] ?? null;
  return {
    schema: "brewva.skill_diagnosis.v1",
    activationPosture: input.activationPosture,
    toolAvailabilityPosture: input.toolAvailabilityPosture,
    taskSpecReady: input.taskSpecReady,
    shortestNextAction: resolveShortestNextAction(input),
    selectedCandidate: selected
      ? {
          name: selected.name,
          category: selected.category,
          score: selected.score,
          basis: selected.basis,
          readiness: selected.readiness,
          reasons: selected.reasons,
          missingRequires: selected.missingRequires,
          satisfiedConsumes: selected.satisfiedConsumes,
          shallowOutputRisk: selected.shallowOutputRisk,
        }
      : null,
    candidates: input.candidates.map((entry) => ({
      name: entry.name,
      category: entry.category,
      score: entry.score,
      primary: entry.primary,
      basis: entry.basis,
      readiness: entry.readiness,
      reasons: entry.reasons,
      missingRequires: entry.missingRequires,
      satisfiedConsumes: entry.satisfiedConsumes,
      shallowOutputRisk: entry.shallowOutputRisk,
    })),
    rejectedCandidates: input.rejectedCandidates,
    ...(input.failedSkill ? { failedSkill: input.failedSkill } : {}),
  };
}

export function computeSkillDiagnosisReceiptKey(input: SkillDiagnosisSet): string {
  const payload = buildSkillDiagnosisReceiptPayload(input);
  return payload ? JSON.stringify(payload) : "";
}

export function resolveShortestNextAction(input: SkillDiagnosisSet): string {
  if (input.activeSkillName) {
    return "Continue the active skill and finish with skill_complete before switching.";
  }
  if (input.activationPosture.kind === "recommend_task_spec") {
    return "Call task_set_spec if the task needs deeper skill routing.";
  }
  if (input.activationPosture.kind === "require_task_spec") {
    return "Call task_set_spec with goal, targets, constraints, and expected behavior.";
  }
  if (input.activationPosture.kind === "repair_failed_contract") {
    return "Restart or repair the failed skill contract before downstream work.";
  }
  const selected = input.candidates[0];
  if (selected && selected.missingRequires.length > 0) {
    return `Produce required inputs ${selected.missingRequires.join(", ")} before loading ${JSON.stringify(
      selected.name,
    )}.`;
  }
  if (
    selected &&
    (input.activationPosture.kind === "require_skill_load" ||
      input.activationPosture.kind === "recommend_skill_load")
  ) {
    return `Call skill_load with name ${JSON.stringify(selected.name)}.`;
  }
  return "Continue with available context; no skill routing action is needed.";
}

function isTaskSpecReady(taskState: TaskStateLike | undefined): boolean {
  return !!readString(readTaskSpec(taskState)?.goal);
}

export function deriveSkillDiagnoses(
  runtime: SkillFirstRuntimeLike,
  input: {
    sessionId: string;
    prompt: string;
    classificationHints?: readonly SkillClassificationHint[];
  },
): SkillDiagnosisSet {
  const taskState = runtime.inspect.task.getState(input.sessionId);
  const activeSkillName = runtime.inspect.skills.getActive(input.sessionId)?.name ?? null;
  const taskSpecReady = isTaskSpecReady(taskState);

  if (activeSkillName) {
    return {
      activeSkillName,
      activationPosture: { kind: "none" },
      toolAvailabilityPosture: "none",
      taskSpecReady,
      candidates: [],
      rejectedCandidates: [],
    };
  }

  const latestFailure = runtime.inspect.skills.getLatestFailure?.(input.sessionId);
  if (latestFailure?.phase === "failed_contract") {
    return {
      activeSkillName: null,
      activationPosture: {
        kind: "repair_failed_contract",
        failedSkillNames: [latestFailure.skillName],
      },
      toolAvailabilityPosture: "contract_failed",
      taskSpecReady,
      candidates: [],
      rejectedCandidates: [],
      failedSkill: {
        name: latestFailure.skillName,
        missing: latestFailure.missing,
        invalid: latestFailure.invalid.map((issue) => issue.name),
      },
    };
  }

  const routableSkills = resolveRoutableSkills(runtime);
  if (routableSkills.length === 0) {
    return {
      activeSkillName: null,
      activationPosture: { kind: "none" },
      toolAvailabilityPosture: "none",
      taskSpecReady,
      candidates: [],
      rejectedCandidates: [],
    };
  }

  const signals = collectTaskIntentSignals(input.prompt, taskState);
  if (!signals.taskSpecReady) {
    if (!signals.prompt.hasContent && !signals.taskContext.hasContent) {
      return {
        activeSkillName: null,
        activationPosture: { kind: "none" },
        toolAvailabilityPosture: "none",
        taskSpecReady: false,
        candidates: [],
        rejectedCandidates: [],
      };
    }
    if (hasMutationIntent(signals) || isExecutionPhase(signals.phase)) {
      return {
        activeSkillName: null,
        activationPosture: {
          kind: "require_task_spec",
          boundary: hasMutationIntent(signals) ? "mutation" : "execute",
        },
        toolAvailabilityPosture: "require_execute",
        taskSpecReady: false,
        candidates: [],
        rejectedCandidates: [],
      };
    }
    return {
      activeSkillName: null,
      activationPosture: {
        kind: "recommend_task_spec",
        reason: "Prompt has enough task context to benefit from an explicit TaskSpec.",
      },
      toolAvailabilityPosture: "recommend",
      taskSpecReady: false,
      candidates: [],
      rejectedCandidates: [],
    };
  }

  const hintedSkillNames = normalizeHintSkillNames(input.classificationHints);
  const readinessByName = new Map(
    (runtime.inspect.skills.getReadiness?.(input.sessionId) ?? []).map((entry) => [
      entry.name,
      entry,
    ]),
  );
  const scored = routableSkills
    .map((skill) => {
      const scoredSkill = scoreSkill(skill, signals);
      const readiness = readinessByName.get(skill.name);
      if (!hintedSkillNames.has(skill.name)) {
        return scoredSkill ? applyReadinessToCandidate(scoredSkill, readiness, false) : scoredSkill;
      }
      const hintReason = firstHintReasonForSkill(input.classificationHints, skill.name);
      const base = scoredSkill ?? {
        name: skill.name,
        category: skill.category,
        score: MIN_DIAGNOSIS_SCORE,
        reasons: [],
        primary: false,
        basis: "classification_hint" as const,
        readiness: "unknown" as const,
        missingRequires: [],
        satisfiedConsumes: [],
        shallowOutputRisk: null,
      };
      pushReason(base.reasons, hintReason ? `local_hook:${hintReason}` : "local_hook");
      base.score = Number(Math.max(base.score + 1, MIN_DIAGNOSIS_SCORE).toFixed(2));
      return applyReadinessToCandidate(base, readiness, true);
    })
    .filter((entry): entry is SkillDiagnosisCandidate => entry !== null)
    .toSorted((left, right) => right.score - left.score || left.name.localeCompare(right.name));

  const semanticLeader = scored[0];
  if (!semanticLeader) {
    return {
      activeSkillName: null,
      activationPosture: { kind: "none" },
      toolAvailabilityPosture: "none",
      taskSpecReady: true,
      candidates: [],
      rejectedCandidates: [],
    };
  }

  const retained = scored
    .filter((entry, index) => {
      if (index === 0) {
        return true;
      }
      return semanticLeader.score - entry.score <= SCORE_DELTA_WINDOW;
    })
    .toSorted(compareActionableCandidates)
    .slice(0, MAX_DIAGNOSIS_CANDIDATES);

  retained.forEach((entry, index) => {
    entry.primary = index === 0;
  });
  const retainedNames = new Set(retained.map((entry) => entry.name));
  const rejectedCandidates = scored
    .filter((entry) => !retainedNames.has(entry.name))
    .slice(0, 2)
    .map((entry) => ({
      name: entry.name,
      category: entry.category,
      score: entry.score,
      basis: entry.basis,
      readiness: entry.readiness,
      reasons: entry.reasons,
      missingRequires: entry.missingRequires,
      satisfiedConsumes: entry.satisfiedConsumes,
      shallowOutputRisk: entry.shallowOutputRisk,
      rejectionReason: rejectedCandidateReason({ candidate: entry, selected: retained[0]! }),
    }));
  const needsInputBeforeSkillLoad = hasMissingRequiredInputs(retained[0]);
  const effectfulBoundary = hasMutationIntent(signals) || isExecutionPhase(signals.phase);

  return {
    activeSkillName: null,
    activationPosture:
      needsInputBeforeSkillLoad && effectfulBoundary
        ? {
            kind: "require_skill_inputs",
            skillName: retained[0]!.name,
            missingRequires: retained[0]!.missingRequires,
            boundary: isVerificationPhase(signals.phase) ? "verify" : "execute",
            reason: "The best matched skill is blocked by missing required inputs.",
          }
        : effectfulBoundary
          ? {
              kind: "require_skill_load",
              skillNames: candidateSkillNames(retained),
              boundary: isVerificationPhase(signals.phase) ? "verify" : "execute",
            }
          : {
              kind: "recommend_skill_load",
              skillNames: candidateSkillNames(retained),
              reason: "TaskSpec strongly matches routable loaded skills.",
            },
    toolAvailabilityPosture:
      needsInputBeforeSkillLoad && effectfulBoundary
        ? "require_explore"
        : effectfulBoundary
          ? "require_execute"
          : "recommend",
    taskSpecReady: true,
    candidates: retained,
    rejectedCandidates,
  };
}

export function buildSkillDiagnosisPolicyBlock(input: SkillDiagnosisSet): string | null {
  if (input.activeSkillName) {
    return null;
  }
  if (input.activationPosture.kind === "none" && input.candidates.length === 0) {
    return null;
  }

  const lines = ["[Brewva Skill Diagnosis]"];
  const shortestNextAction = resolveShortestNextAction(input);

  if (input.activationPosture.kind === "recommend_task_spec") {
    lines.push("posture: recommend_task_spec");
    lines.push("selected_skill: none");
    lines.push("readiness: task_spec_missing");
    lines.push("missing_required_inputs: task_set_spec");
    lines.push(`shortest_next_action: ${shortestNextAction}`);
    return lines.join("\n");
  }

  if (input.activationPosture.kind === "require_task_spec") {
    lines.push(`posture: require_task_spec | boundary=${input.activationPosture.boundary}`);
    lines.push("selected_skill: none");
    lines.push("readiness: task_spec_missing");
    lines.push("missing_required_inputs: task_set_spec");
    lines.push(`shortest_next_action: ${shortestNextAction}`);
    return lines.join("\n");
  }

  if (input.activationPosture.kind === "repair_failed_contract") {
    const failedSkill = input.failedSkill;
    lines.push("posture: repair_failed_contract");
    lines.push(`selected_skill: ${failedSkill?.name ?? "none"}`);
    lines.push("readiness: contract_failed");
    if (failedSkill) {
      lines.push(
        `missing_required_inputs: ${
          failedSkill.missing.length > 0 ? failedSkill.missing.join(", ") : "none"
        }`,
      );
    } else {
      lines.push("missing_required_inputs: none");
    }
    lines.push(`shortest_next_action: ${shortestNextAction}`);
    return lines.join("\n");
  }

  const primary = input.candidates[0];
  if (!primary) {
    return null;
  }

  if (
    input.activationPosture.kind === "require_skill_inputs" ||
    input.activationPosture.kind === "require_skill_load"
  ) {
    lines.push(
      `posture: ${input.activationPosture.kind} | boundary=${input.activationPosture.boundary}`,
    );
  } else {
    lines.push(`posture: ${input.activationPosture.kind}`);
  }

  lines.push(`selected_skill: ${primary.name}`);
  lines.push(`readiness: ${primary.readiness}`);
  lines.push(
    `missing_required_inputs: ${
      primary.missingRequires.length > 0 ? primary.missingRequires.join(", ") : "none"
    }`,
  );
  lines.push(`shortest_next_action: ${shortestNextAction}`);
  return lines.join("\n");
}
