import { basename } from "node:path";
import type { LoadableSkillCategory, SkillDocument } from "@brewva/brewva-runtime/protocol";
import { sha256Hex } from "@brewva/brewva-std/hash";
import type {
  BrewvaHostBeforeAgentStartResult,
  BrewvaHostCustomMessage,
} from "@brewva/brewva-substrate/host-api";
import { estimateModelTokens } from "@brewva/brewva-token-estimation";
import { appendHostedSystemPromptSection } from "../../system-prompt-text.js";
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

export type SkillSelectionTrigger = "user_message";
export type SkillSelectionMode =
  | "shortlist_prompt_context"
  | "explicit_over_budget_prompt_context"
  | "discover_guidance_prompt_context";
export type SkillSelectionReason =
  | "explicit_mention"
  | "path_glob"
  | "trigger"
  | "name_match"
  | "text_match";

const REASON_PRIORITY: Record<SkillSelectionReason, number> = {
  explicit_mention: 500,
  path_glob: 400,
  trigger: 300,
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
  triggers: readonly string[];
  pathGlobs: readonly string[];
  filePath: string;
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
  renderedSkillReasons: RenderedSkillReason[];
  renderedSkillContext: {
    charCount: number;
    estimatedTokens: number;
    tokenEncoding: string;
    tokenEstimateMethod: string;
    tokenEstimateApproximation: boolean;
    maxRenderedSkillCount: number;
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

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function hasExplicitMention(prompt: string, skillName: string): boolean {
  const escapedName = escapeRegExp(skillName);
  return new RegExp(`(?:^|[^A-Za-z0-9_-])\\$${escapedName}(?=$|[^A-Za-z0-9_-])`, "iu").test(prompt);
}

function hasNameMatch(prompt: string, skillName: string): boolean {
  const escapedName = escapeRegExp(skillName);
  return new RegExp(`(?:^|[^A-Za-z0-9_-])${escapedName}(?=$|[^A-Za-z0-9_-])`, "iu").test(prompt);
}

function hasTriggerMatch(prompt: string, trigger: string): boolean {
  const normalizedTrigger = normalizeWhitespace(trigger).toLowerCase();
  return normalizedTrigger.length > 0 && prompt.toLowerCase().includes(normalizedTrigger);
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
    triggers: skill.card.selection?.triggers ?? [],
    pathGlobs: skill.card.selection?.pathGlobs ?? [],
    filePath: skill.filePath,
  };
}

function tokenizeForTextMatch(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const rawToken of text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/gu) ?? []) {
    const token = rawToken.replace(/^[-_]+|[-_]+$/gu, "");
    if (token.length < 4 || STOP_WORDS.has(token)) {
      continue;
    }
    tokens.add(token);
  }
  return tokens;
}

function hasTextMatch(
  promptTokens: ReadonlySet<string>,
  skill: AvailableSkillPromptContext,
): boolean {
  const skillTokens = tokenizeForTextMatch([skill.description, skill.whenToUse ?? ""].join(" "));
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
  if (input.skill.triggers.some((trigger) => hasTriggerMatch(input.prompt, trigger))) {
    reasons.add("trigger");
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
    `description: ${normalizeWhitespace(skill.description)}`,
  ];
  if (skill.whenToUse) {
    lines.push(`whenToUse: ${normalizeWhitespace(skill.whenToUse)}`);
  }
  if (skill.triggers.length > 0) {
    lines.push(`triggers: ${skill.triggers.map(normalizeWhitespace).join(", ")}`);
  }
  if (skill.pathGlobs.length > 0) {
    lines.push(`pathGlobs: ${skill.pathGlobs.map(normalizeWhitespace).join(", ")}`);
  }
  return lines.join("\n");
}

function renderShortlistSection(candidates: readonly SkillCandidate[]): string {
  if (candidates.length === 0) {
    return [
      "",
      "",
      "# Available Brewva SkillCards",
      "",
      "SkillCards are advisory, turn-scoped prompt context. They do not grant tools, permissions, accounts, budgets, side effects, or runtime authority.",
      "No SkillCards were deterministically shortlisted for this turn. Use discover_skills if a specialized workflow would materially help.",
    ].join("\n");
  }
  return [
    "",
    "",
    "# Available Brewva SkillCards",
    "",
    "These SkillCards are advisory, turn-scoped prompt context. They do not grant tools, permissions, accounts, budgets, side effects, or runtime authority.",
    "If you use a SkillCard, read its filePath first, then load only directly relevant references or scripts.",
    "Do not carry a SkillCard workflow into later turns unless that later turn triggers it again.",
    "",
    ...candidates.map(renderSkillEntry),
  ].join("\n");
}

