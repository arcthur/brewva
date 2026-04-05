import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import {
  TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
  TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
  TOOL_CONTRACT_WARNING_EVENT_TYPE,
  TOOL_RESULT_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import type { ComposedContextBlock } from "./context-composer.js";
import type { TurnLifecyclePort } from "./turn-lifecycle-port.js";

const RECENT_TOOL_RESULT_WINDOW = 12;
const MIN_CONSECUTIVE_MISSING_PATH_FAILURES = 2;
const MAX_OBSERVED_PATHS = 24;
const MAX_OBSERVED_DIRECTORIES = 24;
const MISSING_PATH_PATTERN =
  /\b(?:enoent|no such file or directory|cannot find the file|file does not exist|not found)\b/i;

interface RuntimeEventQueryPort {
  inspect: {
    events: {
      query(
        sessionId: string,
        query?: {
          type?: string;
          last?: number;
          after?: number;
        },
      ): Array<{ payload?: unknown; timestamp: number }>;
    };
  };
}

type ReadPathRecoveryPhase = "inactive" | "required" | "satisfied";

export interface ReadPathRecoveryState {
  active: boolean;
  phase: ReadPathRecoveryPhase;
  consecutiveMissingPathFailures: number;
  failedPaths: string[];
  observedPaths: string[];
  observedDirectories: string[];
}

interface ReadPathFailureState {
  consecutiveMissingPathFailures: number;
  failedPaths: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeWorkspacePath(baseCwd: string, candidate: string): string | undefined {
  const absolutePath = isAbsolute(candidate) ? resolve(candidate) : resolve(baseCwd, candidate);
  const relativePath = relative(baseCwd, absolutePath).replaceAll("\\", "/");
  if (relativePath.startsWith("../") || relativePath === "..") {
    return undefined;
  }
  if (relativePath.length === 0) {
    return ".";
  }
  return relativePath.replace(/^\.\/+/u, "");
}

function clampStringList(values: Iterable<string>, maxItems: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
    if (output.length >= maxItems) {
      break;
    }
  }
  return output;
}

function extractPathFromArgs(args: unknown): string | undefined {
  if (!isRecord(args)) {
    return undefined;
  }
  return (
    normalizeOptionalString(args.path) ??
    normalizeOptionalString(args.file_path) ??
    normalizeOptionalString(args.filePath)
  );
}

function isMissingPathFailure(outputText: unknown): boolean {
  return typeof outputText === "string" && MISSING_PATH_PATTERN.test(outputText);
}

function analyzeRecentMissingPathFailures(
  runtime: RuntimeEventQueryPort,
  sessionId: string,
): ReadPathFailureState {
  const events = runtime.inspect.events.query(sessionId, {
    type: TOOL_RESULT_RECORDED_EVENT_TYPE,
    last: RECENT_TOOL_RESULT_WINDOW,
  });
  const failedPaths: string[] = [];
  let consecutiveMissingPathFailures = 0;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index]?.payload;
    if (!isRecord(payload)) {
      continue;
    }
    if (normalizeOptionalString(payload.toolName) !== "read") {
      continue;
    }

    const failureContext = isRecord(payload.failureContext) ? payload.failureContext : null;
    if (
      payload.verdict === "fail" &&
      isMissingPathFailure(failureContext?.outputText) &&
      failureContext
    ) {
      consecutiveMissingPathFailures += 1;
      const failedPath = extractPathFromArgs(failureContext.args);
      if (failedPath && !failedPaths.includes(failedPath)) {
        failedPaths.push(failedPath);
      }
      continue;
    }

    break;
  }

  return {
    consecutiveMissingPathFailures,
    failedPaths,
  };
}

function collectObservedDiscoveryEvidence(
  runtime: RuntimeEventQueryPort,
  sessionId: string,
  armedAt: number,
): {
  observedPaths: string[];
  observedDirectories: string[];
} {
  const evidenceEvents = runtime.inspect.events.query(sessionId, {
    type: TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
    after: armedAt - 1,
  });
  const observedPaths: string[] = [];
  const observedDirectories: string[] = [];

  for (const event of evidenceEvents) {
    const payload = isRecord(event.payload) ? event.payload : null;
    const payloadPaths = Array.isArray(payload?.observedPaths) ? payload.observedPaths : [];
    const payloadDirectories = Array.isArray(payload?.observedDirectories)
      ? payload.observedDirectories
      : [];
    for (const path of payloadPaths) {
      const normalized = normalizeOptionalString(path);
      if (normalized) {
        observedPaths.push(normalized);
      }
    }
    for (const directory of payloadDirectories) {
      const normalized = normalizeOptionalString(directory);
      if (normalized) {
        observedDirectories.push(normalized);
      }
    }
  }

  return {
    observedPaths: clampStringList(observedPaths, MAX_OBSERVED_PATHS),
    observedDirectories: clampStringList(observedDirectories, MAX_OBSERVED_DIRECTORIES),
  };
}

