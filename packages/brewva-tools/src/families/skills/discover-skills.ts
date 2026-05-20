import { scoreDocumentsByTfIdf } from "@brewva/brewva-search";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { listRuntimeSkills } from "../../runtime-port/skills.js";
import { failTextResult, inconclusiveTextResult, textResult } from "../../utils/result.js";

interface SkillSearchMetadata {
  name: string;
  category: string;
  description: string;
  whenToUse: string | null;
  filePath: string;
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
    `description=${JSON.stringify(input.metadata.description)}`,
    ...(input.metadata.whenToUse ? [`whenToUse=${JSON.stringify(input.metadata.whenToUse)}`] : []),
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
    async execute(_toolCallId, params) {
      const query = params.query.trim();
      if (!query) {
        return failTextResult("discover_skills requires a non-empty query.", {
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

      return textResult(
        [
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
        ].join("\n"),
        {
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
              score: entry.score,
              matchedTokens: entry.matchedTokens,
            };
          }),
          searchedSkillCount: documents.length,
        },
      );
    },
  });
}
