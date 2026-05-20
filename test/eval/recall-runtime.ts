import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { getOrCreateRecallBroker } from "@brewva/brewva-recall/broker";
import type { RecallBrokerRuntime } from "@brewva/brewva-recall/broker";
import { tokenizeSearchContent } from "@brewva/brewva-search";
import { parse } from "yaml";
import { createHostedRuntimeAdapter } from "../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";
import type { EvalTelemetry, RecallEvalDataset, RecallEvalMetrics } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function asRecallBrokerRuntime(runtime: {
  readonly identity: RecallBrokerRuntime["identity"];
  readonly ops: {
    readonly events: RecallBrokerRuntime["events"];
    readonly task: RecallBrokerRuntime["task"];
    readonly skills: RecallBrokerRuntime["skills"];
  };
}): RecallBrokerRuntime {
  const records = runtime.ops.events.records;
  return {
    identity: runtime.identity,
    events: {
      records: {
        listSessionIds: () => records.listSessionIds(),
        list: (sessionId, query) => records.list(sessionId, query),
        subscribe: (listener) => records.subscribe(listener),
      },
    },
    task: runtime.ops.task,
    skills: runtime.ops.skills,
    cacheKey: runtime,
  };
}

interface RecallRuntimeExecutionResult {
  outputs: Record<string, unknown>;
  telemetry: EvalTelemetry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function resolveAliasStableId(
  value: string,
  eventAliasMap: ReadonlyMap<string, string>,
  currentSessionId?: string,
): string {
  if (!value.startsWith("tape:")) {
    return value;
  }
  const parts = value.split(":");
  if (parts.length !== 3) {
    return value;
  }
  const [, sessionId, aliasOrId] = parts;
  const resolvedSessionId =
    sessionId === "$current" && currentSessionId ? currentSessionId : sessionId;
  const resolvedEventId = eventAliasMap.get(`${resolvedSessionId}:${aliasOrId}`) ?? aliasOrId;
  return `tape:${resolvedSessionId}:${resolvedEventId}`;
}

function resolveAliasRefs(
  value: unknown,
  eventAliasMap: ReadonlyMap<string, string>,
  currentSessionId?: string,
): unknown {
  if (typeof value === "string") {
    return resolveAliasStableId(value, eventAliasMap, currentSessionId);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveAliasRefs(entry, eventAliasMap, currentSessionId));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      resolveAliasRefs(entry, eventAliasMap, currentSessionId),
    ]),
  );
}

function estimateTextTokenCost(text: string): number {
  return tokenizeSearchContent(text).length;
}

function estimateBrokerTokenCost(results: readonly Record<string, unknown>[]): number {
  return results.reduce((sum, entry) => {
    const title = typeof entry.title === "string" ? entry.title : "";
    const summary = typeof entry.summary === "string" ? entry.summary : "";
    const excerpt = typeof entry.excerpt === "string" ? entry.excerpt : "";
    const sourceFamily = typeof entry.source_family === "string" ? entry.source_family : "";
    return sum + estimateTextTokenCost(`${sourceFamily} ${title} ${summary} ${excerpt}`.trim());
  }, 0);
}

function estimateBaselineTokenCost(results: readonly Record<string, unknown>[]): number {
  return results.reduce((sum, entry) => {
    const type = typeof entry.type === "string" ? entry.type : "";
    const excerpt = typeof entry.excerpt === "string" ? entry.excerpt : "";
    return sum + estimateTextTokenCost(`${type} ${excerpt}`.trim());
  }, 0);
}

function precisionAtK(resultIds: readonly string[], relevantIds: ReadonlySet<string>): number {
  if (resultIds.length === 0) {
    return 0;
  }
  const hits = resultIds.filter((stableId) => relevantIds.has(stableId)).length;
  return hits / resultIds.length;
}

function rateForSet(resultIds: readonly string[], stableIds: ReadonlySet<string>): number {
  if (resultIds.length === 0) {
    return 0;
  }
  const hits = resultIds.filter((stableId) => stableIds.has(stableId)).length;
  return hits / resultIds.length;
}

function usefulRecallRate(resultIds: readonly string[], relevantIds: ReadonlySet<string>): number {
  return resultIds.some((stableId) => relevantIds.has(stableId)) ? 1 : 0;
}

function topOneHitRate(resultIds: readonly string[], relevantIds: ReadonlySet<string>): number {
  const topId = resultIds[0];
  return topId && relevantIds.has(topId) ? 1 : 0;
}

