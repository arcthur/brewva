import { basename } from "node:path";
import type { LoadableSkillCategory, SkillDocument } from "@brewva/brewva-runtime/protocol";
import { sha256Hex } from "@brewva/brewva-std/hash";
import type {
  BrewvaHostBeforeAgentStartResult,
  BrewvaHostCustomMessage,
} from "@brewva/brewva-substrate/host-api";
import { estimateModelTokens } from "@brewva/brewva-token-estimation";
import { recordRuntimeSkillSelection } from "../runtime-ports.js";

const DEFAULT_SKILL_CATALOG_TOKEN_BUDGET = 2_000;
const HIDDEN_CATEGORIES = new Set<LoadableSkillCategory>(["internal"]);

export type SkillSelectionTrigger = "user_message";
export type SkillSelectionMode = "available_catalog_prompt_context";

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
  filePath: string;
}

export interface ExplicitSkillMention {
  name: string;
  category: LoadableSkillCategory;
  reason: "explicit_mention";
  filePath: string;
}

export interface SkillSelectionReceipt {
  selectionId: string;
  trigger: SkillSelectionTrigger;
  explicitSkillMentions: ExplicitSkillMention[];
  availableSkillCount: number;
  renderedSkillContext: {
    charCount: number;
    estimatedTokens: number;
    tokenEncoding: string;
    tokenEstimateMethod: string;
    tokenEstimateApproximation: boolean;
    tokenBudget: number;
    truncated: boolean;
    detailCharLimit: number;
  };
  mode: SkillSelectionMode;
}

export interface SkillSelectionResult {
  receipt: SkillSelectionReceipt;
  availableSkills: AvailableSkillPromptContext[];
  renderedSection: string;
}

export interface SkillSelectionLifecycle {
  beforeAgentStart: (event: unknown, ctx: unknown) => BrewvaHostBeforeAgentStartResult | undefined;
}

interface RenderedSkillCatalog {
  section: string;
  truncated: boolean;
  detailCharLimit: number;
  tokenEstimate: ReturnType<typeof estimateModelTokens>;
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

function hasExplicitMention(prompt: string, skillName: string): boolean {
  const escapedName = escapeRegExp(skillName);
  return new RegExp(`(?:^|[^A-Za-z0-9_-])\\$${escapedName}(?=$|[^A-Za-z0-9_-])`, "iu").test(prompt);
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
    filePath: skill.filePath,
  };
}

function truncateDetail(value: string, charLimit: number): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length <= charLimit) {
    return normalized;
  }
  if (charLimit <= 0) {
    return "[truncated]";
  }
  const clipped = normalized.slice(0, charLimit).trimEnd();
  return `${clipped}... [truncated]`;
}

function renderSkillEntry(skill: AvailableSkillPromptContext, detailCharLimit: number): string {
  const lines = [
    `## ${skill.name}`,
    `category: ${skill.category}`,
    `filePath: ${skill.filePath}`,
    `description: ${truncateDetail(skill.description, detailCharLimit)}`,
  ];
  if (skill.whenToUse) {
    lines.push(`whenToUse: ${truncateDetail(skill.whenToUse, detailCharLimit)}`);
  }
  return lines.join("\n");
}

function renderSkillCatalogWithLimit(
  skills: readonly AvailableSkillPromptContext[],
  detailCharLimit: number,
): string {
  if (skills.length === 0) {
    return "";
  }
  return [
    "",
    "",
    "# Available Brewva Skills",
    "",
    "These SkillCards are advisory prompt context. They do not grant tools, permissions, accounts, budgets, side effects, or runtime authority.",
    "If the user mentions $skill-name OR the task matches the description above, follow that SkillCard for this turn. When you decide to use a skill, read its filePath first and follow only that SkillCard's instructions.",
    "",
    ...skills.map((skill) => renderSkillEntry(skill, detailCharLimit)),
  ].join("\n");
}

function estimateSkillCatalogSection(
  skills: readonly AvailableSkillPromptContext[],
  detailCharLimit: number,
): RenderedSkillCatalog {
  const section = renderSkillCatalogWithLimit(skills, detailCharLimit);
  const tokenEstimate = estimateModelTokens(section);
  return {
    section,
    tokenEstimate,
    truncated: skills.some(
      (skill) =>
        skill.description.trim().replace(/\s+/gu, " ").length > detailCharLimit ||
        (skill.whenToUse?.trim().replace(/\s+/gu, " ").length ?? 0) > detailCharLimit,
    ),
    detailCharLimit,
  };
}

function resolveMaxDetailCharLimit(skills: readonly AvailableSkillPromptContext[]): number {
  return Math.max(
    0,
    ...skills.flatMap((skill) => [
      skill.description.trim().replace(/\s+/gu, " ").length,
      skill.whenToUse?.trim().replace(/\s+/gu, " ").length ?? 0,
    ]),
  );
}

