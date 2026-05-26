import { basename } from "node:path";
import { tokenizeSearchContent, tokenizeSearchQuery } from "@brewva/brewva-search";
import { sha256Hex } from "@brewva/brewva-std/hash";
import { compactWhitespace, truncateText } from "@brewva/brewva-std/text";
import type {
  BrewvaHostBeforeAgentStartResult,
  BrewvaHostCustomMessage,
} from "@brewva/brewva-substrate/host-api";
import { appendBrewvaSystemPromptTextSection } from "@brewva/brewva-substrate/prompt";
import { estimateModelTokens } from "@brewva/brewva-token-estimation";
import {
  listSkillResourceRefs,
  listSurfacedSkillResourceRefs,
  SKILLCARD_PROJECTION_LIMITS,
  type LoadableSkillCategory,
  type SkillDocument,
  type SkillInvocationRecord,
  type SkillInvocationSelectionTrigger,
} from "@brewva/brewva-vocabulary/session";
import { extractPromptTargetPaths, pathGlobMatches } from "../prompt-paths.js";
import { recordRuntimeSkillSelection } from "../runtime-ports.js";

const MAX_RENDERED_SKILLCARDS = 8;
const HIDDEN_CATEGORIES = new Set<LoadableSkillCategory>(["internal"]);
const STOP_WORDS = new Set([
  "about",
  "after",
  "against",
  "agent",
  "before",
  "build",
  "change",
  "changes",
  "code",
  "create",
  "current",
  "debug",
  "document",
  "file",
  "files",
  "from",
  "have",
  "implement",
  "implementation",
  "into",
  "need",
  "plan",
  "project",
  "request",
  "review",
  "task",
  "test",
  "tests",
  "that",
  "this",
  "update",
  "when",
  "with",
  "work",
  "workflow",
]);
const CJK_SKILL_INTENT_KEYWORD_BRIDGES: readonly {
  readonly pattern: RegExp;
  readonly keywords: readonly string[];
}[] = [
  {
    pattern: /架构图|系统图|核心架构|调用链|链路|架构|结构|模块|边界|接口|设计/u,
    keywords: ["architecture", "design", "module", "interface", "diagram", "system"],
  },
  {
    pattern: /仓库|代码库|项目结构|目录结构/u,
    keywords: ["repository", "analysis", "mapping"],
  },
  {
    pattern: /报错|错误|异常|卡住|死循环|根因|定位/u,
    keywords: ["debugging", "failure", "root", "cause"],
  },
  {
    pattern: /审查|评审|复查|review/u,
    keywords: ["review", "audit"],
  },
  {
    pattern: /计划|方案|规划/u,
    keywords: ["plan", "strategy"],
  },
  {
    pattern: /实现|修复|改代码|开发/u,
    keywords: ["implementation", "code"],
  },
  {
    pattern: /文档|说明|指南/u,
    keywords: ["documentation", "docs", "audit"],
  },
  {
    pattern: /测试|验证|校验/u,
    keywords: ["test", "verification", "verifier"],
  },
];

export type SkillSelectionTrigger = "user_message" | "discover_skills";
export type SkillSelectionMode =
  | "shortlist_prompt_context"
  | "explicit_over_budget_prompt_context"
  | "discover_guidance_receipt_only"
  | "discover_only_projection";
export type SkillSelectionReason = "explicit_mention" | "path_glob" | "name_match" | "text_match";

const REASON_PRIORITY: Record<SkillSelectionReason, number> = {
  explicit_mention: 500,
  path_glob: 400,
  name_match: 200,
  text_match: 100,
};

export interface SkillSelectionRuntime {
  ops: {
    skills: {
      catalog: {
        list(): SkillDocument[];
        get(name: string): SkillDocument | undefined;
      };
      selection: {
        record(sessionId: string, receipt: object): unknown;
        latest(sessionId: string): object | undefined;
      };
    };
  };
}

export interface SkillSelectionEventQueryRuntime {
  ops: {
    skills: {
      selection: {
        latest(sessionId: string): object | undefined;
      };
    };
  };
}

