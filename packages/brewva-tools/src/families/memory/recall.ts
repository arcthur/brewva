import {
  RECALL_CURATION_HALFLIFE_DAYS,
  RECALL_CURATION_SIGNAL_VALUES,
  RECALL_SCOPE_VALUES,
  RECALL_SEARCH_INTENT_VALUES,
  projectRecallResultProvenance,
  type RecallCurationSignal,
  type RecallScope,
  type RecallSearchIntent,
  type RecallSearchEntry,
} from "@brewva/brewva-recall";
import {
  getOrCreateRecallBroker,
  isRecallSessionIndexUnavailable,
} from "@brewva/brewva-recall/broker";
import { resolveRcrReference } from "@brewva/brewva-recall/evidence";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import {
  RECALL_CURATION_RECORDED_EVENT_TYPE,
  RECALL_RESULTS_SURFACED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/iteration";
import {
  parseRcrReference,
  type RcrReference,
  type RcrResolutionOutcome,
} from "@brewva/brewva-vocabulary/rcr";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { buildStringEnumSchema } from "../../registry/string-enum-contract.js";
import { recordToolRuntimeEvent } from "../../runtime-port/extensions.js";
import { createRecordsRcrTapeEventSource } from "../../runtime-port/rcr.js";
import { resolveRecallBrokerRuntime } from "../../runtime-port/recall.js";
import { resolveToolTargetScope } from "../../runtime-port/target-scope.js";
import { errTextResult, okTextResult } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";

const RECALL_SCOPE_SCHEMA = buildStringEnumSchema(RECALL_SCOPE_VALUES, {
  recommendedValue: "user_repository_root",
  guidance:
    "Use user_repository_root by default. Use session_local for current-session forensics and workspace_wide only when the broader workspace scope is explicitly required.",
});

const RECALL_CURATION_SIGNAL_SCHEMA = buildStringEnumSchema(RECALL_CURATION_SIGNAL_VALUES, {
  guidance:
    "Use helpful for useful recall, stale or superseded for outdated recall, and wrong_scope or misleading when the result should be de-ranked in future retrieval.",
});

const RECALL_SEARCH_INTENT_SCHEMA = buildStringEnumSchema(RECALL_SEARCH_INTENT_VALUES, {
  recommendedValue: "prior_work",
  guidance:
    "Use prior_work as the neutral default. Use repository_precedent for repository practice, current_session_evidence for current-session tape evidence, and durable_runtime_receipts for completed or verified runtime receipts. Use output_search for raw recent tool output.",
});

function sessionIndexUnavailableResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return errTextResult(`recall_search unavailable (session_index_unavailable): ${message}`, {
    ok: false,
    error: "session_index_unavailable",
    message,
  });
}

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

function normalizeIntent(value: unknown): RecallSearchIntent | undefined {
  return typeof value === "string" &&
    RECALL_SEARCH_INTENT_VALUES.includes(value as RecallSearchIntent)
    ? (value as RecallSearchIntent)
    : undefined;
}

