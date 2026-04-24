import {
  CONTEXT_SOURCES,
  RECALL_RESULTS_SURFACED_EVENT_TYPE,
  type BrewvaHostedRuntimePort,
  type ContextSourceProvider,
  defineContextSourceProvider,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import { getOrCreateRecallBroker, isRecallSessionIndexUnavailable } from "./broker.js";
import type { RecallScope, RecallSearchEntry, RecallSearchIntent } from "./types.js";

const DEFAULT_MAX_CONTEXT_RESULTS = 4;

type RecallContextIntentInput = {
  sessionId: string;
  promptText: string;
};

type RecallContextIntentResolver =
  | RecallSearchIntent
  | ((input: RecallContextIntentInput) => RecallSearchIntent | undefined);

const REPOSITORY_PRECEDENT_PATTERNS = [
  /\b(?:repository|repo)\s+(?:precedent|practice|guidance|convention)s?\b/i,
  /\bdocs\/solutions\b/i,
  /\bprior\s+(?:solution|practice|precedent)\b/i,
  /(?:\u5148\u4f8b|\u5386\u53f2\u505a\u6cd5|\u8fc7\u5f80\u505a\u6cd5|\u4ed3\u5e93\u89c4\u8303|\u9879\u76ee\u89c4\u8303)/u,
];

const CURRENT_SESSION_EVIDENCE_PATTERNS = [
  /\b(?:current|this)\s+session\b/i,
  /\b(?:just|latest|previous)\s+(?:ran|run|command|output|trace|event|receipt)s?\b/i,
  /(?:\u521a\u624d|\u521a\u8dd1|\u5f53\u524d\s*session|\u5f53\u524d\u4f1a\u8bdd|\u4e0a\u4e00\u6b21\u547d\u4ee4)/u,
];

const DURABLE_RUNTIME_RECEIPT_PATTERNS = [
  /\b(?:runtime|kernel|tool|verification|skill)\s+receipt\b/i,
  /\b(?:verified|verification)\s+(?:evidence|outcome|result)s?\b/i,
  /\bskill_completed\b/i,
  /(?:\u6536\u636e|\u9a8c\u8bc1\u7ed3\u679c)/u,
];

const PRIOR_WORK_PATTERNS = [
  /\b(?:prior|previous|past|similar)\s+(?:work|task|session|attempt|fix|change)s?\b/i,
  /\bwhat\s+(?:did|happened)\s+(?:we|i|you)\s+(?:do|try)\s+before\b/i,
  /(?:\u4ee5\u524d|\u4e4b\u524d|\u5386\u53f2)/u,
];

export function inferRecallSearchIntent(promptText: string): RecallSearchIntent {
  const text = promptText.trim();
  if (DURABLE_RUNTIME_RECEIPT_PATTERNS.some((pattern) => pattern.test(text))) {
    return "durable_runtime_receipts";
  }
  if (CURRENT_SESSION_EVIDENCE_PATTERNS.some((pattern) => pattern.test(text))) {
    return "current_session_evidence";
  }
  if (REPOSITORY_PRECEDENT_PATTERNS.some((pattern) => pattern.test(text))) {
    return "repository_precedent";
  }
  if (PRIOR_WORK_PATTERNS.some((pattern) => pattern.test(text))) {
    return "prior_work";
  }
  return "prior_work";
}

function resolveRecallContextIntent(
  configured: RecallContextIntentResolver | undefined,
  providerInput: RecallContextIntentInput,
): RecallSearchIntent {
  if (typeof configured === "function") {
    return configured(providerInput) ?? inferRecallSearchIntent(providerInput.promptText);
  }
  return configured ?? inferRecallSearchIntent(providerInput.promptText);
}

function renderRecallContextEntry(entry: RecallSearchEntry, intent: RecallSearchIntent): string {
  return [
    `[Recall:${entry.sourceFamily}:${entry.stableId}]`,
    `search_intent: ${intent}`,
    `title: ${entry.title}`,
    `trust_label: ${entry.trustLabel}`,
    `evidence_strength: ${entry.evidenceStrength}`,
    `ranking_score: ${entry.rankingScore.toFixed(3)}`,
    `scope: ${entry.scope}`,
    `freshness: ${entry.freshness}`,
    entry.sessionId ? `session_id: ${entry.sessionId}` : null,
    entry.relativePath ? `path: ${entry.relativePath}` : null,
    `summary: ${entry.summary}`,
    entry.excerpt ? `excerpt: ${entry.excerpt}` : null,
  ]
    .filter((line): line is string => typeof line === "string" && line.length > 0)
    .join("\n");
}

export function createRecallContextProvider(input: {
  runtime: BrewvaHostedRuntimePort;
  maxEntries?: number;
  scope?: RecallScope;
  intent?: RecallContextIntentResolver;
}): ContextSourceProvider {
  const broker = getOrCreateRecallBroker(input.runtime);
  return defineContextSourceProvider({
    kind: "advisory_recall",
    source: CONTEXT_SOURCES.recallBroker,
    collectionOrder: 14,
    selectionPriority: 14,
    readsFrom: ["recallBroker.search"],
    collect: async (providerInput) => {
      const intent = resolveRecallContextIntent(input.intent, providerInput);
      const search = await broker
        .search({
          sessionId: providerInput.sessionId,
          query: providerInput.promptText,
          scope: input.scope,
          intent,
          limit: Math.max(1, input.maxEntries ?? DEFAULT_MAX_CONTEXT_RESULTS),
        })
        .catch((error: unknown) => {
          if (isRecallSessionIndexUnavailable(error)) {
            return undefined;
          }
          throw error;
        });
      if (!search) {
        return;
      }
      if (search.results.length === 0) {
        return;
      }
      const stableIds = search.results.map((entry) => entry.stableId);
      recordRuntimeEvent(input.runtime, {
        sessionId: providerInput.sessionId,
        type: RECALL_RESULTS_SURFACED_EVENT_TYPE,
        skipTapeCheckpoint: true,
        payload: {
          source: "context_provider",
          scope: search.scope,
          intent: search.intent,
          stableIds,
        },
      });
      for (const entry of search.results) {
        providerInput.register({
          id: entry.stableId,
          content: renderRecallContextEntry(entry, intent),
        });
      }
    },
  });
}