function listSkillCatalog(port: Pick<SkillSelectionRuntime, "ops">): SkillDocument[] {
  return port.ops.skills.catalog.list();
}

export interface AvailableSkillPromptContext {
  name: string;
  category: LoadableSkillCategory;
  description: string;
  whenToUse?: string;
  pathGlobs: readonly string[];
  filePath: string;
  argumentHints: readonly string[];
  outputArtifacts: readonly string[];
  resources: {
    readonly references: readonly string[];
    readonly scripts: readonly string[];
    readonly invariants: readonly string[];
  };
}

export interface ExplicitSkillMention {
  name: string;
  category: LoadableSkillCategory;
  reason: "explicit_mention";
  filePath: string;
}

export interface RenderedSkillReason {
  name: string;
  category: LoadableSkillCategory;
  reasons: SkillSelectionReason[];
  reasonCount: number;
  score: number;
  filePath: string;
}

export interface SkillSelectionReceipt {
  selectionId: string;
  trigger: SkillSelectionTrigger;
  explicitSkillMentions: ExplicitSkillMention[];
  availableSkillCount: number;
  candidateSkillCount: number;
  renderedSkillCount: number;
  omittedSkillCount: number;
  selectionMode: SkillSelectionMode;
  promptPaths: string[];
  renderedSkillReasons: RenderedSkillReason[];
  skillInvocationRecords: SkillInvocationRecord[];
  renderedSkillContext: {
    charCount: number;
    estimatedTokens: number;
    tokenEncoding: string;
    tokenEstimateMethod: string;
    tokenEstimateApproximation: boolean;
    maxRenderedSkillCount: number;
    textFieldMaxChars: number;
    listItemMaxCount: number;
    resourceRefMaxCount: number;
    overBudgetReason?: string;
  };
}

export interface SkillSelectionResult {
  receipt: SkillSelectionReceipt;
  availableSkills: AvailableSkillPromptContext[];
  renderedSection: string;
}

export interface SkillSelectionLifecycle {
  beforeAgentStart: (event: unknown, ctx: unknown) => BrewvaHostBeforeAgentStartResult | undefined;
}

interface SkillCandidate {
  skill: AvailableSkillPromptContext;
  reasons: SkillSelectionReason[];
  score: number;
}

interface RenderedSkillShortlist {
  section: string;
  tokenEstimate: ReturnType<typeof estimateModelTokens>;
  renderedCandidates: SkillCandidate[];
  candidateCount: number;
  promptPaths: string[];
  selectionMode: SkillSelectionMode;
  overBudgetReason?: string;
}