export function analyzeReadPathRecoveryState(
  runtime: RuntimeEventQueryPort,
  sessionId: string,
): ReadPathRecoveryState {
  const latestArm = runtime.inspect.events.query(sessionId, {
    type: TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
    last: 1,
  })[0];
  const recentFailures = analyzeRecentMissingPathFailures(runtime, sessionId);

  if (!latestArm) {
    return {
      active: false,
      phase: "inactive",
      consecutiveMissingPathFailures: recentFailures.consecutiveMissingPathFailures,
      failedPaths: recentFailures.failedPaths,
      observedPaths: [],
      observedDirectories: [],
    };
  }

  const payload = isRecord(latestArm.payload) ? latestArm.payload : {};
  const observed = collectObservedDiscoveryEvidence(runtime, sessionId, latestArm.timestamp);
  const failedPaths = Array.isArray(payload.failedPaths)
    ? clampStringList(
        payload.failedPaths
          .map((value) => normalizeOptionalString(value))
          .filter((value): value is string => Boolean(value)),
        MAX_OBSERVED_PATHS,
      )
    : [];

  return {
    active: true,
    phase:
      observed.observedPaths.length > 0 || observed.observedDirectories.length > 0
        ? "satisfied"
        : "required",
    consecutiveMissingPathFailures:
      typeof payload.consecutiveMissingPathFailures === "number"
        ? Math.max(0, Math.trunc(payload.consecutiveMissingPathFailures))
        : 0,
    failedPaths,
    observedPaths: observed.observedPaths,
    observedDirectories: observed.observedDirectories,
  };
}

export function isReadPathVerified(
  state: ReadPathRecoveryState,
  requestedPath: string,
  cwd: string,
): boolean {
  if (!state.active || state.phase === "inactive") {
    return true;
  }

  const normalizedRequestedPath = normalizeWorkspacePath(cwd, requestedPath);
  if (!normalizedRequestedPath) {
    return false;
  }
  if (state.observedPaths.includes(normalizedRequestedPath)) {
    return true;
  }

  let currentDirectory = dirname(normalizedRequestedPath).replaceAll("\\", "/");
  if (currentDirectory === "") {
    currentDirectory = ".";
  }

  while (true) {
    if (state.observedDirectories.includes(currentDirectory)) {
      return true;
    }
    if (currentDirectory === ".") {
      return false;
    }
    const nextDirectory = dirname(currentDirectory).replaceAll("\\", "/");
    currentDirectory = nextDirectory === "" ? "." : nextDirectory;
  }
}

export function createReadPathRecoveryLifecycle(
  runtime: BrewvaHostedRuntimePort,
): TurnLifecyclePort {
  return {
    toolResult(event, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();
      const toolName =
        typeof event.toolName === "string" && event.toolName.trim().length > 0
          ? event.toolName.trim()
          : undefined;
      if (!sessionId || toolName !== "read") {
        return undefined;
      }

      const state = analyzeReadPathRecoveryState(runtime, sessionId);
      if (state.active) {
        return undefined;
      }

      const failureState = analyzeRecentMissingPathFailures(runtime, sessionId);
      if (failureState.consecutiveMissingPathFailures < MIN_CONSECUTIVE_MISSING_PATH_FAILURES) {
        return undefined;
      }

      recordRuntimeEvent(runtime, {
        sessionId,
        type: TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
        payload: {
          consecutiveMissingPathFailures: failureState.consecutiveMissingPathFailures,
          failedPaths: failureState.failedPaths,
        },
      });

      return undefined;
    },
  };
}

export function buildReadPathRecoveryBlock(state: ReadPathRecoveryState): string | null {
  if (!state.active) {
    return null;
  }

  const lines = [
    "[Brewva Read Path Recovery]",
    `Recent \`read\` calls hit ${state.consecutiveMissingPathFailures} consecutive path-not-found failures.`,
    "Direct `read` is now gated by discovery evidence.",
  ];

  if (state.phase === "required") {
    lines.push("Run repository discovery or inspect a known existing file first.");
    lines.push("No additional `read` calls are allowed until at least one real path is observed.");
  } else {
    lines.push("Discovery evidence has been observed, but `read` stays constrained.");
    lines.push("Only read paths that were observed directly or live under observed directories.");
    if (state.observedDirectories.length > 0) {
      lines.push(`observed_directories: ${state.observedDirectories.slice(0, 8).join(", ")}`);
    }
    if (state.observedPaths.length > 0) {
      lines.push(`observed_paths: ${state.observedPaths.slice(0, 8).join(", ")}`);
    }
  }

  if (state.failedPaths.length > 0) {
    lines.push(`recent_failed_paths: ${state.failedPaths.slice(0, 4).join(", ")}`);
  }
  return lines.join("\n");
}

export function buildReadPathRecoveryBlocks(
  runtime: RuntimeEventQueryPort,
  sessionId: string,
): ComposedContextBlock[] {
  const state = analyzeReadPathRecoveryState(runtime, sessionId);
  const content = buildReadPathRecoveryBlock(state);
  if (!content) {
    return [];
  }
  return [
    {
      id: "read-path-recovery",
      category: "constraint",
      content,
      estimatedTokens: 0,
    },
  ];
}

export function buildReadPathGuardWarningPayload(input: {
  requestedPath: string;
  state: ReadPathRecoveryState;
}): Record<string, unknown> {
  return {
    toolName: "read",
    requestedPath: input.requestedPath,
    recentFailedPaths: input.state.failedPaths,
    observedPaths: input.state.observedPaths,
    observedDirectories: input.state.observedDirectories,
    consecutiveMissingPathFailures: input.state.consecutiveMissingPathFailures,
    phase: input.state.phase,
    reason: "path_discovery_required_after_missing_path_failures",
  };
}

export function recordReadPathGuardWarning(
  runtime: BrewvaHostedRuntimePort,
  input: {
    sessionId: string;
    requestedPath: string;
    state: ReadPathRecoveryState;
  },
): void {
  recordRuntimeEvent(runtime, {
    sessionId: input.sessionId,
    type: TOOL_CONTRACT_WARNING_EVENT_TYPE,
    payload: buildReadPathGuardWarningPayload({
      requestedPath: input.requestedPath,
      state: input.state,
    }),
  });
}

export { TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE, TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE };
