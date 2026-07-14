import { basename } from "node:path";
import { sha256Hex } from "@brewva/brewva-std/hash";
import { compactWhitespace, truncateText } from "@brewva/brewva-std/text";
import { isRecord } from "@brewva/brewva-std/unknown";
import type {
  BrewvaHostBeforeAgentStartResult,
  BrewvaHostCustomMessage,
} from "@brewva/brewva-substrate/host-api";
import { appendBrewvaSystemPromptTextSection } from "@brewva/brewva-substrate/prompt";
import { estimateModelTokens } from "@brewva/brewva-token-estimation";
import { MANAGED_BREWVA_TOOL_NAMES } from "@brewva/brewva-tools/registry";
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
import {
  formatSkillOpenedLine,
  projectLatestSkillOpened,
  projectRecentToolTargetPaths,
  queryRecentSkillProjectionInputs,
  type SkillOpenedSample,
  type SkillProjectionQueryPort,
} from "./skill-projections.js";

const MAX_RENDERED_SKILLCARDS = 8;
const HIDDEN_CATEGORIES = new Set<LoadableSkillCategory>(["internal"]);
// The always-visible catalog layer: names + one short line each. Its content
// depends only on the catalog (never on the prompt), so the section is
// byte-stable across turns and prompt-cache friendly. Visibility is the point:
// a scorer miss must never mean the model cannot know a skill exists.
const CATALOG_MAX_ENTRIES = 40;
const CATALOG_LINE_MAX_CHARS = 120;
// Cap on the deduplicated recent paths surfaced in the receipt and matched
// against path_globs — the OUTPUT side. The queried event-tail size lives in
// skill-projections.ts as RECENT_INVOCATION_QUERY_WINDOW (the INPUT side).
const RECENT_TOOL_PATH_LIMIT = 8;
export type SkillSelectionTrigger = "user_message" | "discover_skills";
export type SkillSelectionMode =
  | "shortlist_prompt_context"
  | "explicit_over_budget_prompt_context"
  | "discover_guidance_receipt_only"
  | "discover_only_projection";
export type SkillSelectionReason =
  | "explicit_mention"
  | "path_glob"
  | "recent_path"
  | "name_match"
  | "text_match";

const REASON_PRIORITY: Record<SkillSelectionReason, number> = {
  explicit_mention: 500,
  // A path the user named in the prompt outranks one the session merely touched.
  path_glob: 400,
  recent_path: 300,
  name_match: 200,
  // Produced ONLY by discover_skills (an explicit, model-invoked text search).
  // The auto-selector no longer fuzzy-text-matches, so nothing else mints this.
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
    /**
     * Optional tape access: recently touched tool paths become a selection
     * signal and the previous selection's opened status becomes trace evidence.
     * Absent in narrow fixtures; both features degrade to silence.
     */
    events?: {
      records: SkillProjectionQueryPort;
    };
  };
  /**
   * Session workspace root, used to relativize the absolute paths on commitment
   * events to the workspace-relative form skill path-globs match against. Absent
   * in narrow fixtures; recent-path relativization degrades to absolute paths
   * (which correctly never match workspace globs) rather than failing.
   */
  identity?: { workspaceRoot?: string | null };
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
  /** Managed tools this skill's document instructs (backticked mentions). */
  instructedToolNames: readonly string[];
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
  recentToolPaths: string[];
  renderedSkillReasons: RenderedSkillReason[];
  skillInvocationRecords: SkillInvocationRecord[];
  /**
   * Union of the rendered skills' instructed tools. The tool surface unions
   * this set into the skill-surface pull gate for the turn, so a skill that
   * says "record it with `verification_record`" always has that tool reachable
   * on the turns it renders.
   */
  instructedToolNames: string[];
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
  /** Session-stable catalog layer (byte-identical across turns). */
  catalogSection: string;
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
  recentToolPaths: string[];
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

const MANAGED_TOOL_NAME_SET: ReadonlySet<string> = new Set(MANAGED_BREWVA_TOOL_NAMES);
// Skill documents reference the tools they instruct in backticks
// (`verification_record`, `$knowledge_capture`). The intersection with the
// managed registry is the skill's instructed-tool set: when the skill renders
// for a turn, those tools must be reachable, so the tool surface unions them
// into the pull gate (the "skill commitments" half of the documented policy).
const INSTRUCTED_TOOL_MENTION_PATTERN = /`\$?([a-z][a-z0-9_]{2,})`/gu;