function renderBoundedSkillCatalog(input: {
  skills: readonly AvailableSkillPromptContext[];
  tokenBudget: number;
}): RenderedSkillCatalog {
  const maxDetailCharLimit = resolveMaxDetailCharLimit(input.skills);
  const full = estimateSkillCatalogSection(input.skills, maxDetailCharLimit);
  if (full.tokenEstimate.tokens <= input.tokenBudget) {
    return full;
  }

  let low = 0;
  let high = maxDetailCharLimit;
  let best = estimateSkillCatalogSection(input.skills, 0);
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = estimateSkillCatalogSection(input.skills, mid);
    if (candidate.tokenEstimate.tokens <= input.tokenBudget) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return {
    ...best,
    truncated: true,
  };
}

function makeSelectionId(input: {
  trigger: SkillSelectionTrigger;
  prompt: string;
  explicitNames: readonly string[];
  availableSkillNames: readonly string[];
}): string {
  const digest = sha256Hex(
    [
      input.trigger,
      input.prompt,
      input.explicitNames.join("\0"),
      input.availableSkillNames.join("\0"),
    ].join("\0"),
  ).slice(0, 16);
  return `skill_selection_${digest}`;
}

function buildReceipt(input: {
  trigger: SkillSelectionTrigger;
  prompt: string;
  explicitSkillMentions: readonly ExplicitSkillMention[];
  availableSkillNames: readonly string[];
  renderedSkillCatalog: RenderedSkillCatalog;
  tokenBudget: number;
}): SkillSelectionReceipt {
  return {
    selectionId: makeSelectionId({
      trigger: input.trigger,
      prompt: input.prompt,
      explicitNames: input.explicitSkillMentions.map((skill) => skill.name),
      availableSkillNames: input.availableSkillNames,
    }),
    trigger: input.trigger,
    explicitSkillMentions: input.explicitSkillMentions.map((skill) => ({ ...skill })),
    availableSkillCount: input.availableSkillNames.length,
    renderedSkillContext: {
      charCount: input.renderedSkillCatalog.section.length,
      estimatedTokens: input.renderedSkillCatalog.tokenEstimate.tokens,
      tokenEncoding: input.renderedSkillCatalog.tokenEstimate.encoding,
      tokenEstimateMethod: input.renderedSkillCatalog.tokenEstimate.method,
      tokenEstimateApproximation: input.renderedSkillCatalog.tokenEstimate.approximation,
      tokenBudget: input.tokenBudget,
      truncated: input.renderedSkillCatalog.truncated,
      detailCharLimit: input.renderedSkillCatalog.detailCharLimit,
    },
    mode: "available_catalog_prompt_context",
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
    receipt.mode === "available_catalog_prompt_context"
    ? (receipt as SkillSelectionReceipt)
    : undefined;
}

export function buildSkillCatalogContextForPrompt(input: {
  runtime: Pick<SkillSelectionRuntime, "ops">;
  prompt: string;
  tokenBudget?: number;
}): SkillSelectionResult {
  const trigger: SkillSelectionTrigger = "user_message";
  const skills = listPromptVisibleSkills(listSkillCatalog(input.runtime));
  const availableSkills = skills.map(toPromptContext);
  const explicitSkillMentions = skills
    .filter((skill) => hasExplicitMention(input.prompt, skill.name))
    .map(
      (skill): ExplicitSkillMention => ({
        name: skill.name,
        category: skill.category,
        reason: "explicit_mention",
        filePath: skill.filePath,
      }),
    );
  const tokenBudget = input.tokenBudget ?? DEFAULT_SKILL_CATALOG_TOKEN_BUDGET;
  const renderedSkillCatalog = renderBoundedSkillCatalog({
    skills: availableSkills,
    tokenBudget,
  });
  const receipt = buildReceipt({
    trigger,
    prompt: input.prompt,
    explicitSkillMentions,
    availableSkillNames: availableSkills.map((skill) => skill.name),
    renderedSkillCatalog,
    tokenBudget,
  });
  return {
    receipt,
    availableSkills,
    renderedSection: renderedSkillCatalog.section,
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
      `Available Brewva Skills: ${receipt.availableSkillCount}`,
      `Explicit Brewva Skill Mentions: ${
        explicitSkillMentionNames.length > 0 ? explicitSkillMentionNames.join(", ") : "none"
      }`,
      `Selection ID: ${receipt.selectionId}`,
      `Mode: ${receipt.mode}`,
    ].join("\n"),
    display: false,
    excludeFromContext: true,
    details: {
      selectionId: receipt.selectionId,
      explicitSkillMentionNames,
      explicitSkillMentions: receipt.explicitSkillMentions,
      availableSkillCount: receipt.availableSkillCount,
      renderedSkillContext: receipt.renderedSkillContext,
      mode: receipt.mode,
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
      const selection = buildSkillCatalogContextForPrompt({ runtime, prompt });
      recordRuntimeSkillSelection(runtime, sessionId, selection.receipt);
      const section = formatSkillSelectionSection(selection);
      if (!section) {
        return undefined;
      }
      const systemPrompt = typeof rawEvent.systemPrompt === "string" ? rawEvent.systemPrompt : "";
      return {
        message: formatSkillSelectionTraceMessage(selection.receipt),
        systemPrompt: `${systemPrompt}${section}`,
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
    skillSelectionMode: receipt?.mode ?? null,
  };
}

export function describeAvailableSkillForDisplay(skill: AvailableSkillPromptContext): string {
  return `${skill.name} (${skill.category}, ${basename(skill.filePath)})`;
}
