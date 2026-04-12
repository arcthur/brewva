import type { ContextSourceProvider } from "@brewva/brewva-runtime";
import {
  CONTEXT_SOURCES,
  RECALL_RESULTS_SURFACED_EVENT_TYPE,
  type BrewvaHostedRuntimePort,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import { getOrCreateRecallBroker } from "./broker.js";
import type { RecallScope, RecallSearchEntry } from "./types.js";

const DEFAULT_MAX_CONTEXT_RESULTS = 4;

function renderRecallContextEntry(entry: RecallSearchEntry): string {
  return [
    `[Recall:${entry.sourceFamily}:${entry.stableId}]`,
    `title: ${entry.title}`,
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
}): ContextSourceProvider {
  const broker = getOrCreateRecallBroker(input.runtime);
  return {
    source: CONTEXT_SOURCES.recallBroker,
    category: "narrative",
    budgetClass: "recall",
    order: 48,
    collect: (providerInput) => {
      const search = broker.search({
        sessionId: providerInput.sessionId,
        query: providerInput.promptText,
        scope: input.scope,
        limit: Math.max(1, input.maxEntries ?? DEFAULT_MAX_CONTEXT_RESULTS),
      });
      if (search.results.length === 0) {
        return;
      }
      const stableIds = search.results.map((entry) => entry.stableId);
      recordRuntimeEvent(input.runtime, {
        sessionId: providerInput.sessionId,
        type: RECALL_RESULTS_SURFACED_EVENT_TYPE,
        payload: {
          source: "context_provider",
          scope: search.scope,
          stableIds,
        },
      });
      for (const entry of search.results) {
        providerInput.register({
          id: entry.stableId,
          content: renderRecallContextEntry(entry),
        });
      }
    },
  };
}
