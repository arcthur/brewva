import { scoreDocumentsByTfIdf } from "@brewva/brewva-search";
import { sha256Hex } from "@brewva/brewva-std/hash";
import { compactWhitespace, truncateText } from "@brewva/brewva-std/text";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { estimateModelTokens } from "@brewva/brewva-token-estimation";
import {
  listSkillResourceRefs,
  SKILLCARD_PROJECTION_LIMITS,
  type SkillInvocationRecord,
  type SkillResourceRef,
} from "@brewva/brewva-vocabulary/session";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions, BrewvaToolRuntime } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { listRuntimeSkills } from "../../runtime-port/skills.js";
import { errTextResult, inconclusiveTextResult, okTextResult } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";

interface SkillSearchMetadata {
  name: string;
  category: string;
  description: string;
  whenToUse: string | null;
  filePath: string;
  resourceRefs: readonly SkillResourceRef[];
  argumentHints: readonly string[];
  requestedOutputArtifacts: readonly string[];
}

function renderSkillSearchText(metadata: SkillSearchMetadata): string {
  return [
    metadata.name,
    metadata.category,
    metadata.description,
    metadata.whenToUse,
    metadata.filePath,
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join("\n");
}

function renderBoundedText(value: string): string {
  return truncateText(compactWhitespace(value), SKILLCARD_PROJECTION_LIMITS.textFieldMaxChars, {
    marker: "...",
  });
}

function renderBoundedStringList(values: readonly string[]): string {
  const surfaced = values
    .slice(0, SKILLCARD_PROJECTION_LIMITS.listItemMaxCount)
    .map(compactWhitespace);
  const omitted = Math.max(0, values.length - surfaced.length);
  return omitted > 0 ? `${surfaced.join(",")} (+${omitted} omitted)` : surfaced.join(",");
}

function surfacedResourceRefs(
  metadata: Pick<SkillSearchMetadata, "resourceRefs">,
): SkillResourceRef[] {
  return metadata.resourceRefs.slice(0, SKILLCARD_PROJECTION_LIMITS.resourceRefMaxCount);
}

function renderResourceRefs(metadata: Pick<SkillSearchMetadata, "resourceRefs">): string {
  const refs = surfacedResourceRefs(metadata).map((ref) => `${ref.kind}:${ref.path}`);
  const omitted = Math.max(0, metadata.resourceRefs.length - refs.length);
  return omitted > 0 ? `${refs.join(",")} (+${omitted} omitted)` : refs.join(",");
}

function renderResult(input: {
  score: number;
  matchedTokens: readonly string[];
  metadata: SkillSearchMetadata;
}): string {
  return [
    `- score=${input.score}`,
    `name=${input.metadata.name}`,
    `category=${input.metadata.category}`,
    `filePath=${input.metadata.filePath}`,
    `matchedTokens=${input.matchedTokens.join(",") || "none"}`,
    `description=${JSON.stringify(renderBoundedText(input.metadata.description))}`,
    ...(input.metadata.whenToUse
      ? [`whenToUse=${JSON.stringify(renderBoundedText(input.metadata.whenToUse))}`]
      : []),
    ...(input.metadata.resourceRefs.length > 0
      ? [`resourceRefs=${renderResourceRefs(input.metadata)}`]
      : []),
    ...(input.metadata.argumentHints.length > 0
      ? [`argumentHints=${renderBoundedStringList(input.metadata.argumentHints)}`]
      : []),
    ...(input.metadata.requestedOutputArtifacts.length > 0
      ? [`outputArtifacts=${renderBoundedStringList(input.metadata.requestedOutputArtifacts)}`]
      : []),
  ].join(" | ");
}

function readSkillSearchMetadata(
  result: ReturnType<typeof scoreDocumentsByTfIdf<SkillSearchMetadata>>[number],
): SkillSearchMetadata {
  if (!result.document.metadata) {
    throw new Error("discover_skills search result is missing SkillCard metadata.");
  }
  return result.document.metadata;
}

type SkillSearchResult = ReturnType<typeof scoreDocumentsByTfIdf<SkillSearchMetadata>>[number];

function buildDiscoverySelectionId(input: {
  readonly query: string;
  readonly results: readonly SkillSearchResult[];
}): string {
  const digest = sha256Hex(
    [
      "discover_skills",
      input.query,
      ...input.results.map((entry) => {
        const metadata = readSkillSearchMetadata(entry);
        return `${metadata.category}:${metadata.name}:${entry.score}:${entry.matchedTokens.join(",")}`;
      }),
    ].join("\0"),
  ).slice(0, 16);
  return `skill_discovery_${digest}`;
}

function toDiscoveryInvocationRecord(input: {
  readonly selectionId: string;
  readonly result: SkillSearchResult;
}): SkillInvocationRecord {
  const metadata = readSkillSearchMetadata(input.result);
  const rendered = renderResult({
    score: input.result.score,
    matchedTokens: input.result.matchedTokens,
    metadata,
  });
  const tokenEstimate = estimateModelTokens(rendered);
  return {
    invocationId: `${input.selectionId}:${metadata.name}`,
    skillName: metadata.name,
    category: metadata.category,
    sourcePath: metadata.filePath,
    sourcePackage: null,
    selectionTrigger: "discover_only",
    invocationMode: "inspect_only",
    resourceRefs: surfacedResourceRefs(metadata),
    estimatedTokens: tokenEstimate.tokens,
    tokenEncoding: tokenEstimate.encoding,
    tokenEstimateMethod: tokenEstimate.method,
    tokenEstimateApproximation: tokenEstimate.approximation,
    capabilityRefs: [],
    requestedOutputArtifacts: metadata.requestedOutputArtifacts,
    argumentHints: metadata.argumentHints,
  };
}

function recordDiscoverySelection(input: {
  readonly sessionId: string;
  readonly query: string;
  readonly searchedSkillCount: number;
  readonly renderedText: string;
  readonly results: readonly SkillSearchResult[];
  readonly runtime: BrewvaToolRuntime;
}): void {
  const selectionId = buildDiscoverySelectionId({
    query: input.query,
    results: input.results,
  });
  const tokenEstimate = estimateModelTokens(input.renderedText);
  input.runtime.capabilities.skills.selection.record(input.sessionId, {
    selectionId,
    trigger: "discover_skills",
    explicitSkillMentions: [],
    availableSkillCount: input.searchedSkillCount,
    candidateSkillCount: input.results.length,
    renderedSkillCount: input.results.length,
    omittedSkillCount: Math.max(0, input.searchedSkillCount - input.results.length),
    selectionMode: "discover_only_projection",
    promptPaths: [],
    recentToolPaths: [],
    renderedSkillReasons: input.results.map((entry) => {
      const metadata = readSkillSearchMetadata(entry);
      const reasons = entry.matchedTokens.length > 0 ? ["text_match"] : [];
      return {
        name: metadata.name,
        category: metadata.category,
        reasons,
        reasonCount: reasons.length,
        score: entry.score,
        filePath: metadata.filePath,
      };
    }),
    skillInvocationRecords: input.results.map((result) =>
      toDiscoveryInvocationRecord({ selectionId, result }),
    ),
    renderedSkillContext: {
      charCount: input.renderedText.length,
      estimatedTokens: tokenEstimate.tokens,
      tokenEncoding: tokenEstimate.encoding,
      tokenEstimateMethod: tokenEstimate.method,
      tokenEstimateApproximation: tokenEstimate.approximation,
      maxRenderedSkillCount: input.results.length,
    },
  });
}

export function createDiscoverSkillsTool(options: BrewvaToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "discover_skills",
  );
  return define({
    name: "discover_skills",
    label: "Discover Skills",
    description:
      "Search the Brewva SkillCard catalog by name, description, and when-to-use guidance.",
    promptSnippet:
      "Use this when the available skill list is too large or ambiguous and you need a ranked SkillCard shortlist before reading skill files.",
    promptGuidelines: [
      "Use natural language from the current task as the query.",
      "Read a returned filePath before following that skill's full instructions.",
      "Search results are advisory and do not grant tool authority.",
    ],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 2_000 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const query = params.query.trim();
      if (!query) {
        return errTextResult("discover_skills requires a non-empty query.", {
          ok: false,
          error: "missing_query",
        });
      }

      const documents = listRuntimeSkills(runtime)
        .filter((skill) => skill.category !== "internal")
        .map((skill) => {
          const metadata: SkillSearchMetadata = {
            name: skill.name,
            category: skill.category,
            description: skill.description,
            whenToUse: skill.card.selection?.whenToUse ?? null,
            filePath: skill.filePath,
            resourceRefs: listSkillResourceRefs(skill),
            argumentHints: skill.card.argumentHints ?? [],
            requestedOutputArtifacts: skill.card.outputArtifacts ?? [],
          };
          return {
            id: skill.name,
            text: renderSkillSearchText(metadata),
            metadata,
          };
        });
      const results = scoreDocumentsByTfIdf(query, documents, {
        limit: params.limit ?? 10,
      });

      if (results.length === 0) {
        return inconclusiveTextResult(
          ["# Discover Skills", `query: ${JSON.stringify(query)}`, "results: none"].join("\n"),
          {
            ok: false,
            query,
            results: [],
            searchedSkillCount: documents.length,
          },
        );
      }

      const renderedText = [
        "# Discover Skills",
        `query: ${JSON.stringify(query)}`,
        `results: ${results.length}`,
        ...results.map((entry) =>
          renderResult({
            score: entry.score,
            matchedTokens: entry.matchedTokens,
            metadata: readSkillSearchMetadata(entry),
          }),
        ),
      ].join("\n");
      recordDiscoverySelection({
        sessionId: getSessionId(ctx),
        query,
        searchedSkillCount: documents.length,
        renderedText,
        results,
        runtime,
      });

      return okTextResult(renderedText, {
        ok: true,
        query,
        results: results.map((entry) => {
          const metadata = readSkillSearchMetadata(entry);
          return {
            name: metadata.name,
            category: metadata.category,
            description: metadata.description,
            whenToUse: metadata.whenToUse,
            filePath: metadata.filePath,
            resourceRefs: metadata.resourceRefs,
            argumentHints: metadata.argumentHints,
            requestedOutputArtifacts: metadata.requestedOutputArtifacts,
            score: entry.score,
            matchedTokens: entry.matchedTokens,
          };
        }),
        searchedSkillCount: documents.length,
      });
    },
  });
}