function getSessionId(ctx: unknown): string | null {
  if (!ctx || typeof ctx !== "object" || !("sessionManager" in ctx)) {
    return null;
  }
  const sessionManager = (ctx as { sessionManager?: unknown }).sessionManager;
  if (
    !sessionManager ||
    typeof sessionManager !== "object" ||
    !("getSessionId" in sessionManager)
  ) {
    return null;
  }
  const getSessionIdFn = (sessionManager as { getSessionId?: unknown }).getSessionId;
  if (typeof getSessionIdFn !== "function") {
    return null;
  }
  const candidate = getSessionIdFn.call(sessionManager);
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function wholeWordRegex(value: string, input: { dollarPrefixed?: boolean } = {}): RegExp {
  const escapedValue = escapeRegExp(value);
  const prefix = input.dollarPrefixed ? "\\$" : "";
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${prefix}${escapedValue}(?=$|[^A-Za-z0-9_-])`, "iu");
}

function normalizeWhitespace(value: string): string {
  return compactWhitespace(value);
}

function renderBoundedText(value: string): string {
  return truncateText(normalizeWhitespace(value), SKILLCARD_PROJECTION_LIMITS.textFieldMaxChars, {
    marker: "...",
  });
}

function takeBoundedList<T>(values: readonly T[], maxItems: number): readonly T[] {
  return values.slice(0, maxItems);
}

function renderBoundedStringList(values: readonly string[]): string {
  const surfaced = takeBoundedList(
    values.map(normalizeWhitespace),
    SKILLCARD_PROJECTION_LIMITS.listItemMaxCount,
  );
  const omitted = Math.max(0, values.length - surfaced.length);
  return omitted > 0 ? `${surfaced.join(", ")} (+${omitted} omitted)` : surfaced.join(", ");
}

function hasExplicitMention(prompt: string, skillName: string): boolean {
  return wholeWordRegex(skillName, { dollarPrefixed: true }).test(prompt);
}

function hasNameMatch(prompt: string, skillName: string): boolean {
  return wholeWordRegex(skillName).test(prompt);
}

function listPromptVisibleSkills(skills: readonly SkillDocument[]): SkillDocument[] {
  return skills
    .filter((skill) => !HIDDEN_CATEGORIES.has(skill.category))
    .toSorted(
      (left, right) =>
        left.category.localeCompare(right.category) || left.name.localeCompare(right.name),
    );
}

function toPromptContext(skill: SkillDocument): AvailableSkillPromptContext {
  return {
    name: skill.name,
    category: skill.category,
    description: skill.description,
    ...(skill.card.selection?.whenToUse ? { whenToUse: skill.card.selection.whenToUse } : {}),
    pathGlobs: skill.card.selection?.pathGlobs ?? [],
    filePath: skill.filePath,
    argumentHints: skill.card.argumentHints ?? [],
    outputArtifacts: skill.card.outputArtifacts ?? [],
    resources: skill.resources,
  };
}

function expandPromptForSkillIntent(prompt: string): string {
  const keywords = new Set<string>();
  for (const bridge of CJK_SKILL_INTENT_KEYWORD_BRIDGES) {
    if (!bridge.pattern.test(prompt)) {
      continue;
    }
    for (const keyword of bridge.keywords) {
      keywords.add(keyword);
    }
  }
  return keywords.size > 0 ? `${prompt} ${[...keywords].join(" ")}` : prompt;
}

function filterTextMatchTokens(tokens: readonly string[]): Set<string> {
  const filtered = new Set<string>();
  for (const token of tokens) {
    if (/^[a-z0-9_-]+$/u.test(token) && (token.length < 4 || STOP_WORDS.has(token))) {
      continue;
    }
    filtered.add(token);
  }
  return filtered;
}

function tokenizePromptForTextMatch(prompt: string): Set<string> {
  return filterTextMatchTokens(
    tokenizeSearchQuery(expandPromptForSkillIntent(prompt), { minLength: 2 }),
  );
}

function tokenizeSkillTextForTextMatch(text: string): Set<string> {
  return filterTextMatchTokens(tokenizeSearchContent(text, { minLength: 2 }));
}

function hasTextMatch(
  promptTokens: ReadonlySet<string>,
  skill: AvailableSkillPromptContext,
): boolean {
  const skillTokens = tokenizeSkillTextForTextMatch(
    [skill.description, skill.whenToUse ?? ""].join(" "),
  );
  let overlap = 0;
  for (const token of skillTokens) {
    if (!promptTokens.has(token)) {
      continue;
    }
    overlap += 1;
    if (overlap >= 2 || token.length >= 8) {
      return true;
    }
  }
  return false;
}

function rankReasons(reasons: ReadonlySet<SkillSelectionReason>): SkillSelectionReason[] {
  return [...reasons].toSorted(
    (left, right) => REASON_PRIORITY[right] - REASON_PRIORITY[left] || left.localeCompare(right),
  );
}

function scoreReasons(reasons: readonly SkillSelectionReason[]): number {
  return Math.max(0, ...reasons.map((reason) => REASON_PRIORITY[reason]));
}

function buildCandidate(input: {
  skill: AvailableSkillPromptContext;
  prompt: string;
  promptTokens: ReadonlySet<string>;
  promptPaths: readonly string[];
}): SkillCandidate | null {
  const reasons = new Set<SkillSelectionReason>();
  if (hasExplicitMention(input.prompt, input.skill.name)) {
    reasons.add("explicit_mention");
  }
  if (input.skill.pathGlobs.some((pathGlob) => pathGlobMatches(pathGlob, input.promptPaths))) {
    reasons.add("path_glob");
  }
  if (hasNameMatch(input.prompt, input.skill.name)) {
    reasons.add("name_match");
  }
  if (hasTextMatch(input.promptTokens, input.skill)) {
    reasons.add("text_match");
  }
  if (reasons.size === 0) {
    return null;
  }
  const rankedReasons = rankReasons(reasons);
  return {
    skill: input.skill,
    reasons: rankedReasons,
    score: scoreReasons(rankedReasons),
  };
}

function compareCandidates(left: SkillCandidate, right: SkillCandidate): number {
  return (
    right.score - left.score ||
    right.reasons.length - left.reasons.length ||
    left.skill.category.localeCompare(right.skill.category) ||
    left.skill.name.localeCompare(right.skill.name)
  );
}

function renderSkillEntry(candidate: SkillCandidate): string {
  const skill = candidate.skill;
  const lines = [
    `## ${skill.name}`,
    `category: ${skill.category}`,
    `filePath: ${skill.filePath}`,
    `selectionReasons: ${candidate.reasons.join(", ")}`,
    `description: ${renderBoundedText(skill.description)}`,
  ];
  if (skill.whenToUse) {
    lines.push(`whenToUse: ${renderBoundedText(skill.whenToUse)}`);
  }
  if (skill.pathGlobs.length > 0) {
    lines.push(`pathGlobs: ${renderBoundedStringList(skill.pathGlobs)}`);
  }
  const resourceRefs = listSurfacedSkillResourceRefs(skill);
  if (resourceRefs.length > 0) {
    const allResourceRefCount = listSkillResourceRefs(skill).length;
    const renderedRefs = resourceRefs.map((ref) => `${ref.kind}:${ref.path}`).join(", ");
    const omitted = Math.max(0, allResourceRefCount - resourceRefs.length);
    lines.push(
      `resourceRefs: ${omitted > 0 ? `${renderedRefs} (+${omitted} omitted)` : renderedRefs}`,
    );
  }
  if (skill.argumentHints.length > 0) {
    lines.push(`argumentHints: ${renderBoundedStringList(skill.argumentHints)}`);
  }
  if (skill.outputArtifacts.length > 0) {
    lines.push(`outputArtifacts: ${renderBoundedStringList(skill.outputArtifacts)}`);
  }
  return lines.join("\n");
}

