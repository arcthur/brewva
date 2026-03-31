import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  executeKnowledgeSearch,
  hasKnowledgeSearchSignal,
  KNOWLEDGE_QUERY_INTENTS,
  KNOWLEDGE_SOURCE_TYPES,
  normalizeKnowledgeSourceTypes,
} from "./knowledge-search-core.js";
import { resolveToolTargetScope } from "./target-scope.js";
import type { BrewvaToolOptions } from "./types.js";
import { buildStringEnumSchema } from "./utils/input-alias.js";
import { failTextResult, inconclusiveTextResult, textResult } from "./utils/result.js";
import { defineBrewvaTool } from "./utils/tool.js";

const SOURCE_TYPE_SCHEMA = buildStringEnumSchema(KNOWLEDGE_SOURCE_TYPES, {});
const QUERY_INTENT_SCHEMA = buildStringEnumSchema(KNOWLEDGE_QUERY_INTENTS, {});

function readQueryIntent(value: unknown): (typeof KNOWLEDGE_QUERY_INTENTS)[number] | undefined {
  return typeof value === "string" &&
    KNOWLEDGE_QUERY_INTENTS.includes(value as (typeof KNOWLEDGE_QUERY_INTENTS)[number])
    ? (value as (typeof KNOWLEDGE_QUERY_INTENTS)[number])
    : undefined;
}

function renderResult(entry: ReturnType<typeof executeKnowledgeSearch>["results"][number]): string {
  const parts = [
    `- score=${entry.relevanceScore}`,
    `authority_rank=${entry.authorityRank}`,
    `source_type=${entry.doc.sourceType}`,
    `freshness=${entry.doc.freshness}`,
    `path=${entry.doc.relativePath}`,
    `title=${JSON.stringify(entry.doc.title)}`,
  ];
  if (entry.doc.status) {
    parts.push(`status=${entry.doc.status}`);
  }
  if (entry.doc.problemKind) {
    parts.push(`problem_kind=${entry.doc.problemKind}`);
  }
  if (entry.doc.module) {
    parts.push(`module=${entry.doc.module}`);
  }

  const lines = [parts.join(" | "), `  match_reasons=${entry.matchReasons.join(", ") || "none"}`];
  if (entry.doc.boundaries.length > 0) {
    lines.push(`  boundaries=${entry.doc.boundaries.join(", ")}`);
  }
  if (entry.doc.tags.length > 0) {
    lines.push(`  tags=${entry.doc.tags.join(", ")}`);
  }
  if (entry.doc.updatedAt) {
    lines.push(`  updated_at=${entry.doc.updatedAt}`);
  }
  lines.push(`  excerpt=${JSON.stringify(entry.doc.excerpt)}`);
  return lines.join("\n");
}

export function createKnowledgeSearchTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "knowledge_search",
    label: "Knowledge Search",
    description:
      "Search repository-native solution docs and adjacent documentation with source typing, authority ranking, and freshness signals.",
    promptSnippet:
      "Use this before non-trivial planning or review to retrieve repository precedents explicitly instead of relying on hidden memory.",
    promptGuidelines: [
      "Use query plus module, boundary, or tags when you already know the likely area.",
      "Treat source_type and authority_rank as decision context. Search results are precedents, not kernel truth.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
      query_intent: Type.Optional(QUERY_INTENT_SCHEMA),
      source_types: Type.Optional(Type.Array(SOURCE_TYPE_SCHEMA, { maxItems: 5 })),
      module: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      boundary: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      tags: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 10 }),
      ),
      problem_kind: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      status: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!hasKnowledgeSearchSignal(params)) {
        return failTextResult(
          "knowledge_search requires query or at least one filter (module, boundary, tags, problem_kind, or status).",
          {
            ok: false,
            error: "missing_search_signal",
          },
        );
      }

      const scope = resolveToolTargetScope(options.runtime, ctx);
      const search = executeKnowledgeSearch(scope.allowedRoots, {
        query: params.query,
        queryIntent: readQueryIntent(params.query_intent),
        sourceTypes: normalizeKnowledgeSourceTypes(params.source_types),
        module: params.module,
        boundary: params.boundary,
        tags: params.tags,
        problemKind: params.problem_kind,
        status: params.status,
        limit: params.limit,
      });

      if (search.results.length === 0) {
        return inconclusiveTextResult(
          [
            "# Knowledge Search",
            `query_summary: ${search.querySummary}`,
            `search_mode: ${search.searchPlan.mode}`,
            "results: none",
          ].join("\n"),
          {
            ok: false,
            querySummary: search.querySummary,
            results: [],
            searchedRoots: search.searchedRoots,
            searchPlan: search.searchPlan,
          },
        );
      }

      return textResult(
        [
          "# Knowledge Search",
          `query_summary: ${search.querySummary}`,
          `search_mode: ${search.searchPlan.mode}`,
          `results: ${search.results.length}`,
          ...search.results.map(renderResult),
        ].join("\n"),
        {
          ok: true,
          querySummary: search.querySummary,
          results: search.results.map((entry) => ({
            path: entry.doc.relativePath,
            sourceType: entry.doc.sourceType,
            authorityRank: entry.authorityRank,
            freshness: entry.doc.freshness,
            title: entry.doc.title,
            status: entry.doc.status ?? null,
            problemKind: entry.doc.problemKind ?? null,
            module: entry.doc.module ?? null,
            boundaries: entry.doc.boundaries,
            tags: entry.doc.tags,
            updatedAt: entry.doc.updatedAt ?? null,
            matchReasons: entry.matchReasons,
            relevanceScore: entry.relevanceScore,
            excerpt: entry.doc.excerpt,
          })),
          searchedRoots: search.searchedRoots,
          searchPlan: search.searchPlan,
        },
      );
    },
  });
}