function buildSkillShortlist(input: {
  skills: readonly AvailableSkillPromptContext[];
  prompt: string;
  maxRenderedSkills: number;
}): RenderedSkillShortlist {
  const promptPaths = extractPromptTargetPaths(input.prompt);
  const promptTokens = tokenizeForTextMatch(input.prompt);
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
      ? "discover_guidance_prompt_context"
      : overExplicitBudget
        ? "explicit_over_budget_prompt_context"
        : "shortlist_prompt_context";
  const section = renderShortlistSection(renderedCandidates);
  return {
    section,
    tokenEstimate: estimateModelTokens(section),
    renderedCandidates,
    candidateCount: candidates.length,
    selectionMode,
    ...(overExplicitBudget ? { overBudgetReason: "explicit_mentions_exceed_render_cap" } : {}),
  };
}

function makeSelectionId(input: {
  trigger: SkillSelectionTrigger;
  prompt: string;
  renderedSkillReasons: readonly RenderedSkillReason[];
  availableSkillNames: readonly string[];
}): string {
  const digest = sha256Hex(
    [
      input.trigger,
      input.prompt,
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
  const explicitSkillMentions = input.renderedShortlist.renderedCandidates
    .filter((candidate) => candidate.reasons.includes("explicit_mention"))
    .map(toExplicitSkillMention);
  return {
    selectionId: makeSelectionId({
      trigger: input.trigger,
      prompt: input.prompt,
      renderedSkillReasons,
      availableSkillNames: input.availableSkillNames,
    }),
    trigger: input.trigger,
    explicitSkillMentions,
    availableSkillCount: input.availableSkillNames.length,
    candidateSkillCount: input.renderedShortlist.candidateCount,
    renderedSkillCount: input.renderedShortlist.renderedCandidates.length,
    omittedSkillCount:
      input.availableSkillNames.length - input.renderedShortlist.renderedCandidates.length,
    selectionMode: input.renderedShortlist.selectionMode,
    renderedSkillReasons,
    renderedSkillContext: {
      charCount: input.renderedShortlist.section.length,
      estimatedTokens: input.renderedShortlist.tokenEstimate.tokens,
      tokenEncoding: input.renderedShortlist.tokenEstimate.encoding,
      tokenEstimateMethod: input.renderedShortlist.tokenEstimate.method,
      tokenEstimateApproximation: input.renderedShortlist.tokenEstimate.approximation,
      maxRenderedSkillCount: input.maxRenderedSkillCount,
      ...(input.renderedShortlist.overBudgetReason
        ? { overBudgetReason: input.renderedShortlist.overBudgetReason }
        : {}),
    },
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
  maxRenderedSkills?: number;
}): SkillSelectionResult {
  const trigger: SkillSelectionTrigger = "user_message";
  const skills = listPromptVisibleSkills(listSkillCatalog(input.runtime));
  const availableSkills = skills.map(toPromptContext);
  const maxRenderedSkills = input.maxRenderedSkills ?? MAX_RENDERED_SKILLCARDS;
  const renderedShortlist = buildSkillShortlist({
    skills: availableSkills,
    prompt: input.prompt,
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
  return {
    customType: "brewva-skill-selection",
    content: [
      `Available Brewva SkillCards: ${receipt.availableSkillCount}`,
      `Candidate Brewva SkillCards: ${receipt.candidateSkillCount}`,
      `Rendered Brewva SkillCards: ${receipt.renderedSkillCount}`,
      `Omitted Brewva SkillCards: ${receipt.omittedSkillCount}`,
      `Explicit Brewva SkillCard Mentions: ${
        explicitSkillMentionNames.length > 0 ? explicitSkillMentionNames.join(", ") : "none"
      }`,
      `Selection ID: ${receipt.selectionId}`,
      `Selection Mode: ${receipt.selectionMode}`,
    ].join("\n"),
    display: false,
    excludeFromContext: true,
    details: {
      selectionId: receipt.selectionId,
      explicitSkillMentionNames,
      explicitSkillMentions: receipt.explicitSkillMentions,
      availableSkillCount: receipt.availableSkillCount,
      candidateSkillCount: receipt.candidateSkillCount,
      renderedSkillCount: receipt.renderedSkillCount,
      omittedSkillCount: receipt.omittedSkillCount,
      renderedSkillReasons: receipt.renderedSkillReasons,
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
      const rawEvent = event as { prompt?: unknown; systemPrompt?: unknown };
      const sessionId = getSessionId(ctx);
      if (!sessionId) {
        return undefined;
      }
      const prompt = typeof rawEvent.prompt === "string" ? rawEvent.prompt : "";
      const selection = buildSkillShortlistContextForPrompt({ runtime, prompt });
      recordRuntimeSkillSelection(runtime, sessionId, selection.receipt);
      const section = formatSkillSelectionSection(selection);
      if (!section) {
        return undefined;
      }
      const systemPrompt = typeof rawEvent.systemPrompt === "string" ? rawEvent.systemPrompt : "";
      return {
        message: formatSkillSelectionTraceMessage(selection.receipt),
        systemPrompt: appendHostedSystemPromptSection({
          systemPrompt,
          section,
        }),
      };
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
