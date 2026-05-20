import {
  BOX_RELEASED_EVENT_TYPE,
  OBSERVABILITY_ASSERTION_RECORDED_EVENT_TYPE,
  OBSERVABILITY_QUERY_EXECUTED_EVENT_TYPE,
  RECALL_CURATION_RECORDED_EVENT_TYPE,
  RECALL_RESULTS_SURFACED_EVENT_TYPE,
  SESSION_COMPACT_FAILED_EVENT_TYPE,
  SESSION_COMPACT_REQUESTED_EVENT_TYPE,
  SESSION_COMPACT_REQUEST_FAILED_EVENT_TYPE,
  SUBAGENT_KNOWLEDGE_ADOPTION_RECORDED_EVENT_TYPE,
  TOOL_CALL_BLOCKED_EVENT_TYPE,
  TOOL_OUTPUT_ARTIFACT_PERSISTED_EVENT_TYPE,
  TOOL_OUTPUT_SEARCH_EVENT_TYPE,
  TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
  TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
} from "@brewva/brewva-runtime/protocol";
import type { BrewvaToolRuntime } from "../contracts/index.js";

export interface ToolRuntimeEventInput {
  sessionId: string;
  type: string;
  turn?: number;
  payload?: object;
  timestamp?: number;
  skipTapeCheckpoint?: boolean;
}

type ToolRuntimeEventPort = {
  records?: {
    list?(sessionId: string, query?: unknown): unknown[];
    query?(sessionId: string, query?: unknown): unknown[];
  };
};

type ToolRuntimeContextPort = {
  usage?: {
    getRatio?(usage: unknown): number | null;
  };
  compaction?: {
    getInstructions?(): string;
  };
};

type ToolRuntimeTaskPort = {
  target?: {
    getDescriptor?(sessionId: string): unknown;
  };
};

type ToolRuntimeCapabilitiesToolsPort = {
  parallel?: {
    acquireAsync?(
      sessionId: string,
      runId: string,
      options?: { timeoutMs?: number },
    ): Promise<{ accepted: boolean }>;
    release?(sessionId: string, runId: string): void;
  };
};

// Tool-side runtime extensions stay explicit. Callers that need these behaviors
// must inject `runtime.extensions.tools`; tools do not rediscover hosted or
// operator runtime ports behind the type system.
export function recordToolRuntimeEvent(
  runtime: BrewvaToolRuntime | undefined,
  input: ToolRuntimeEventInput,
): void {
  const event = {
    sessionId: input.sessionId,
    payload: input.payload ?? {},
    ...(typeof input.turn === "number" ? { turn: input.turn } : {}),
    ...(typeof input.timestamp === "number" ? { timestamp: input.timestamp } : {}),
  };
  if (input.type === TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE) {
    runtime?.capabilities?.tools?.readPath?.discoveryObserved(event);
  } else if (input.type === TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE) {
    runtime?.capabilities?.tools?.readPath?.gateArmed(event);
  } else if (input.type === "tool_parallel_read") {
    runtime?.capabilities?.tools?.lifecycle?.parallelRead?.(event);
  } else if (input.type === TOOL_CALL_BLOCKED_EVENT_TYPE) {
    runtime?.capabilities?.tools?.lifecycle?.callBlocked(event);
  } else if (input.type === TOOL_OUTPUT_SEARCH_EVENT_TYPE) {
    runtime?.capabilities?.tools?.outputs?.search(event);
  } else if (input.type === "tool_toc_query") {
    runtime?.capabilities?.tools?.outputs?.tocQuery(event);
  } else if (input.type === TOOL_OUTPUT_ARTIFACT_PERSISTED_EVENT_TYPE) {
    runtime?.capabilities?.tools?.outputs?.artifactPersisted(event);
  } else if (input.type === BOX_RELEASED_EVENT_TYPE) {
    runtime?.capabilities?.tools?.lifecycle?.boxReleased(event);
  } else if (input.type === RECALL_RESULTS_SURFACED_EVENT_TYPE) {
    runtime?.capabilities?.tools?.recall?.resultsSurfaced(event);
  } else if (input.type === RECALL_CURATION_RECORDED_EVENT_TYPE) {
    runtime?.capabilities?.tools?.recall?.curationRecorded(event);
  } else if (input.type === SESSION_COMPACT_REQUESTED_EVENT_TYPE) {
    runtime?.capabilities?.session?.lifecycle?.compactRequested(event);
  } else if (input.type === SESSION_COMPACT_FAILED_EVENT_TYPE) {
    runtime?.capabilities?.session?.lifecycle?.compactFailed(event);
  } else if (input.type === SESSION_COMPACT_REQUEST_FAILED_EVENT_TYPE) {
    runtime?.capabilities?.session?.lifecycle?.compactRequestFailed(event);
  } else if (input.type === OBSERVABILITY_QUERY_EXECUTED_EVENT_TYPE) {
    runtime?.capabilities?.tools?.observability?.queryExecuted(event);
  } else if (input.type === OBSERVABILITY_ASSERTION_RECORDED_EVENT_TYPE) {
    runtime?.capabilities?.tools?.observability?.assertionRecorded(event);
  } else if (input.type === SUBAGENT_KNOWLEDGE_ADOPTION_RECORDED_EVENT_TYPE) {
    runtime?.capabilities?.delegation?.lifecycle?.knowledgeAdoptionRecorded(event);
  } else if (input.type.startsWith("exec.") || input.type.startsWith("box.")) {
    runtime?.capabilities?.tools?.execution?.recordAudit({ ...event, type: input.type });
  }
}

export function resolveToolRuntimeCredentialBindings(
  runtime: BrewvaToolRuntime | undefined,
  sessionId: string,
  toolName: string,
): Record<string, string> {
  if (runtime?.extensions?.tools?.resolveCredentialBindings) {
    return runtime.extensions.tools.resolveCredentialBindings(sessionId, toolName);
  }
  return {};
}

export function registerToolRuntimeClearStateListener(
  runtime: BrewvaToolRuntime | undefined,
  listener: (sessionId: string) => void,
): void {
  if (runtime?.extensions?.tools?.onClearState) {
    runtime.extensions.tools.onClearState(listener);
  }
}

export function resolveToolRuntimeEventPort(
  runtime: BrewvaToolRuntime | undefined,
): ToolRuntimeEventPort | undefined {
  return runtime?.capabilities?.events;
}

export function resolveToolRuntimeTaskPort(
  runtime: BrewvaToolRuntime | undefined,
): ToolRuntimeTaskPort | undefined {
  return runtime?.capabilities?.task;
}

export function resolveToolRuntimeContextPort(
  runtime: BrewvaToolRuntime | undefined,
): ToolRuntimeContextPort | undefined {
  return runtime?.capabilities?.context;
}

export function resolveToolRuntimeCapabilitiesTools(
  runtime: BrewvaToolRuntime | undefined,
): ToolRuntimeCapabilitiesToolsPort | undefined {
  return runtime?.capabilities?.tools;
}
