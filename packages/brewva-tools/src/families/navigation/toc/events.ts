import { TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE } from "@brewva/brewva-runtime/events";
import type { BrewvaBundledToolRuntime } from "../../../contracts/index.js";
import { recordToolRuntimeEvent } from "../../../runtime-port/extensions.js";
import { buildReadPathDiscoveryObservationPayload } from "../read-path-discovery.js";
import type { TocSearchCoreAdvisor, TocSearchSummary } from "../toc-search-core.js";

const TOC_EVENT_TYPE = "tool_toc_query";

export function recordTocReadPathObservation(input: {
  runtime?: BrewvaBundledToolRuntime;
  sessionId?: string;
  baseCwd: string;
  toolName: "toc_document" | "toc_search";
  evidenceKind: string;
  observedPaths: Iterable<string>;
}): void {
  const payload = buildReadPathDiscoveryObservationPayload({
    baseCwd: input.baseCwd,
    toolName: input.toolName,
    evidenceKind: input.evidenceKind,
    observedPaths: input.observedPaths,
  });
  if (!input.sessionId || !payload) {
    return;
  }
  recordToolRuntimeEvent(input.runtime, {
    sessionId: input.sessionId,
    type: TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
    payload,
  });
}

export function recordTocEvent(
  runtime: BrewvaBundledToolRuntime | undefined,
  sessionId: string | undefined,
  payload: Record<string, unknown>,
): void {
  if (!sessionId) return;
  recordToolRuntimeEvent(runtime, {
    sessionId,
    type: TOC_EVENT_TYPE,
    payload,
  });
}

export function recordTocSearchEvent(input: {
  runtime: BrewvaBundledToolRuntime | undefined;
  sessionId: string | undefined;
  summary: TocSearchSummary;
  candidateFiles: number;
  advisor: TocSearchCoreAdvisor;
  durationMs: number;
  returnedMatches: number;
  advisorStatus: string;
  broadQuery: boolean;
  budgetExceeded: boolean;
}): void {
  recordTocEvent(input.runtime, input.sessionId, {
    toolName: "toc_search",
    operation: "search",
    indexedFiles: input.summary.indexedFiles,
    candidateFiles: input.candidateFiles,
    returnedMatches: input.returnedMatches,
    cacheHits: input.summary.cacheHits,
    cacheMisses: input.summary.cacheMisses,
    skippedFiles: input.summary.skippedFiles,
    oversizedFiles: input.summary.oversizedFiles,
    indexedBytes: input.summary.indexedBytes,
    broadQuery: input.broadQuery,
    budgetExceeded: input.budgetExceeded,
    advisorStatus: input.advisorStatus,
    advisorSignalFiles: input.advisor.signalFiles,
    advisorReorderedMatches: input.advisor.reorderedMatches,
    comboMatches: input.advisor.comboMatches,
    durationMs: input.durationMs,
  });
}
