import { resolveRuntimeSourceIdentity } from "@brewva/brewva-std/runtime-identity";
import {
  TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
  TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/iteration";
import { PATCH_RECORDED_EVENT_TYPE } from "@brewva/brewva-vocabulary/workbench";
import type { BrewvaToolRuntime } from "../../../contracts/index.js";
import {
  registerToolRuntimeClearStateListener,
  resolveToolRuntimeEventPort,
} from "../../../runtime-port/extensions.js";
import {
  buildAncestorDirectories,
  normalizeEventRecord,
  normalizePayloadRecord,
  normalizeSessionId,
  normalizeSignalPath,
  normalizeStringArray,
} from "./path.js";
import {
  applyDirectorySignal,
  applyPathSignal,
  attributeFollowthrough,
  createSessionState,
  getSessionState,
  isRuntimeAttached,
  markRuntimeAttached,
  replaceSessionState,
  trimSessionState,
} from "./state-store.js";
import {
  FAILED_READ_DIRECTORY_WEIGHT,
  OBSERVED_DIRECTORY_WEIGHT,
  OBSERVED_PATH_WEIGHT,
  PATCHED_FILE_WEIGHT,
  type NormalizedEventRecord,
  type SessionSearchAdvisorState,
} from "./types.js";

function queryRelevantEvents(
  eventPort: NonNullable<ReturnType<typeof resolveToolRuntimeEventPort>>,
  sessionId: string,
  after?: number,
): NormalizedEventRecord[] {
  return [
    ...(eventPort.records?.query?.(sessionId, {
      type: TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
      ...(typeof after === "number" ? { after } : {}),
    }) ?? []),
    ...(eventPort.records?.query?.(sessionId, {
      type: PATCH_RECORDED_EVENT_TYPE,
      ...(typeof after === "number" ? { after } : {}),
    }) ?? []),
    ...(eventPort.records?.query?.(sessionId, {
      type: TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
      ...(typeof after === "number" ? { after } : {}),
    }) ?? []),
  ]
    .map((event) => normalizeEventRecord(event))
    .filter((event): event is NormalizedEventRecord => Boolean(event))
    .toSorted((left, right) => {
      if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
      return left.id.localeCompare(right.id);
    });
}

export function attachRuntime(runtime: BrewvaToolRuntime | undefined): void {
  if (!runtime) {
    return;
  }
  const runtimeKey = resolveRuntimeSourceIdentity(runtime as object);
  if (isRuntimeAttached(runtimeKey)) {
    return;
  }
  registerToolRuntimeClearStateListener(runtime, (sessionId) => {
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId) {
      return;
    }
    const resetState = createSessionState();
    const eventPort = resolveToolRuntimeEventPort(runtime);
    const historicalEvents = eventPort?.records?.query
      ? queryRelevantEvents(eventPort, normalizedSessionId)
      : [];
    let maxObservedTimestamp = 0;
    for (const event of historicalEvents) {
      resetState.processedEventIds.set(event.id, true);
      maxObservedTimestamp = Math.max(maxObservedTimestamp, event.timestamp);
    }
    if (maxObservedTimestamp > 0) {
      resetState.lastFoldTimestamp = maxObservedTimestamp + 1;
    }
    replaceSessionState(normalizedSessionId, resetState);
  });
  markRuntimeAttached(runtimeKey);
}

function foldDiscoveryObservedEvent(
  state: SessionSearchAdvisorState,
  payload: Record<string, unknown>,
  timestamp: number,
): void {
  const toolName = typeof payload.toolName === "string" ? payload.toolName : undefined;
  const observedPaths = normalizeStringArray(payload.observedPaths);
  const observedDirectories = normalizeStringArray(payload.observedDirectories);
  for (const path of observedPaths) {
    applyPathSignal(state, "observed_path", path, OBSERVED_PATH_WEIGHT, timestamp);
    if (toolName !== "grep" && toolName !== "code_digest") {
      attributeFollowthrough(state, path, timestamp);
    }
  }
  for (const directory of observedDirectories) {
    applyDirectorySignal(
      state,
      "observed_directory",
      directory,
      OBSERVED_DIRECTORY_WEIGHT,
      timestamp,
    );
  }
}

function foldPatchRecordedEvent(
  state: SessionSearchAdvisorState,
  payload: Record<string, unknown>,
  timestamp: number,
): void {
  const failedPaths = new Set(normalizeStringArray(payload.failedPaths));
  const changes = Array.isArray(payload.changes) ? payload.changes : [];
  for (const change of changes) {
    const record = normalizePayloadRecord(change);
    const path = typeof record?.path === "string" ? normalizeSignalPath(record.path) : undefined;
    if (!path || failedPaths.has(path)) continue;
    applyPathSignal(state, "patched_file", path, PATCHED_FILE_WEIGHT, timestamp);
    attributeFollowthrough(state, path, timestamp);
  }
}

function foldReadPathGateArmedEvent(
  state: SessionSearchAdvisorState,
  payload: Record<string, unknown>,
  timestamp: number,
): void {
  const failedPaths = normalizeStringArray(payload.failedPaths);
  for (const failedPath of failedPaths) {
    for (const directory of buildAncestorDirectories(failedPath)) {
      applyDirectorySignal(
        state,
        "failed_read_directory",
        directory,
        FAILED_READ_DIRECTORY_WEIGHT,
        timestamp,
      );
    }
  }
}

export function syncDurableState(
  runtime: BrewvaToolRuntime | undefined,
  sessionId: string | undefined,
  now: number,
): SessionSearchAdvisorState | undefined {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    return undefined;
  }
  const eventPort = resolveToolRuntimeEventPort(runtime);
  const state = getSessionState(normalizedSessionId);
  attachRuntime(runtime);
  if (!eventPort?.records?.query) {
    trimSessionState(state, now);
    return state;
  }

  const after = state.lastFoldTimestamp > 0 ? Math.max(0, state.lastFoldTimestamp - 1) : undefined;
  const merged = queryRelevantEvents(eventPort, normalizedSessionId, after)
    .filter((event) => !state.processedEventIds.has(event.id))
    .toSorted((left, right) => {
      if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
      return left.id.localeCompare(right.id);
    });

  for (const event of merged) {
    state.processedEventIds.set(event.id, true);
    state.lastFoldTimestamp = Math.max(state.lastFoldTimestamp, event.timestamp);
    if (!event.payload) continue;
    if (event.type === TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE) {
      foldDiscoveryObservedEvent(state, event.payload, event.timestamp);
      continue;
    }
    if (event.type === PATCH_RECORDED_EVENT_TYPE) {
      foldPatchRecordedEvent(state, event.payload, event.timestamp);
      continue;
    }
    if (event.type === TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE) {
      foldReadPathGateArmedEvent(state, event.payload, event.timestamp);
    }
  }

  trimSessionState(state, now);
  return state;
}