export async function executeRecallRuntimeScenario(input: {
  datasetPath: string;
  workspaceRoot: string;
}): Promise<RecallRuntimeExecutionResult> {
  void input.workspaceRoot;
  const datasetRaw = await Bun.file(input.datasetPath).text();
  const dataset = parse(datasetRaw) as RecallEvalDataset;
  if (dataset.schema !== "brewva.recall-eval.dataset.v1") {
    throw new Error(`Unsupported recall eval dataset schema in ${input.datasetPath}`);
  }

  const workspace = mkdtempSync(join(tmpdir(), "brewva-recall-eval-workspace-"));
  for (const file of dataset.workspace_files ?? []) {
    const absolutePath = join(workspace, file.path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, file.content, "utf8");
  }

  const runtime = createHostedRuntimeAdapter({ cwd: workspace });
  const eventAliasMap = new Map<string, string>();

  for (const session of dataset.sessions) {
    runtime.ops.context.lifecycle.onTurnStart(session.id, 1);
    runtime.ops.task.spec.set(session.id, {
      schema: "brewva.task.v1",
      goal: session.goal,
      targets: session.target_files ? { files: session.target_files } : undefined,
    });

    for (const event of session.events ?? []) {
      const payload = resolveAliasRefs(cloneValue(event.payload ?? {}), eventAliasMap, session.id);
      const timestamp =
        typeof event.timestamp === "number"
          ? event.timestamp
          : typeof event.age_days === "number"
            ? Date.now() - event.age_days * DAY_MS
            : undefined;
      if (event.type === "recall_curation_recorded") {
        runtime.ops.tools.recall.curationRecorded({
          sessionId: session.id,
          payload: isRecord(payload) ? payload : {},
          ...(timestamp ? { timestamp } : {}),
          ...(typeof event.turn === "number" ? { turn: event.turn } : {}),
        });
      } else if (
        event.type === "task_event" &&
        isRecord(payload) &&
        payload.kind === "item_added"
      ) {
        const item = isRecord(payload.item) ? payload.item : {};
        const text = typeof item.text === "string" ? item.text : "";
        runtime.ops.task.items.add(session.id, {
          id: typeof item.id === "string" ? item.id : undefined,
          text,
          status: typeof item.status === "string" ? item.status : undefined,
          timestamp,
          turn: typeof event.turn === "number" ? event.turn : undefined,
        });
      }
      const recorded = runtime.ops.events.records.list(session.id).at(-1);
      if (event.alias && recorded) {
        eventAliasMap.set(`${session.id}:${event.alias}`, recorded.id);
      }
    }
  }

  const limit = Math.max(1, dataset.query.limit ?? 6);
  const currentSessionId = dataset.query.session_id;

  const baselineStartedAt = performance.now();
  const baselineSearch = runtime.ops.tape.search.search(currentSessionId, {
    query: dataset.query.text,
    scope: "all_phases",
    limit,
  });
  const baselineLatencyMs = performance.now() - baselineStartedAt;

  const broker = getOrCreateRecallBroker(asRecallBrokerRuntime(runtime));
  const genericBrokerStartedAt = performance.now();
  const genericBrokerSearch = await broker.search({
    sessionId: currentSessionId,
    query: dataset.query.text,
    scope: dataset.query.scope,
    limit,
  });
  const genericBrokerLatencyMs = performance.now() - genericBrokerStartedAt;

  let brokerSearch = genericBrokerSearch;
  let brokerLatencyMs = genericBrokerLatencyMs;
  if (dataset.query.intent) {
    const intentBrokerStartedAt = performance.now();
    brokerSearch = await broker.search({
      sessionId: currentSessionId,
      query: dataset.query.text,
      scope: dataset.query.scope,
      intent: dataset.query.intent,
      limit,
    });
    brokerLatencyMs = performance.now() - intentBrokerStartedAt;
  }

  const relevantIds = new Set(
    dataset.expectations.relevant_stable_ids.map((stableId) =>
      resolveAliasStableId(stableId, eventAliasMap, currentSessionId),
    ),
  );
  const harmfulIds = new Set(
    (dataset.expectations.harmful_stable_ids ?? []).map((stableId) =>
      resolveAliasStableId(stableId, eventAliasMap, currentSessionId),
    ),
  );
  const contradictoryIds = new Set(
    (dataset.expectations.contradictory_stable_ids ?? []).map((stableId) =>
      resolveAliasStableId(stableId, eventAliasMap, currentSessionId),
    ),
  );
  const expectedTopStableId = dataset.expectations.expected_top_stable_id
    ? resolveAliasStableId(
        dataset.expectations.expected_top_stable_id,
        eventAliasMap,
        currentSessionId,
      )
    : undefined;

  const baselineResults = baselineSearch.matches.map(
    (match: { eventId: string; type: string; excerpt: string; timestamp: number }) => ({
      stable_id: `tape:${currentSessionId}:${match.eventId}`,
      source_family: "tape_evidence",
      type: match.type,
      excerpt: match.excerpt,
      timestamp: match.timestamp,
    }),
  );
  const brokerResults = brokerSearch.results.map((entry) => ({
    stable_id: entry.stableId,
    source_family: entry.sourceFamily,
    title: entry.title,
    summary: entry.summary,
    excerpt: entry.excerpt,
    ranking_score: entry.rankingScore,
    semantic_score: entry.semanticScore,
    trust_label: entry.trustLabel,
    evidence_strength: entry.evidenceStrength,
    freshness: entry.freshness,
  }));

  const baselineStableIds = baselineResults.map(
    (entry: { readonly stable_id: string }) => entry.stable_id,
  );
  const brokerStableIds = brokerResults.map(
    (entry: { readonly stable_id: string }) => entry.stable_id,
  );
  const genericBrokerStableIds = genericBrokerSearch.results.map(
    (entry: { readonly stableId: string }) => entry.stableId,
  );
  const baselineTokenCost = estimateBaselineTokenCost(baselineResults);
  const brokerTokenCost = estimateBrokerTokenCost(brokerResults);

  const metrics: RecallEvalMetrics = {
    baseline_precision_at_k: precisionAtK(baselineStableIds, relevantIds),
    broker_precision_at_k: precisionAtK(brokerStableIds, relevantIds),
    precision_gain_at_k:
      precisionAtK(brokerStableIds, relevantIds) - precisionAtK(baselineStableIds, relevantIds),
    ...(dataset.query.intent
      ? {
          broker_without_intent_top_1_hit_rate: topOneHitRate(genericBrokerStableIds, relevantIds),
          broker_with_intent_top_1_hit_rate: topOneHitRate(brokerStableIds, relevantIds),
          intent_top_1_gain:
            topOneHitRate(brokerStableIds, relevantIds) -
            topOneHitRate(genericBrokerStableIds, relevantIds),
        }
      : {}),
    baseline_useful_recall_rate: usefulRecallRate(baselineStableIds, relevantIds),
    broker_useful_recall_rate: usefulRecallRate(brokerStableIds, relevantIds),
    useful_recall_gain:
      usefulRecallRate(brokerStableIds, relevantIds) -
      usefulRecallRate(baselineStableIds, relevantIds),
    baseline_harmful_recall_rate: rateForSet(baselineStableIds, harmfulIds),
    broker_harmful_recall_rate: rateForSet(brokerStableIds, harmfulIds),
    baseline_contradiction_rate: rateForSet(baselineStableIds, contradictoryIds),
    broker_contradiction_rate: rateForSet(brokerStableIds, contradictoryIds),
    baseline_latency_ms: baselineLatencyMs,
    broker_latency_ms: brokerLatencyMs,
    added_latency_ms: brokerLatencyMs - baselineLatencyMs,
    baseline_token_cost: baselineTokenCost,
    broker_token_cost: brokerTokenCost,
    added_token_cost: brokerTokenCost - baselineTokenCost,
  };

  const topResult = brokerResults[0] ?? null;
  const genericBrokerTopResult = genericBrokerSearch.results[0]
    ? {
        stable_id: genericBrokerSearch.results[0].stableId,
        source_family: genericBrokerSearch.results[0].sourceFamily,
        title: genericBrokerSearch.results[0].title,
        summary: genericBrokerSearch.results[0].summary,
        excerpt: genericBrokerSearch.results[0].excerpt,
        ranking_score: genericBrokerSearch.results[0].rankingScore,
        semantic_score: genericBrokerSearch.results[0].semanticScore,
        trust_label: genericBrokerSearch.results[0].trustLabel,
        evidence_strength: genericBrokerSearch.results[0].evidenceStrength,
        freshness: genericBrokerSearch.results[0].freshness,
      }
    : null;
  const baselineTopResult = baselineResults[0] ?? null;
  const topMatchesExpectation = expectedTopStableId
    ? brokerResults[0]?.stable_id === expectedTopStableId
    : null;

  return {
    outputs: {
      summary: [
        `broker scope=${brokerSearch.scope} intent=${brokerSearch.intent ?? "none"} query="${brokerSearch.query}" returned ${brokerResults.length} result(s)`,
        `session-local baseline returned ${baselineResults.length} result(s)`,
        dataset.query.intent
          ? `intent_top_1_gain=${metrics.intent_top_1_gain?.toFixed(2) ?? "n/a"}`
          : "intent_top_1_gain=not_set",
        expectedTopStableId
          ? `top_result_matches_expectation=${topMatchesExpectation ? "yes" : "no"}`
          : "top_result_matches_expectation=not_set",
      ].join("; "),
      top_result: topResult,
      broker_without_intent_top_result: dataset.query.intent ? genericBrokerTopResult : null,
      baseline_top_result: baselineTopResult,
      broker_results: brokerResults,
      baseline_results: baselineResults,
      metrics,
    },
    telemetry: {
      kind: "recall",
      metrics,
    },
  };
}