export function extractInstructedToolNames(markdown: string): string[] {
  const found = new Set<string>();
  for (const match of markdown.matchAll(INSTRUCTED_TOOL_MENTION_PATTERN)) {
    const candidate = match[1];
    if (candidate && MANAGED_TOOL_NAME_SET.has(candidate)) {
      found.add(candidate);
    }
  }
  return [...found].toSorted((left, right) => left.localeCompare(right));
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
    instructedToolNames: extractInstructedToolNames(skill.markdown),
  };
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
  promptPaths: readonly string[];
  recentToolPaths: readonly string[];
}): SkillCandidate | null {
  const reasons = new Set<SkillSelectionReason>();
  if (hasExplicitMention(input.prompt, input.skill.name)) {
    reasons.add("explicit_mention");
  }
  if (input.skill.pathGlobs.some((pathGlob) => pathGlobMatches(pathGlob, input.promptPaths))) {
    reasons.add("path_glob");
  }
  if (
    input.recentToolPaths.length > 0 &&
    input.skill.pathGlobs.some((pathGlob) => pathGlobMatches(pathGlob, input.recentToolPaths))
  ) {
    reasons.add("recent_path");
  }
  if (hasNameMatch(input.prompt, input.skill.name)) {
    reasons.add("name_match");
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

// Skill name/category come from workspace frontmatter (a writable overlay);
// collapse whitespace and bound length so a crafted value cannot smuggle
// extra markdown lines into the prompt sections built around them.
const INLINE_LABEL_MAX_CHARS = 80;

function sanitizeInlineLabel(value: string): string {
  return truncateText(compactWhitespace(value), INLINE_LABEL_MAX_CHARS, { marker: "..." });
}

function renderSkillEntry(candidate: SkillCandidate): string {
  const skill = candidate.skill;
  const lines = [
    `## ${sanitizeInlineLabel(skill.name)}`,
    `category: ${sanitizeInlineLabel(skill.category)}`,
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
    "# Shortlisted Brewva SkillCards (this turn)",
    "",
    "These SkillCards matched this turn's prompt. They are advisory, turn-scoped prompt context and do not grant tools, permissions, accounts, budgets, side effects, or runtime authority.",
    "If a shortlisted SkillCard matches the task, read its filePath BEFORE acting on the task, then load only the directly relevant references or scripts.",
    "Do not carry a SkillCard workflow into later turns unless that later turn selects it again.",
    "",
    ...candidates.map(renderSkillEntry),
  ].join("\n");
}

function renderCatalogLine(skill: AvailableSkillPromptContext): string {
  const guidance = truncateText(
    normalizeWhitespace(skill.whenToUse ?? skill.description),
    CATALOG_LINE_MAX_CHARS,
    { marker: "..." },
  );
  return `- ${sanitizeInlineLabel(skill.name)}: ${guidance}`;
}

/**
 * The always-visible catalog layer: every prompt-visible skill as one bounded
 * line, grouped by category. Content depends only on the catalog — never on
 * the prompt — so the section is byte-identical across turns (prompt-cache
 * friendly) and a shortlist miss can no longer hide a skill's existence.
 */
export function renderSkillCatalogSection(skills: readonly AvailableSkillPromptContext[]): string {
  if (skills.length === 0) {
    return "";
  }
  const surfaced = skills.slice(0, CATALOG_MAX_ENTRIES);
  const omitted = skills.length - surfaced.length;
  const lines: string[] = [
    "",
    "",
    "# Brewva SkillCard Catalog",
    "",
    "Every SkillCard available in this workspace (advisory names only; no runtime authority).",
    "If one matches the task at hand — even when it is not shortlisted below — read its filePath before acting.",
    "When unsure which applies, call discover_skills with a task description.",
  ];
  let currentCategory: string | null = null;
  for (const skill of surfaced) {
    if (skill.category !== currentCategory) {
      currentCategory = skill.category;
      lines.push("", `## ${sanitizeInlineLabel(skill.category)}`);
    }
    lines.push(renderCatalogLine(skill));
  }
  if (omitted > 0) {
    lines.push("", `(+${omitted} more SkillCards — search with discover_skills)`);
  }
  return lines.join("\n");
}

function buildSkillShortlist(input: {
  skills: readonly AvailableSkillPromptContext[];
  prompt: string;
  promptPaths?: readonly string[];
  recentToolPaths?: readonly string[];
  maxRenderedSkills: number;
}): RenderedSkillShortlist {
  const promptPaths = input.promptPaths ?? extractPromptTargetPaths(input.prompt);
  const recentToolPaths = input.recentToolPaths ?? [];
  const rawCandidates = input.skills
    .map((skill) =>
      buildCandidate({
        skill,
        prompt: input.prompt,
        promptPaths,
        recentToolPaths,
      }),
    )
    .filter((candidate): candidate is SkillCandidate => candidate !== null);
  const candidates = rawCandidates.toSorted(compareCandidates);
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
    recentToolPaths: [...recentToolPaths],
    selectionMode,
    ...(overExplicitBudget ? { overBudgetReason: "explicit_mentions_exceed_render_cap" } : {}),
  };
}

function makeSelectionId(input: {
  trigger: SkillSelectionTrigger;
  prompt: string;
  renderedSkillReasons: readonly RenderedSkillReason[];
  promptPaths: readonly string[];
  recentToolPaths: readonly string[];
  availableSkillNames: readonly string[];
}): string {
  const digest = sha256Hex(
    [
      input.trigger,
      input.prompt,
      input.promptPaths.join("\0"),
      input.recentToolPaths.join("\0"),
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
    recentToolPaths: input.renderedShortlist.recentToolPaths,
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
  const instructedToolNames = [
    ...new Set(
      input.renderedShortlist.renderedCandidates.flatMap((candidate) => [
        ...candidate.skill.instructedToolNames,
      ]),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
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
    recentToolPaths: [...input.renderedShortlist.recentToolPaths],
    renderedSkillReasons,
    skillInvocationRecords,
    instructedToolNames,
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
  if (!isRecord(payload)) {
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
  recentToolPaths?: readonly string[];
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
    recentToolPaths: input.recentToolPaths,
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
    catalogSection: renderSkillCatalogSection(availableSkills),
  };
}

export function formatSkillSelectionSection(selection: SkillSelectionResult): string {
  return selection.renderedSection;
}

function formatSkillSelectionTraceMessage(
  receipt: SkillSelectionReceipt,
  previousOpened: SkillOpenedSample | null,
): BrewvaHostCustomMessage {
  const explicitSkillMentionNames = explicitSkillMentionNamesFromReceipt(receipt);
  const visibleSelection = receipt.renderedSkillCount > 0 || explicitSkillMentionNames.length > 0;
  const selectedSkillsSummary =
    receipt.renderedSkillReasons.length > 0
      ? receipt.renderedSkillReasons
          .map((skill) => `${skill.name} (${skill.reasons.join("+")})`)
          .join(", ")
      : "none";
  return {
    customType: "brewva-skill-selection",
    content: [
      `Selected Skills: ${selectedSkillsSummary}`,
      `Available Brewva SkillCards: ${receipt.availableSkillCount}`,
      `Candidate Brewva SkillCards: ${receipt.candidateSkillCount}`,
      `Rendered Brewva SkillCards: ${receipt.renderedSkillCount}`,
      `Omitted Brewva SkillCards: ${receipt.omittedSkillCount}`,
      `Prompt Paths: ${receipt.promptPaths.length}`,
      `Recent Tool Paths: ${receipt.recentToolPaths.length}`,
      `Explicit Brewva SkillCard Mentions: ${
        explicitSkillMentionNames.length > 0 ? explicitSkillMentionNames.join(", ") : "none"
      }`,
      formatSkillOpenedLine(previousOpened),
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
      recentToolPaths: receipt.recentToolPaths,
      renderedSkillReasons: receipt.renderedSkillReasons,
      skillInvocationRecords: receipt.skillInvocationRecords,
      renderedSkillContext: receipt.renderedSkillContext,
      selectionMode: receipt.selectionMode,
      trigger: receipt.trigger,
      ...(previousOpened ? { previousOpened } : {}),
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
      const sessionEvents = queryRecentSkillProjectionInputs(
        runtime.ops.events?.records,
        sessionId,
      );
      const recentToolPaths = projectRecentToolTargetPaths(
        sessionEvents.recentInvocations,
        RECENT_TOOL_PATH_LIMIT,
        runtime.identity?.workspaceRoot ?? null,
      );
      const previousOpened = projectLatestSkillOpened(sessionEvents.openedEvents);
      const selection = buildSkillShortlistContextForPrompt({
        runtime,
        prompt,
        promptPaths,
        recentToolPaths,
      });
      recordRuntimeSkillSelection(runtime, sessionId, selection.receipt);
      const shortlistSection = formatSkillSelectionSection(selection);
      // Catalog first (byte-stable across turns), turn-varying shortlist after,
      // so shortlist churn breaks the prompt cache as late as possible.
      const section = `${selection.catalogSection}${shortlistSection}`;
      const systemPrompt = typeof rawEvent.systemPrompt === "string" ? rawEvent.systemPrompt : "";
      const result: BrewvaHostBeforeAgentStartResult = {
        message: formatSkillSelectionTraceMessage(selection.receipt, previousOpened),
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
