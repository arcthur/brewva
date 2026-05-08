import { resolve } from "node:path";
import type { BrewvaEventRecord } from "@brewva/brewva-runtime/events";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolOptions } from "../../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../../registry/runtime-bound-tool.js";
import {
  recordToolRuntimeEvent,
  resolveToolRuntimeEventPort,
} from "../../../runtime-port/extensions.js";
import { inconclusiveTextResult, textResult } from "../../../utils/result.js";
import { getSessionId } from "../../../utils/session.js";
import { getPreparedArtifact } from "./artifact-cache.js";
import { extractArtifactCandidates } from "./artifact-candidates.js";
import {
  DEFAULT_ARTIFACT_EVENTS,
  DEFAULT_MAX_ARTIFACT_BYTES,
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_RESULTS_PER_QUERY,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_EVENTS,
  MAX_OUTPUT_CHARS,
  MAX_RESULTS_PER_QUERY,
  SEARCH_LAYERS,
  SEARCH_THROTTLE_EVENT_LOOKBACK,
  SEARCH_THROTTLE_REDUCE_AFTER,
  SEARCH_THROTTLE_WINDOW_MS,
} from "./constants.js";
import {
  clampOutput,
  normalizeOptionalQueryList,
  normalizePositiveInt,
  normalizeText,
} from "./params.js";
import { createQueryProfile, isConfidentFuzzyMatch, searchArtifact } from "./search-engine.js";
import { computeSearchThrottle } from "./throttle.js";
import type { ArtifactLoadStats, PreparedArtifact, QueryMatch, SearchLayer } from "./types.js";

