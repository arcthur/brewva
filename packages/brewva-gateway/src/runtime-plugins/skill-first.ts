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

interface PromptSignals {
  normalizedText: string;
  englishTokens: Set<string>;
  phase: TaskPhase | null;
  targetPaths: string[];
}

interface ScoredSignal {
  score: number;
  reason?: string;
}

export interface SkillFirstRuntimeLike {
  skills: {
    list(): SkillRecommendationCandidate[];
    getActive(sessionId: string): Pick<SkillRecommendationCandidate, "name"> | null | undefined;
  };
  task: {
    getState(sessionId: string): TaskStateLike | undefined;
  };
}

export interface SkillRecommendation {
  name: string;
  category: SkillRecommendationCandidate["category"];
  score: number;
  reasons: string[];
  primary: boolean;
}

export interface SkillRecommendationSet {
  activeSkillName: string | null;
  required: boolean;
  recommendations: SkillRecommendation[];
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

function collectPromptSignals(prompt: string, taskState: TaskStateLike | undefined): PromptSignals {
  const parts: string[] = [];
  const targetPaths = new Set<string>();
  const spec =
    taskState?.spec && typeof taskState.spec === "object"
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

  const push = (value: unknown) => {
    const normalized = readString(value);
    if (!normalized) {
      return;
    }
    parts.push(normalized);
    for (const path of extractPathLikeValues(normalized)) {
      targetPaths.add(path);
    }
  };

  push(prompt);
  push(spec?.goal);
  push(spec?.expectedBehavior);

  for (const value of readStringArray(spec?.constraints)) {
    push(value);
  }
  for (const value of readStringArray(spec?.targets?.files)) {
    push(value);
    targetPaths.add(normalizePath(value));
  }
  for (const value of readStringArray(spec?.targets?.symbols)) {
    push(value);
  }
  for (const item of Array.isArray(taskState?.items) ? taskState.items : []) {
    if (item && typeof item === "object") {
      push((item as { text?: unknown }).text);
    }
  }
  for (const blocker of Array.isArray(taskState?.blockers) ? taskState.blockers : []) {
    if (blocker && typeof blocker === "object") {
      push((blocker as { message?: unknown; text?: unknown; reason?: unknown }).message);
      push((blocker as { message?: unknown; text?: unknown; reason?: unknown }).text);
      push((blocker as { message?: unknown; text?: unknown; reason?: unknown }).reason);
    }
  }

  const normalizedText = normalizeText(parts.join("\n"));
  return {
    normalizedText,
    englishTokens: extractEnglishTokens(normalizedText),
    phase:
      taskState?.status && typeof taskState.status === "object"
        ? readTaskPhase((taskState.status as { phase?: unknown }).phase)
        : null,
    targetPaths: [...targetPaths],
  };
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

function scoreNaturalLanguageSignal(
  signal: string | undefined,
  input: PromptSignals,
  weights: {
    exact: number;
    strong: number;
    partial: number;
  },
): ScoredSignal {
  if (!signal) {
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

function scoreSignalSet(
  signals: readonly string[],
  input: PromptSignals,
  weights: {
    exact: number;
    strong: number;
    partial: number;
  },
): ScoredSignal {
  let best: ScoredSignal = { score: 0 };
  for (const signal of signals) {
    const scored = scoreNaturalLanguageSignal(signal, input, weights);
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
  input: PromptSignals,
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
  input: PromptSignals,
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
  input: PromptSignals,
): SkillRecommendation | null {
  if (!skill.contract.routing?.scope || !skill.contract.selection) {
    return null;
  }

  let score = 0;
  const reasons: string[] = [];

  const whenToUse = scoreNaturalLanguageSignal(skill.contract.selection.whenToUse, input, {
    exact: 2.7,
    strong: 2.45,
    partial: 1.9,
  });
  score += whenToUse.score;
  pushReason(reasons, whenToUse.reason);

  const exampleSignal = scoreSignalSet(skill.contract.selection.examples ?? [], input, {
    exact: 1.55,
    strong: 1.35,
    partial: 1.1,
  });
  score += exampleSignal.score;
  pushReason(reasons, exampleSignal.reason);

  const triggerSignal = scoreSignalSet(extractMarkdownBullets(skill.markdown, "Trigger"), input, {
    exact: 1.35,
    strong: 1.15,
    partial: 0.9,
  });
  score += triggerSignal.score;
  pushReason(reasons, triggerSignal.reason);

  const pathSignal = scoreSelectionPaths(skill.contract.selection.paths, input);
  score += pathSignal.score;
  pushReason(reasons, pathSignal.reason);

  const phaseSignal = scoreSelectionPhases(skill.contract.selection.phases, input);
  score += phaseSignal.score;
  pushReason(reasons, phaseSignal.reason);

  const normalizedName = normalizeText(skill.name);
  if (normalizedName && input.normalizedText.includes(normalizedName)) {
    score += 1.8;
    pushReason(reasons, skill.name);
  } else {
    for (const token of tokenizeName(skill.name)) {
      if (input.englishTokens.has(token)) {
        score += 0.9;
        pushReason(reasons, token);
      }
    }
  }

  for (const token of tokenizeSignalText(skill.description).slice(0, 8)) {
    if (input.englishTokens.has(token)) {
      score += 0.3;
      pushReason(reasons, token);
    }
  }

  for (const token of listSkillOutputs(skill.contract).flatMap((entry) => tokenizeName(entry))) {
    if (input.englishTokens.has(token)) {
      score += 0.28;
      pushReason(reasons, token);
    }
  }

  for (const toolName of [
    ...listSkillPreferredTools(skill.contract),
    ...listSkillFallbackTools(skill.contract),
  ]) {
    const normalizedTool = normalizeText(toolName);
    if (normalizedTool && input.normalizedText.includes(normalizedTool)) {
      score += 0.22;
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

export function deriveSkillRecommendations(
  runtime: SkillFirstRuntimeLike,
  input: {
    sessionId: string;
    prompt: string;
  },
): SkillRecommendationSet {
  const activeSkillName = runtime.skills.getActive(input.sessionId)?.name ?? null;
  if (activeSkillName) {
    return {
      activeSkillName,
      required: false,
      recommendations: [],
    };
  }

  const taskState = runtime.task.getState(input.sessionId);
  const signals = collectPromptSignals(input.prompt, taskState);
  if (!signals.normalizedText) {
    return {
      activeSkillName: null,
      required: false,
      recommendations: [],
    };
  }

  const scored = runtime.skills
    .list()
    .map((skill) => scoreSkill(skill, signals))
    .filter((entry): entry is SkillRecommendation => entry !== null)
    .toSorted((left, right) => right.score - left.score || left.name.localeCompare(right.name));

  const top = scored[0];
  if (!top) {
    return {
      activeSkillName: null,
      required: false,
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
    required: top.score >= REQUIRED_RECOMMENDATION_SCORE,
    recommendations: retained,
  };
}

function formatReasons(reasons: readonly string[]): string {
  return reasons.slice(0, MAX_REASON_COUNT).join(", ");
}

export function buildSkillFirstPolicyBlock(input: SkillRecommendationSet): string | null {
  if (input.recommendations.length === 0) {
    return null;
  }

  const primary = input.recommendations[0];
  if (!primary) {
    return null;
  }

  const lines = [
    "[Brewva Skill-First Policy]",
    "Brewva is skill-first.",
    "No active skill is currently loaded.",
  ];

  if (input.required) {
    lines.push(
      "This task already matches loaded skills strongly. Before substantive repository reads, searches, execution, or edits, call `skill_load` with the best match.",
    );
  } else {
    lines.push(
      "This task likely matches loaded skills. Prefer `skill_load` before deeper tool work.",
    );
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