function renderRecallEntry(entry: RecallSearchEntry): string {
  const header = [
    `- ranking_score=${entry.rankingScore.toFixed(3)}`,
    `semantic_score=${entry.semanticScore.toFixed(3)}`,
    `source_family=${entry.sourceFamily}`,
    `session_scope=${entry.sessionScope}`,
    `root_ref=${entry.rootRef}`,
    `trust_label=${entry.trustLabel}`,
    `evidence_strength=${entry.evidenceStrength}`,
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
  if (entry.rankReasons.length > 0) {
    lines.push(`  rank_reasons=${entry.rankReasons.join(", ")}`);
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
  // Create + subscribe the broker eagerly at tool-construction time, not lazily on
  // the first recall_search. The broker subscribes to turn.ended only in its
  // constructor, so a lazily-created broker would miss every turn boundary before
  // the first pull — the session's first recall_search would still pay the cold
  // sync() with no prior turn able to warm it. getOrCreateRecallBroker is
  // idempotent (per-runtime WeakMap); execute() below reuses this same instance.
  if (runtime) {
    try {
      getOrCreateRecallBroker(resolveRecallBrokerRuntime(runtime));
    } catch {
      // Best-effort: a not-yet-ready/minimal runtime falls back to the lazy create
      // on first recall_search — no worse than before this warm-wiring seam.
    }
  }
  return define({
    name: "recall_search",
    label: "Recall Search",
    description: "Search on-demand recall across tape evidence and repository precedents.",
    promptSnippet:
      "Use this as the default prior-work recall surface before replaying from scratch. It returns typed provenance, freshness, scope, and source-family signals.",
    promptGuidelines: [
      "Use session_local only for current-session tape forensics; prefer user_repository_root for normal prior-work recall.",
      "Treat prior_work as the neutral default intent; it does not add a ranking boost beyond the normal source, strength, semantic, freshness, and curation weights.",
      "Use output_search, not recall_search intent, when the information need is raw recent command or tool output.",
      "Treat tape_evidence and repository_precedent results as advisory recall, not authority. Follow the cited source family and verify stale claims with ordinary tools.",
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
      intent: Type.Optional(RECALL_SEARCH_INTENT_SCHEMA),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const query = normalizeQuery(params.query);
      const stableIds = normalizeStableIds(params.stable_ids);
      if (!query && stableIds.length === 0) {
        return errTextResult("recall_search rejected (missing_query_or_stable_ids).", {
          ok: false,
          error: "missing_query_or_stable_ids",
        });
      }
      if (query && stableIds.length > 0) {
        return errTextResult("recall_search rejected (query_and_stable_ids_conflict).", {
          ok: false,
          error: "query_and_stable_ids_conflict",
        });
      }

      const scope = resolveToolTargetScope(runtime, ctx);
      const brokerRuntime = resolveRecallBrokerRuntime(runtime);
      if (query) {
        const intent = normalizeIntent(params.intent) ?? "prior_work";
        const search = await getOrCreateRecallBroker(brokerRuntime)
          .search({
            sessionId,
            query,
            scope: normalizeScope(params.scope),
            intent,
            limit: params.limit,
          })
          .catch((error: unknown) => {
            if (isRecallSessionIndexUnavailable(error)) {
              return sessionIndexUnavailableResult(error);
            }
            throw error;
          });
        if ("content" in search) {
          return search;
        }

        if (search.results.length > 0) {
          recordToolRuntimeEvent(runtime, {
            sessionId,
            type: RECALL_RESULTS_SURFACED_EVENT_TYPE,
            payload: {
              source: "recall_search",
              scope: search.scope,
              intent: search.intent ?? null,
              results: search.results.map((entry) =>
                projectRecallResultProvenance(entry, {
                  currentSessionId: sessionId,
                  defaultRootRef: scope.allowedRoots[0] ?? "",
                }),
              ),
              allowedRoots: scope.allowedRoots,
            },
          });
        }

        return okTextResult(
          [
            "[RecallSearch]",
            "mode: search",
            `query: ${query}`,
            `scope: ${search.scope}`,
            `intent: ${search.intent ?? "prior_work"}`,
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
            intent: search.intent ?? null,
            allowedRoots: scope.allowedRoots,
            curationHalfLifeDays: RECALL_CURATION_HALFLIFE_DAYS,
            results: search.results.map((entry) => ({
              stableId: entry.stableId,
              sourceFamily: entry.sourceFamily,
              sessionScope: entry.sessionScope,
              rootRef: entry.rootRef,
              trustLabel: entry.trustLabel,
              evidenceStrength: entry.evidenceStrength,
              scope: entry.scope,
              freshness: entry.freshness,
              title: entry.title,
              summary: entry.summary,
              excerpt: entry.excerpt,
              semanticScore: entry.semanticScore,
              rankingScore: entry.rankingScore,
              sessionId: entry.sessionId ?? null,
              relativePath: entry.relativePath ?? null,
              targetRoots: entry.targetRoots ?? [],
              matchReasons: entry.matchReasons,
              rankReasons: entry.rankReasons,
              curation: entry.curation ?? null,
            })),
          },
        );
      }

      const inspection = await getOrCreateRecallBroker(brokerRuntime)
        .inspectStableIds({
          sessionId,
          stableIds,
          scope: normalizeScope(params.scope),
        })
        .catch((error: unknown) => {
          if (isRecallSessionIndexUnavailable(error)) {
            return sessionIndexUnavailableResult(error);
          }
          throw error;
        });
      if ("content" in inspection) {
        return inspection;
      }

      if (inspection.results.length > 0) {
        recordToolRuntimeEvent(runtime, {
          sessionId,
          type: RECALL_RESULTS_SURFACED_EVENT_TYPE,
          payload: {
            source: "recall_search",
            scope: inspection.scope,
            results: inspection.results.map((entry) =>
              projectRecallResultProvenance(entry, {
                currentSessionId: sessionId,
                defaultRootRef: scope.allowedRoots[0] ?? "",
              }),
            ),
            allowedRoots: scope.allowedRoots,
          },
        });
      }

      return okTextResult(
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
            sessionScope: entry.sessionScope,
            rootRef: entry.rootRef,
            trustLabel: entry.trustLabel,
            evidenceStrength: entry.evidenceStrength,
            scope: entry.scope,
            freshness: entry.freshness,
            title: entry.title,
            summary: entry.summary,
            excerpt: entry.excerpt,
            semanticScore: entry.semanticScore,
            rankingScore: entry.rankingScore,
            sessionId: entry.sessionId ?? null,
            relativePath: entry.relativePath ?? null,
            targetRoots: entry.targetRoots ?? [],
            matchReasons: entry.matchReasons,
            rankReasons: entry.rankReasons,
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
      "Record explicit operator feedback for surfaced recall items without mutating claims, workbench entries, or repository solution records directly.",
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
      const stableIds = normalizeStableIds(params.stable_ids);
      if (stableIds.length === 0) {
        return errTextResult("recall_curate rejected (missing_stable_ids).", {
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

      return okTextResult(
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

function renderRcrOutcome(
  index: number,
  reference: RcrReference,
  outcome: RcrResolutionOutcome,
): string {
  const head = `- [${index}] event=${reference.eventRef.sessionId}:${reference.eventRef.eventId} path=${reference.contentPath || "(root)"} status=${outcome.status}`;
  if (outcome.status === "unresolvable_reference") {
    return `${head} reason=${outcome.reason}`;
  }
  return `${head}\n  content=${JSON.stringify(outcome.content)}`;
}

export function createRecallExpandTool(options: BrewvaToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "recall_expand");
  return define({
    name: "recall_expand",
    label: "Recall Expand",
    description:
      "Recover the exact previously model-visible content behind a reversible eviction reference, resolved from committed tape truth.",
    promptSnippet:
      "Use this to restore a span you evicted earlier when you need its exact original content again. Resolution is redaction-bounded and fails closed when the reference no longer matches tape.",
    parameters: Type.Object({
      entry_id: Type.String({ minLength: 1, maxLength: 256 }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const entryId = params.entry_id.trim();
      if (entryId.length === 0) {
        return errTextResult("recall_expand rejected (missing_entry_id).", {
          ok: false,
          error: "missing_entry_id",
        });
      }
      const entry = runtime.capabilities.workbench
        .list(sessionId)
        .find((candidate) => candidate.id === entryId);
      if (!entry) {
        return errTextResult(`recall_expand unresolved (unknown_entry_id): ${entryId}`, {
          ok: false,
          error: "unknown_entry_id",
          entryId,
        });
      }
      const references = (entry.rcr ?? [])
        .map((value) => parseRcrReference(value))
        .filter((reference): reference is RcrReference => reference !== null);
      if (references.length === 0) {
        return errTextResult(`recall_expand unresolved (no_reversible_reference): ${entryId}`, {
          ok: false,
          error: "no_reversible_reference",
          entryId,
        });
      }
      const source = createRecordsRcrTapeEventSource(runtime);
      const results = await Promise.all(
        references.map(async (reference) => ({
          reference,
          outcome: await resolveRcrReference(reference, source).catch(
            (): RcrResolutionOutcome => ({
              status: "unresolvable_reference",
              reason: "event_unavailable",
            }),
          ),
        })),
      );
      // Only a clean "resolved" counts; "sensitive_payload_withheld" returns a
      // redaction-bounded partial and is reported separately, not as recovered.
      const resolved = results.filter((item) => item.outcome.status === "resolved");
      return okTextResult(
        [
          "[RecallExpand]",
          `entry_id: ${entryId}`,
          `references: ${references.length}`,
          `resolved: ${resolved.length}`,
          ...results.map((item, index) => renderRcrOutcome(index, item.reference, item.outcome)),
        ].join("\n"),
        {
          ok: true,
          entryId,
          references: references.length,
          resolved: resolved.length,
          results: results.map((item) =>
            item.outcome.status === "unresolvable_reference"
              ? {
                  eventRef: item.reference.eventRef,
                  contentPath: item.reference.contentPath,
                  status: item.outcome.status,
                  reason: item.outcome.reason,
                }
              : {
                  eventRef: item.reference.eventRef,
                  contentPath: item.reference.contentPath,
                  status: item.outcome.status,
                  content: item.outcome.content,
                },
          ),
        },
      );
    },
  });
}
