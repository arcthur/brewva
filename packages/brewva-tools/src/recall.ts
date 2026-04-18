import {
  getOrCreateRecallBroker,
  RECALL_CURATION_HALFLIFE_DAYS,
  RECALL_CURATION_SIGNAL_VALUES,
  RECALL_SCOPE_VALUES,
  type RecallCurationSignal,
  type RecallScope,
  type RecallSearchEntry,
} from "@brewva/brewva-recall";
import {
  RECALL_CURATION_RECORDED_EVENT_TYPE,
  RECALL_RESULTS_SURFACED_EVENT_TYPE,
} from "@brewva/brewva-runtime";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate";
import { Type } from "@sinclair/typebox";
import { recordToolRuntimeEvent } from "./runtime-internal.js";
import { resolveToolTargetScope } from "./target-scope.js";
import type { BrewvaToolOptions } from "./types.js";
import { buildStringEnumSchema } from "./utils/input-alias.js";
import { failTextResult, textResult } from "./utils/result.js";
import { createRuntimeBoundBrewvaToolFactory } from "./utils/runtime-bound-tool.js";
import { getSessionId } from "./utils/session.js";

const RECALL_SCOPE_SCHEMA = buildStringEnumSchema(RECALL_SCOPE_VALUES, {
  recommendedValue: "user_repository_root",
  guidance:
    "Use user_repository_root by default. Use session_local for current-session forensics and workspace_wide only when the broader workspace scope is explicitly required.",
});

const RECALL_CURATION_SIGNAL_SCHEMA = buildStringEnumSchema(RECALL_CURATION_SIGNAL_VALUES, {
  guidance:
    "Use helpful for useful recall, stale or superseded for outdated recall, and wrong_scope or misleading when the result should be de-ranked in future retrieval.",
});

function normalizeQuery(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeStableIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .map((entry) => normalizeQuery(entry))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  ];
}

function normalizeScope(value: unknown): RecallScope | undefined {
  return typeof value === "string" && RECALL_SCOPE_VALUES.includes(value as RecallScope)
    ? (value as RecallScope)
    : undefined;
}

function hasRecallOperatorProfile(runtime: BrewvaToolOptions["runtime"]): boolean {
  const scopes = runtime.inspect.skills.getLoadReport().routingScopes;
  return scopes.includes("operator") || scopes.includes("meta");
}

function renderRecallEntry(entry: RecallSearchEntry): string {
  const header = [
    `- score=${entry.score.toFixed(3)}`,
    `source_family=${entry.sourceFamily}`,
    `scope=${entry.scope}`,
    `freshness=${entry.freshness}`,
    `stable_id=${entry.stableId}`,
  ];
  if (entry.sessionId) {
    header.push(`session_id=${entry.sessionId}`);
  }
  if (entry.relativePath) {
    header.push(`path=${entry.relativePath}`);
  }

  const lines = [header.join(" | "), `  title=${JSON.stringify(entry.title)}`];
  if (entry.matchReasons.length > 0) {
    lines.push(`  match_reasons=${entry.matchReasons.join(", ")}`);
  }
  lines.push(`  summary=${JSON.stringify(entry.summary)}`);
  if (entry.excerpt.length > 0) {
    lines.push(`  excerpt=${JSON.stringify(entry.excerpt)}`);
  }
  if (entry.targetRoots && entry.targetRoots.length > 0) {
    lines.push(`  target_roots=${entry.targetRoots.join(", ")}`);
  }
  if (entry.curation) {
    lines.push(
      `  curation_adjustment=${entry.curation.scoreAdjustment.toFixed(3)} | last_signal_at=${
        entry.curation.lastSignalAt ?? "none"
      }`,
    );
    lines.push(
      `  curation_weights=helpful:${entry.curation.helpfulWeight.toFixed(2)}, stale:${entry.curation.staleWeight.toFixed(2)}, superseded:${entry.curation.supersededWeight.toFixed(2)}, wrong_scope:${entry.curation.wrongScopeWeight.toFixed(2)}, misleading:${entry.curation.misleadingWeight.toFixed(2)}`,
    );
  }
  return lines.join("\n");
}

