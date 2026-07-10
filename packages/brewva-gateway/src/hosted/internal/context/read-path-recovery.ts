import { readNonEmptyString } from "@brewva/brewva-std/text";
import { isRecord } from "@brewva/brewva-std/unknown";
import {
  readToolResultRecordedEventPayload,
  TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE,
  TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE,
  TOOL_RESULT_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/iteration";
import type { TurnLifecyclePort } from "../hooks/turn-lifecycle-port.js";
import { queryRuntimeEvents, type HostedRuntimeAdapterPort } from "../session/runtime-ports.js";
import { makeHostedContextBlock, type HostedContextBlock } from "./hosted-context-blocks.js";

const RECENT_TOOL_RESULT_WINDOW = 12;
const MIN_CONSECUTIVE_MISSING_PATH_FAILURES = 2;
const MAX_OBSERVED_PATHS = 24;
const MAX_OBSERVED_DIRECTORIES = 24;
const MISSING_PATH_PATTERN =
  /\b(?:enoent|no such file or directory|cannot find the file|file does not exist|not found)\b/i;

type RuntimeEventQueryPort = Pick<HostedRuntimeAdapterPort, "ops">;

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
    readNonEmptyString(args.path) ??
    readNonEmptyString(args.file_path) ??
    readNonEmptyString(args.filePath)
  );
}

function isMissingPathFailure(outputText: unknown): boolean {
  return typeof outputText === "string" && MISSING_PATH_PATTERN.test(outputText);
}

function analyzeRecentMissingPathFailures(
  runtime: RuntimeEventQueryPort,
  sessionId: string,
): ReadPathFailureState {
  const events = queryRuntimeEvents(runtime, sessionId, {
    type: TOOL_RESULT_RECORDED_EVENT_TYPE,
    last: RECENT_TOOL_RESULT_WINDOW,
  });
  const failedPaths: string[] = [];
  let consecutiveMissingPathFailures = 0;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = readToolResultRecordedEventPayload({
      type: TOOL_RESULT_RECORDED_EVENT_TYPE,
      payload: events[index]?.payload,
    });
    if (!payload || payload.toolName !== "read") {
      continue;
    }

    const failureContext = payload.failureContext;
    if (
      payload.verdict === "fail" &&
      failureContext &&
      isMissingPathFailure(failureContext.outputText)
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
  const evidenceEvents = queryRuntimeEvents(runtime, sessionId, {
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
      const normalized = readNonEmptyString(path);
      if (normalized) {
        observedPaths.push(normalized);
      }
    }
    for (const directory of payloadDirectories) {
      const normalized = readNonEmptyString(directory);
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
  const latestArm = queryRuntimeEvents(runtime, sessionId, {
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
  const payloadFailedPaths: readonly unknown[] = Array.isArray(payload.failedPaths)
    ? payload.failedPaths
    : [];
  const failedPaths = clampStringList(
    payloadFailedPaths
      .map((value) => readNonEmptyString(value))
      .filter((value): value is string => Boolean(value)),
    MAX_OBSERVED_PATHS,
  );

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

export function createReadPathRecoveryLifecycle(
  runtime: HostedRuntimeAdapterPort,
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

      // Emit exactly when a failure run crosses the threshold: once per run,
      // and a NEW run after recovery re-arms with fresh failed paths (the
      // analyzer reads the latest arming event and evidence observed after
      // it, so the rendered evidence never goes stale on a later run).
      const failureState = analyzeRecentMissingPathFailures(runtime, sessionId);
      if (failureState.consecutiveMissingPathFailures !== MIN_CONSECUTIVE_MISSING_PATH_FAILURES) {
        return undefined;
      }

      runtime.ops.tools.readPath.gateArmed({
        sessionId,
        payload: {
          consecutiveMissingPathFailures: failureState.consecutiveMissingPathFailures,
          failedPaths: failureState.failedPaths,
        },
      });

      return undefined;
    },
  };
}

// Evidence, not a gate (axiom 18): this block states what happened and what
// has been observed since; it never constrains which paths `read` may touch.
// The model decides how to recover.
export function buildReadPathRecoveryBlock(state: ReadPathRecoveryState): string | null {
  if (!state.active) {
    return null;
  }

  const lines = [
    "[Brewva Read Path Recovery]",
    `Recent \`read\` calls hit ${state.consecutiveMissingPathFailures} consecutive path-not-found failures.`,
  ];

  if (state.phase === "required") {
    lines.push("No discovery evidence has been observed since those failures.");
    lines.push(
      "Blind retries are likely to miss again; discovery (glob, grep, ls, or reading a known existing file) records observed paths here.",
    );
  } else {
    lines.push("Discovery evidence observed since:");
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
): HostedContextBlock[] {
  const state = analyzeReadPathRecoveryState(runtime, sessionId);
  const content = buildReadPathRecoveryBlock(state);
  if (!content) {
    return [];
  }
  const block = makeHostedContextBlock("read-path-recovery", content);
  return block ? [block] : [];
}

export { TOOL_READ_PATH_DISCOVERY_OBSERVED_EVENT_TYPE, TOOL_READ_PATH_GATE_ARMED_EVENT_TYPE };