function renderShortlistSection(candidates: readonly SkillCandidate[]): string {
  if (candidates.length === 0) {
    return "";
  }
  return [
    "",
    "",
    "# Available Brewva SkillCards",
    "",
    "These SkillCards are advisory, turn-scoped prompt context. They do not grant tools, permissions, accounts, budgets, side effects, or runtime authority.",
    "If you use a SkillCard, read its filePath first, then load only directly relevant references or scripts.",
    "Do not carry a SkillCard workflow into later turns unless that later turn selects it again.",
    "",
    ...candidates.map(renderSkillEntry),
  ].join("\n");
}

function buildSkillShortlist(input: {
  skills: readonly AvailableSkillPromptContext[];
  prompt: string;
  promptPaths?: readonly string[];
  maxRenderedSkills: number;
}): RenderedSkillShortlist {
  const promptPaths = input.promptPaths ?? extractPromptTargetPaths(input.prompt);
  const promptTokens = tokenizePromptForTextMatch(input.prompt);
  const candidates = input.skills
    .map((skill) =>
      buildCandidate({
        skill,
        prompt: input.prompt,
        promptTokens,
        promptPaths,
      }),
    )
    .filter((candidate): candidate is SkillCandidate => candidate !== null)
    .toSorted(compareCandidates);
  const explicitCandidates = candidates.filter((candidate) =>
    candidate.reasons.includes("explicit_mention"),
  );
  const overExplicitBudget = explicitCandidates.length > input.maxRenderedSkills;
  const renderedCandidates = overExplicitBudget
    ? explicitCandidates
    : candidates.slice(0, input.maxRenderedSkills);
  const selectionMode: SkillSelectionMode =
    candidates.length === 0
      ? "discover_guidance_receipt_only"
      : overExplicitBudget
        ? "explicit_over_budget_prompt_context"
        : "shortlist_prompt_context";
  const section = renderShortlistSection(renderedCandidates);
  return {
    section,
    tokenEstimate: estimateModelTokens(section),
    renderedCandidates,
    candidateCount: candidates.length,
    promptPaths: [...promptPaths],
    selectionMode,
    ...(overExplicitBudget ? { overBudgetReason: "explicit_mentions_exceed_render_cap" } : {}),
  };
}