export function createOutputSearchTool(options: BrewvaBundledToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "output_search");
  return define({
    name: "output_search",
    label: "Output Search",
    description:
      "Search persisted tool output artifacts for the current session and return compact snippets by query.",
    promptSnippet: "Search persisted tool-output artifacts before rerunning expensive commands.",
    promptGuidelines: [
      "Prefer this when prior command output, logs, or verification artifacts may already exist in the session.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ minLength: 1 })),
      queries: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
      tool: Type.Optional(Type.String({ minLength: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS_PER_QUERY })),
      artifacts_last: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_ARTIFACT_EVENTS })),
      max_artifact_bytes: Type.Optional(
        Type.Integer({ minimum: 1024, maximum: MAX_ARTIFACT_BYTES }),
      ),
      max_output_chars: Type.Optional(Type.Integer({ minimum: 400, maximum: MAX_OUTPUT_CHARS })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const eventPort = resolveToolRuntimeEventPort(runtime);
      const queryList = normalizeOptionalQueryList({
        query: params.query,
        queries: params.queries,
      });
      const limit = normalizePositiveInt(
        params.limit,
        DEFAULT_RESULTS_PER_QUERY,
        1,
        MAX_RESULTS_PER_QUERY,
      );
      const artifactsLast = normalizePositiveInt(
        params.artifacts_last,
        DEFAULT_ARTIFACT_EVENTS,
        1,
        MAX_ARTIFACT_EVENTS,
      );
      const maxArtifactBytes = normalizePositiveInt(
        params.max_artifact_bytes,
        DEFAULT_MAX_ARTIFACT_BYTES,
        1024,
        MAX_ARTIFACT_BYTES,
      );
      const maxOutputChars = normalizePositiveInt(
        params.max_output_chars,
        DEFAULT_MAX_OUTPUT_CHARS,
        400,
        MAX_OUTPUT_CHARS,
      );

      const roots = [
        normalizeText((ctx as { cwd?: unknown }).cwd),
        normalizeText(runtime.cwd),
      ].filter((value): value is string => Boolean(value));
      const uniqueRoots = [...new Set(roots.map((root) => resolve(root)))];
      const recordSearchEvent = (payload: Record<string, unknown>) => {
        recordToolRuntimeEvent(runtime, {
          sessionId,
          type: "tool_output_search",
          payload,
        });
      };
      if (!eventPort?.list) {
        return inconclusiveTextResult(
          "[OutputSearch]\nstatus: unavailable\nreason: runtime event inspection unavailable",
        );
      }
      const recentSearchEvents =
        queryList.length > 0
          ? (eventPort.list(sessionId, {
              type: "tool_output_search",
              last: SEARCH_THROTTLE_EVENT_LOOKBACK,
            }) as BrewvaEventRecord[])
          : [];
      const throttleState =
        queryList.length > 0
          ? computeSearchThrottle({
              events: recentSearchEvents,
              queryCount: queryList.length,
              requestedLimit: limit,
            })
          : {
              level: "normal" as const,
              effectiveLimit: limit,
              recentSingleQueryCalls: 0,
            };
      const effectiveLimit = Math.max(1, throttleState.effectiveLimit);

      const events = eventPort.list(sessionId, {
        type: "tool_output_artifact_persisted",
        last: Math.min(MAX_ARTIFACT_EVENTS * 4, Math.max(artifactsLast * 4, 60)),
      }) as BrewvaEventRecord[];
      const candidates = extractArtifactCandidates({
        events,
        roots: uniqueRoots,
        maxCandidates: artifactsLast,
        toolFilter: normalizeText(params.tool),
      });

      if (candidates.length === 0) {
        return textResult("[OutputSearch]\nNo artifact candidates found for current session.", {
          sessionId,
          artifactsScanned: 0,
          queries: queryList,
        });
      }

      if (queryList.length > 0 && throttleState.level === "blocked") {
        const blockedText = [
          "[OutputSearch]",
          "Blocked due to high-frequency single-query search calls.",
          `Window: ${Math.round(SEARCH_THROTTLE_WINDOW_MS / 1000)}s`,
          `Recent single-query calls: ${throttleState.recentSingleQueryCalls + 1}`,
          `Artifacts considered: ${candidates.length}`,
          "Use queries=[...] to batch related questions in one call.",
        ].join("\n");

        recordSearchEvent({
          queryCount: queryList.length,
          artifactsConsidered: candidates.length,
          artifactsLoaded: 0,
          cacheHits: 0,
          cacheMisses: 0,
          localCacheHits: 0,
          globalCacheHits: 0,
          skippedLarge: 0,
          readFailures: 0,
          resultCount: 0,
          toolFilter: normalizeText(params.tool) ?? null,
          requestedLimit: limit,
          effectiveLimit: 0,
          throttleLevel: throttleState.level,
          throttleWindowMs: SEARCH_THROTTLE_WINDOW_MS,
          recentSingleQueryCalls: throttleState.recentSingleQueryCalls,
          blocked: true,
        });

        return inconclusiveTextResult(clampOutput(blockedText, maxOutputChars), {
          sessionId,
          queryCount: queryList.length,
          artifactsConsidered: candidates.length,
          throttleLevel: throttleState.level,
          recentSingleQueryCalls: throttleState.recentSingleQueryCalls,
          blocked: true,
        });
      }

      if (queryList.length === 0) {
        const lines = ["[OutputSearch]", "Mode: inventory", `Artifacts: ${candidates.length}`];
        for (const [index, candidate] of candidates.slice(0, 24).entries()) {
          const size = candidate.rawBytes !== null ? `${candidate.rawBytes}B` : "unknown";
          lines.push(
            `${index + 1}. tool=${candidate.toolName} bytes=${size} ref=${candidate.artifactRef}`,
          );
        }
        if (candidates.length > 24) {
          lines.push(`... (${candidates.length - 24} more artifacts omitted)`);
        }
        return textResult(clampOutput(lines.join("\n"), maxOutputChars), {
          sessionId,
          mode: "inventory",
          artifactsScanned: candidates.length,
        });
      }

      const contentCache = new Map<string, PreparedArtifact>();
      const cacheScope = resolve(runtime.workspaceRoot ?? runtime.cwd ?? ".");
      const skippedLargePaths = new Set<string>();
      const readFailurePaths = new Set<string>();
      const loadStats: ArtifactLoadStats = {
        cacheHits: 0,
        cacheMisses: 0,
        localCacheHits: 0,
        globalCacheHits: 0,
      };
      const querySections: string[] = [];
      const matchCounts: Record<string, number> = {};
      const matchLayers: Record<string, SearchLayer | "none"> = {};

      for (const query of queryList) {
        const lines: string[] = [`## ${query}`];
        const queryProfile = createQueryProfile(query);
        if (!queryProfile) {
          lines.push("No valid query tokens found.");
          querySections.push(lines.join("\n"));
          matchCounts[query] = 0;
          matchLayers[query] = "none";
          continue;
        }

        let matches: QueryMatch[] = [];
        let matchedLayer: SearchLayer | "none" = "none";
        const layeredMatchesByLayer: Record<SearchLayer, QueryMatch[]> = {
          exact: [],
          partial: [],
          fuzzy: [],
        };

        for (const candidate of candidates) {
          const prepared = getPreparedArtifact({
            cacheScope,
            absolutePath: candidate.absolutePath,
            maxArtifactBytes,
            localCache: contentCache,
            skippedLargePaths,
            readFailurePaths,
            stats: loadStats,
          });
          if (!prepared) continue;

          const searched = searchArtifact({
            prepared,
            queryProfile,
            snippetMaxChars: 1_500,
          });
          for (const layer of SEARCH_LAYERS) {
            const layerMatch = searched[layer];
            if (!layerMatch) continue;

            layeredMatchesByLayer[layer].push({
              artifactRef: candidate.artifactRef,
              toolName: candidate.toolName,
              score: layerMatch.score,
              timestamp: candidate.timestamp,
              snippet: layerMatch.snippet,
              matchedLineCount: layerMatch.matchedLineCount,
              layer,
              fuzzyTokenCoverage: layerMatch.fuzzyTokenCoverage,
              bestFuseScore: layerMatch.bestFuseScore,
              bestFuzzyTokenScore: layerMatch.bestFuzzyTokenScore,
            });
          }
        }

        for (const layer of SEARCH_LAYERS) {
          const layeredMatches = layeredMatchesByLayer[layer];
          if (layer === "fuzzy") {
            const confidentFuzzyMatches = layeredMatches.filter((match) =>
              isConfidentFuzzyMatch(match),
            );
            if (confidentFuzzyMatches.length > 0) {
              matches = confidentFuzzyMatches;
              matchedLayer = layer;
              break;
            }
            continue;
          }

          if (layeredMatches.length > 0) {
            matches = layeredMatches;
            matchedLayer = layer;
            break;
          }
        }

        const topMatches = matches
          .toSorted((left, right) => right.score - left.score || right.timestamp - left.timestamp)
          .slice(0, effectiveLimit);
        matchCounts[query] = topMatches.length;
        matchLayers[query] = matchedLayer;

        if (matchedLayer !== "none") {
          lines.push(`Match layer: ${matchedLayer}`);
        }
        if (topMatches.length === 0) {
          lines.push("No matches found across exact/partial/fuzzy layers.");
          querySections.push(lines.join("\n"));
          continue;
        }

        for (const [index, match] of topMatches.entries()) {
          lines.push(
            `${index + 1}. tool=${match.toolName} layer=${match.layer} score=${match.score.toFixed(2)} lines=${match.matchedLineCount}`,
          );
          lines.push(`   ref=${match.artifactRef}`);
          lines.push(match.snippet);
        }
        querySections.push(lines.join("\n"));
      }

      const loadedArtifacts = contentCache.size;
      const skippedLarge = skippedLargePaths.size;
      const readFailures = readFailurePaths.size;

      const summary = [
        "[OutputSearch]",
        `Session: ${sessionId}`,
        `Queries: ${queryList.length}`,
        `Artifacts considered: ${candidates.length}`,
        `Artifacts loaded: ${loadedArtifacts}`,
        `Cache hits/misses: ${loadStats.cacheHits}/${loadStats.cacheMisses} (local/global: ${loadStats.localCacheHits}/${loadStats.globalCacheHits})`,
        `Skipped large: ${skippedLarge}`,
        `Read failures: ${readFailures}`,
        `Throttle: ${throttleState.level}`,
        `Result limit: ${effectiveLimit}/${limit}`,
        "",
        ...querySections,
      ].join("\n");
      const throttleWarning =
        throttleState.level === "limited"
          ? `\n\n[Throttle] single-query calls in ${Math.round(SEARCH_THROTTLE_WINDOW_MS / 1000)}s window exceeded ${SEARCH_THROTTLE_REDUCE_AFTER}; results limited to ${effectiveLimit}/query. Use queries=[...] to batch.`
          : "";

      recordSearchEvent({
        queryCount: queryList.length,
        artifactsConsidered: candidates.length,
        artifactsLoaded: loadedArtifacts,
        cacheHits: loadStats.cacheHits,
        cacheMisses: loadStats.cacheMisses,
        localCacheHits: loadStats.localCacheHits,
        globalCacheHits: loadStats.globalCacheHits,
        skippedLarge,
        readFailures,
        resultCount: Object.values(matchCounts).reduce((sum, count) => sum + count, 0),
        toolFilter: normalizeText(params.tool) ?? null,
        requestedLimit: limit,
        effectiveLimit,
        throttleLevel: throttleState.level,
        throttleWindowMs: SEARCH_THROTTLE_WINDOW_MS,
        recentSingleQueryCalls: throttleState.recentSingleQueryCalls,
        blocked: false,
        matchLayers,
      });

      return textResult(clampOutput(`${summary}${throttleWarning}`, maxOutputChars), {
        sessionId,
        queryCount: queryList.length,
        artifactsConsidered: candidates.length,
        artifactsLoaded: loadedArtifacts,
        cacheHits: loadStats.cacheHits,
        cacheMisses: loadStats.cacheMisses,
        localCacheHits: loadStats.localCacheHits,
        globalCacheHits: loadStats.globalCacheHits,
        skippedLarge,
        readFailures,
        requestedLimit: limit,
        effectiveLimit,
        throttleLevel: throttleState.level,
        recentSingleQueryCalls: throttleState.recentSingleQueryCalls,
        matchCounts,
        matchLayers,
      });
    },
  });
}