export function createRecallSearchTool(options: BrewvaToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "recall_search");
  return define({
    name: "recall_search",
    label: "Recall Search",
    description:
      "Search cross-session recall across tape evidence, typed memory products, promotion drafts, and repository precedents.",
    promptSnippet:
      "Use this as the default prior-work recall surface before replaying from scratch. It returns typed provenance, freshness, scope, and source-family signals.",
    promptGuidelines: [
      "Use session_local only for current-session tape forensics; prefer user_repository_root for normal prior-work recall.",
      "Treat repository_precedent and typed memory results as advisory recall, not authority. Follow the cited source family.",
      "Use stable_ids to inspect already-surfaced recall items and their curation state without widening to a different tool.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
      stable_ids: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
          minItems: 1,
          maxItems: 20,
        }),
      ),
      scope: Type.Optional(RECALL_SCOPE_SCHEMA),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const query = normalizeQuery(params.query);
      const stableIds = normalizeStableIds(params.stable_ids);
      if (!query && stableIds.length === 0) {
        return failTextResult("recall_search rejected (missing_query_or_stable_ids).", {
          ok: false,
          error: "missing_query_or_stable_ids",
        });
      }
      if (query && stableIds.length > 0) {
        return failTextResult("recall_search rejected (query_and_stable_ids_conflict).", {
          ok: false,
          error: "query_and_stable_ids_conflict",
        });
      }

      const scope = resolveToolTargetScope(runtime, ctx);
      if (query) {
        const search = getOrCreateRecallBroker(runtime).search({
          sessionId,
          query,
          scope: normalizeScope(params.scope),
          limit: params.limit,
        });

        if (search.results.length > 0) {
          recordToolRuntimeEvent(runtime, {
            sessionId,
            type: RECALL_RESULTS_SURFACED_EVENT_TYPE,
            payload: {
              source: "recall_search",
              scope: search.scope,
              stableIds: search.results.map((entry) => entry.stableId),
              allowedRoots: scope.allowedRoots,
            },
          });
        }

        return textResult(
          [
            "[RecallSearch]",
            "mode: search",
            `query: ${query}`,
            `scope: ${search.scope}`,
            `allowed_roots: ${scope.allowedRoots.join(", ")}`,
            `curation_half_life_days: ${RECALL_CURATION_HALFLIFE_DAYS}`,
            `results: ${search.results.length}`,
            ...search.results.map(renderRecallEntry),
          ].join("\n"),
          {
            ok: true,
            mode: "search",
            query,
            scope: search.scope,
            allowedRoots: scope.allowedRoots,
            curationHalfLifeDays: RECALL_CURATION_HALFLIFE_DAYS,
            results: search.results.map((entry) => ({
              stableId: entry.stableId,
              sourceFamily: entry.sourceFamily,
              scope: entry.scope,
              freshness: entry.freshness,
              title: entry.title,
              summary: entry.summary,
              excerpt: entry.excerpt,
              score: entry.score,
              sessionId: entry.sessionId ?? null,
              relativePath: entry.relativePath ?? null,
              targetRoots: entry.targetRoots ?? [],
              matchReasons: entry.matchReasons,
              curation: entry.curation ?? null,
            })),
          },
        );
      }

      const inspection = getOrCreateRecallBroker(runtime).inspectStableIds({
        sessionId,
        stableIds,
        scope: normalizeScope(params.scope),
      });
      if (inspection.results.length > 0) {
        recordToolRuntimeEvent(runtime, {
          sessionId,
          type: RECALL_RESULTS_SURFACED_EVENT_TYPE,
          payload: {
            source: "recall_search",
            scope: inspection.scope,
            stableIds: inspection.results.map((entry) => entry.stableId),
            allowedRoots: scope.allowedRoots,
          },
        });
      }

      return textResult(
        [
          "[RecallSearch]",
          "mode: inspect",
          `scope: ${inspection.scope}`,
          `allowed_roots: ${scope.allowedRoots.join(", ")}`,
          `requested_stable_ids: ${inspection.requestedStableIds.join(", ")}`,
          `unresolved_stable_ids: ${
            inspection.unresolvedStableIds.length > 0
              ? inspection.unresolvedStableIds.join(", ")
              : "none"
          }`,
          `curation_half_life_days: ${RECALL_CURATION_HALFLIFE_DAYS}`,
          `results: ${inspection.results.length}`,
          ...inspection.results.map(renderRecallEntry),
        ].join("\n"),
        {
          ok: true,
          mode: "inspect",
          scope: inspection.scope,
          allowedRoots: scope.allowedRoots,
          requestedStableIds: inspection.requestedStableIds,
          unresolvedStableIds: inspection.unresolvedStableIds,
          curationHalfLifeDays: RECALL_CURATION_HALFLIFE_DAYS,
          results: inspection.results.map((entry) => ({
            stableId: entry.stableId,
            sourceFamily: entry.sourceFamily,
            scope: entry.scope,
            freshness: entry.freshness,
            title: entry.title,
            summary: entry.summary,
            excerpt: entry.excerpt,
            score: entry.score,
            sessionId: entry.sessionId ?? null,
            relativePath: entry.relativePath ?? null,
            targetRoots: entry.targetRoots ?? [],
            matchReasons: entry.matchReasons,
            curation: entry.curation ?? null,
          })),
        },
      );
    },
  });
}

export function createRecallCurateTool(options: BrewvaToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "recall_curate");
  return define({
    name: "recall_curate",
    label: "Recall Curate",
    description:
      "Record explicit operator feedback for surfaced recall items without mutating truth or typed materialization directly.",
    parameters: Type.Object({
      stable_ids: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
        minItems: 1,
        maxItems: 20,
      }),
      signal: RECALL_CURATION_SIGNAL_SCHEMA,
      note: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      if (!hasRecallOperatorProfile(runtime)) {
        return failTextResult("recall_curate rejected (operator_profile_required).", {
          ok: false,
          error: "operator_profile_required",
        });
      }
      const stableIds = normalizeStableIds(params.stable_ids);
      if (stableIds.length === 0) {
        return failTextResult("recall_curate rejected (missing_stable_ids).", {
          ok: false,
          error: "missing_stable_ids",
        });
      }

      const signal = params.signal as RecallCurationSignal;
      recordToolRuntimeEvent(runtime, {
        sessionId,
        type: RECALL_CURATION_RECORDED_EVENT_TYPE,
        payload: {
          source: "recall_curate",
          signal,
          stableIds,
          note: normalizeQuery(params.note),
        },
      });

      return textResult(
        [
          "[RecallCurate]",
          `signal: ${signal}`,
          `stable_ids: ${stableIds.join(", ")}`,
          `recorded: ${stableIds.length}`,
          params.note ? `note: ${params.note.trim()}` : null,
        ]
          .filter((line): line is string => typeof line === "string" && line.length > 0)
          .join("\n"),
        {
          ok: true,
          signal,
          stableIds,
          note: normalizeQuery(params.note) ?? null,
        },
      );
    },
  });
}