function makeSelectionId(input: {
  trigger: SkillSelectionTrigger;
  prompt: string;
  renderedSkillReasons: readonly RenderedSkillReason[];
  promptPaths: readonly string[];
  availableSkillNames: readonly string[];
}): string {
  const digest = sha256Hex(
    [
      input.trigger,
      input.prompt,
      input.promptPaths.join("\0"),
      input.renderedSkillReasons
        .map((skill) => `${skill.name}:${skill.reasons.join(",")}`)
        .join("\0"),
      input.availableSkillNames.join("\0"),
    ].join("\0"),
  ).slice(0, 16);
  return `skill_selection_${digest}`;
}

function toRenderedSkillReason(candidate: SkillCandidate): RenderedSkillReason {
  return {
    name: candidate.skill.name,
    category: candidate.skill.category,
    reasons: [...candidate.reasons],
    reasonCount: candidate.reasons.length,
    score: candidate.score,
    filePath: candidate.skill.filePath,
  };
}

function toExplicitSkillMention(candidate: SkillCandidate): ExplicitSkillMention {
  return {
    name: candidate.skill.name,
    category: candidate.skill.category,
    reason: "explicit_mention",
    filePath: candidate.skill.filePath,
  };
}

function buildReceipt(input: {
  trigger: SkillSelectionTrigger;
  prompt: string;
  availableSkillNames: readonly string[];
  renderedShortlist: RenderedSkillShortlist;
  maxRenderedSkillCount: number;
}): SkillSelectionReceipt {
  const renderedSkillReasons =
    input.renderedShortlist.renderedCandidates.map(toRenderedSkillReason);
  const selectionId = makeSelectionId({
    trigger: input.trigger,
    prompt: input.prompt,
    renderedSkillReasons,
    promptPaths: input.renderedShortlist.promptPaths,
    availableSkillNames: input.availableSkillNames,
  });
  const explicitSkillMentions = input.renderedShortlist.renderedCandidates
    .filter((candidate) => candidate.reasons.includes("explicit_mention"))
    .map(toExplicitSkillMention);
  const skillInvocationRecords = input.renderedShortlist.renderedCandidates.map((candidate) =>
    toSkillInvocationRecord({
      selectionId,
      candidate,
    }),
  );
  return {
    selectionId,
    trigger: input.trigger,
    explicitSkillMentions,
    availableSkillCount: input.availableSkillNames.length,
    candidateSkillCount: input.renderedShortlist.candidateCount,
    renderedSkillCount: input.renderedShortlist.renderedCandidates.length,
    omittedSkillCount:
      input.availableSkillNames.length - input.renderedShortlist.renderedCandidates.length,
    selectionMode: input.renderedShortlist.selectionMode,
    promptPaths: [...input.renderedShortlist.promptPaths],
    renderedSkillReasons,
    skillInvocationRecords,
    renderedSkillContext: {
      charCount: input.renderedShortlist.section.length,
      estimatedTokens: input.renderedShortlist.tokenEstimate.tokens,
      tokenEncoding: input.renderedShortlist.tokenEstimate.encoding,
      tokenEstimateMethod: input.renderedShortlist.tokenEstimate.method,
      tokenEstimateApproximation: input.renderedShortlist.tokenEstimate.approximation,
      maxRenderedSkillCount: input.maxRenderedSkillCount,
      textFieldMaxChars: SKILLCARD_PROJECTION_LIMITS.textFieldMaxChars,
      listItemMaxCount: SKILLCARD_PROJECTION_LIMITS.listItemMaxCount,
      resourceRefMaxCount: SKILLCARD_PROJECTION_LIMITS.resourceRefMaxCount,
      ...(input.renderedShortlist.overBudgetReason
        ? { overBudgetReason: input.renderedShortlist.overBudgetReason }
        : {}),
    },
  };
}

function skillInvocationSelectionTrigger(
  candidate: SkillCandidate,
): SkillInvocationSelectionTrigger {
  return candidate.reasons.includes("explicit_mention") ? "explicit_command" : "suggested";
}

function toSkillInvocationRecord(input: {
  selectionId: string;
  candidate: SkillCandidate;
}): SkillInvocationRecord {
  const renderedEntry = renderSkillEntry(input.candidate);
  const tokenEstimate = estimateModelTokens(renderedEntry);
  return {
    invocationId: `${input.selectionId}:${input.candidate.skill.name}`,
    skillName: input.candidate.skill.name,
    category: input.candidate.skill.category,
    sourcePath: input.candidate.skill.filePath,
    sourcePackage: null,
    selectionTrigger: skillInvocationSelectionTrigger(input.candidate),
    invocationMode: "prompt_visible",
    resourceRefs: listSurfacedSkillResourceRefs(input.candidate.skill),
    estimatedTokens: tokenEstimate.tokens,
    tokenEncoding: tokenEstimate.encoding,
    tokenEstimateMethod: tokenEstimate.method,
    tokenEstimateApproximation: tokenEstimate.approximation,
    capabilityRefs: [],
    requestedOutputArtifacts: input.candidate.skill.outputArtifacts,
    argumentHints: input.candidate.skill.argumentHints,
  };
}

export function readLatestSkillSelectionReceipt(input: {
  runtime: SkillSelectionEventQueryRuntime;
  sessionId: string;
}): SkillSelectionReceipt | undefined {
  const payload = input.runtime.ops.skills.selection.latest(input.sessionId);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const receipt = payload as Partial<SkillSelectionReceipt>;
  return typeof receipt.selectionId === "string" &&
    Array.isArray(receipt.explicitSkillMentions) &&
    typeof receipt.selectionMode === "string"
    ? (receipt as SkillSelectionReceipt)
    : undefined;
}

export function buildSkillShortlistContextForPrompt(input: {
  runtime: Pick<SkillSelectionRuntime, "ops">;
  prompt: string;
  promptPaths?: readonly string[];
  maxRenderedSkills?: number;
}): SkillSelectionResult {
  const trigger: SkillSelectionTrigger = "user_message";
  const skills = listPromptVisibleSkills(listSkillCatalog(input.runtime));
  const availableSkills = skills.map(toPromptContext);
  const maxRenderedSkills = input.maxRenderedSkills ?? MAX_RENDERED_SKILLCARDS;
  const renderedShortlist = buildSkillShortlist({
    skills: availableSkills,
    prompt: input.prompt,
    promptPaths: input.promptPaths,
    maxRenderedSkills,
  });
  const receipt = buildReceipt({
    trigger,
    prompt: input.prompt,
    availableSkillNames: availableSkills.map((skill) => skill.name),
    renderedShortlist,
    maxRenderedSkillCount: maxRenderedSkills,
  });
  return {
    receipt,
    availableSkills,
    renderedSection: renderedShortlist.section,
  };
}

export function formatSkillSelectionSection(selection: SkillSelectionResult): string {
  return selection.renderedSection;
}

function formatSkillSelectionTraceMessage(receipt: SkillSelectionReceipt): BrewvaHostCustomMessage {
  const explicitSkillMentionNames = explicitSkillMentionNamesFromReceipt(receipt);
  const visibleSelection = receipt.renderedSkillCount > 0 || explicitSkillMentionNames.length > 0;
  return {
    customType: "brewva-skill-selection",
    content: [
      `Available Brewva SkillCards: ${receipt.availableSkillCount}`,
      `Candidate Brewva SkillCards: ${receipt.candidateSkillCount}`,
      `Rendered Brewva SkillCards: ${receipt.renderedSkillCount}`,
      `Omitted Brewva SkillCards: ${receipt.omittedSkillCount}`,
      `Prompt Paths: ${receipt.promptPaths.length}`,
      `Explicit Brewva SkillCard Mentions: ${
        explicitSkillMentionNames.length > 0 ? explicitSkillMentionNames.join(", ") : "none"
      }`,
      `Selection ID: ${receipt.selectionId}`,
      `Selection Mode: ${receipt.selectionMode}`,
    ].join("\n"),
    display: visibleSelection,
    excludeFromContext: true,
    details: {
      selectionId: receipt.selectionId,
      explicitSkillMentionNames,
      explicitSkillMentions: receipt.explicitSkillMentions,
      availableSkillCount: receipt.availableSkillCount,
      candidateSkillCount: receipt.candidateSkillCount,
      renderedSkillCount: receipt.renderedSkillCount,
      omittedSkillCount: receipt.omittedSkillCount,
      promptPaths: receipt.promptPaths,
      renderedSkillReasons: receipt.renderedSkillReasons,
      skillInvocationRecords: receipt.skillInvocationRecords,
      renderedSkillContext: receipt.renderedSkillContext,
      selectionMode: receipt.selectionMode,
      trigger: receipt.trigger,
    },
  };
}

export function createSkillSelectionLifecycle(
  runtime: SkillSelectionRuntime,
): SkillSelectionLifecycle {
  return {
    beforeAgentStart(event, ctx) {
      const rawEvent = event as {
        prompt?: unknown;
        promptPaths?: unknown;
        systemPrompt?: unknown;
      };
      const sessionId = getSessionId(ctx);
      if (!sessionId) {
        return undefined;
      }
      const prompt = typeof rawEvent.prompt === "string" ? rawEvent.prompt : "";
      const promptPaths = Array.isArray(rawEvent.promptPaths)
        ? rawEvent.promptPaths.filter((path): path is string => typeof path === "string")
        : undefined;
      const selection = buildSkillShortlistContextForPrompt({ runtime, prompt, promptPaths });
      recordRuntimeSkillSelection(runtime, sessionId, selection.receipt);
      const section = formatSkillSelectionSection(selection);
      const systemPrompt = typeof rawEvent.systemPrompt === "string" ? rawEvent.systemPrompt : "";
      const result: BrewvaHostBeforeAgentStartResult = {
        message: formatSkillSelectionTraceMessage(selection.receipt),
      };
      if (section) {
        result.systemPrompt = appendBrewvaSystemPromptTextSection({
          systemPrompt,
          section,
        });
      }
      return result;
    },
  };
}

export function explicitSkillMentionNamesFromReceipt(
  receipt: SkillSelectionReceipt | undefined,
): string[] {
  return receipt?.explicitSkillMentions.map((skill) => skill.name) ?? [];
}

export function skillSelectionSummaryForTrace(receipt: SkillSelectionReceipt | undefined): {
  explicitSkillMentionNames: string[];
  skillSelectionId: string | null;
  skillSelectionMode: SkillSelectionMode | null;
} {
  return {
    explicitSkillMentionNames: explicitSkillMentionNamesFromReceipt(receipt),
    skillSelectionId: receipt?.selectionId ?? null,
    skillSelectionMode: receipt?.selectionMode ?? null,
  };
}

export function describeAvailableSkillForDisplay(skill: AvailableSkillPromptContext): string {
  return `${skill.name} (${skill.category}, ${basename(skill.filePath)})`;
}
