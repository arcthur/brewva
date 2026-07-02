import { compactWhitespace, truncateText } from "@brewva/brewva-std/text";
import { computeToolCallArgsDigest } from "@brewva/brewva-std/tool-call-digest";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import {
  readToolResultRecordedEventPayload,
  TOOL_RESULT_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/iteration";
import { queryRuntimeEvents, type HostedRuntimeAdapterPort } from "../session/runtime-ports.js";
import type { RuntimeBriefSection } from "./runtime-brief.js";

// Recovery-recurrence evidence (RFC R3): the model-native recovery posture keeps
// errors flowing back as receipts and the turn running — what the model cannot
// see is that it is REPEATING a failure. This projection generalizes the
// exec-only `projectRecentExecFailures` idea across tool families: identical
// failures are grouped by tool name + normalized failure kind + digest-stable
// argument identity, derived from committed `tool.result.recorded` receipts on
// the tape (replay-consistent — never in-memory counters). Evidence only: no
// retry orchestration, no auto-remediation, no posture change.

/** Same per-projection scan bound the exec-failure observability path uses. */
export const FAILURE_RECURRENCE_SCAN_LIMIT = 100;

/** A group is decision-relevant only once the identical failure recurred. */
export const FAILURE_RECURRENCE_THRESHOLD = 2;

const RENDERED_GROUP_LIMIT = 2;
const LAST_VARIANT_MAX_CHARS = 90;

export interface FailureRecurrenceGroup {
  readonly toolName: string;
  readonly failureKind: string;
  /** Digest of the recorded args, or null when the receipts carried no args. */
  readonly argsDigest: string | null;
  readonly count: number;
  /** Distilled output text of the most recent occurrence, if any. */
  readonly lastVariant: string | null;
  readonly lastTimestamp: number;
}

export interface FailureRecurrenceProjection {
  /** Recurred groups (count >= threshold), most-repeated first, then most recent. */
  readonly groups: readonly FailureRecurrenceGroup[];
}

function readArgsDigest(args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  try {
    return computeToolCallArgsDigest(args as Record<string, unknown>);
  } catch {
    // Non-canonical args degrade to "identity unknown" — a projection must
    // never break the turn prelude the brief renders inside.
    return null;
  }
}

function readVariant(outputText: unknown): string | null {
  if (typeof outputText !== "string") return null;
  // Double quotes delimit the variant in the rendered line, so tool output
  // must not be able to close the quote and impersonate brief syntax.
  const compact = compactWhitespace(outputText).replaceAll('"', "'");
  if (!compact) return null;
  return truncateText(compact, LAST_VARIANT_MAX_CHARS, { marker: "…" });
}

export function projectFailureRecurrence(
  events: readonly BrewvaEventRecord[],
): FailureRecurrenceProjection {
  const groups = new Map<
    string,
    {
      toolName: string;
      failureKind: string;
      argsDigest: string | null;
      count: number;
      lastVariant: string | null;
      lastTimestamp: number;
    }
  >();
  for (const event of events) {
    if (event.type !== TOOL_RESULT_RECORDED_EVENT_TYPE) continue;
    const payload = readToolResultRecordedEventPayload(event);
    if (!payload || typeof payload.toolName !== "string" || payload.toolName.length === 0) {
      continue;
    }
    if (payload.verdict === "pass") {
      // A success resets the recurrence evidence for that tool: a stale "you
      // keep failing" claim after a fix would steer the model away from a
      // working call. Events arrive in tape order, so deleting here leaves
      // exactly the failures newer than the tool's most recent pass.
      for (const [key, group] of groups) {
        if (group.toolName === payload.toolName) {
          groups.delete(key);
        }
      }
      continue;
    }
    if (payload.verdict !== "fail") continue;
    const failureKind =
      typeof payload.failureClass === "string" && payload.failureClass.trim().length > 0
        ? payload.failureClass.trim()
        : "unclassified_failure";
    const args =
      payload.failureContext && typeof payload.failureContext === "object"
        ? payload.failureContext.args
        : undefined;
    const argsDigest = readArgsDigest(args);
    // JSON-encoded key: failureKind is a free payload string, so naive
    // concatenation could collide across fields (verification-diagnostics
    // precedent).
    const key = JSON.stringify([payload.toolName, failureKind, argsDigest]);
    const timestamp = typeof event.timestamp === "number" ? event.timestamp : 0;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (timestamp >= existing.lastTimestamp) {
        existing.lastTimestamp = timestamp;
        existing.lastVariant =
          readVariant(payload.failureContext?.outputText) ?? existing.lastVariant;
      }
    } else {
      groups.set(key, {
        toolName: payload.toolName,
        failureKind,
        argsDigest,
        count: 1,
        lastVariant: readVariant(payload.failureContext?.outputText),
        lastTimestamp: timestamp,
      });
    }
  }
  return {
    groups: [...groups.values()]
      .filter((group) => group.count >= FAILURE_RECURRENCE_THRESHOLD)
      .toSorted(
        (left, right) =>
          right.count - left.count ||
          right.lastTimestamp - left.lastTimestamp ||
          left.toolName.localeCompare(right.toolName),
      ),
  };
}

/**
 * One relevance-gated `[RuntimeBrief]` section under the existing legibility
 * contract: silent below the recurrence threshold; when present it states the
 * count and the last variant so the model can choose to change approach. It
 * never instructs — evidence, not orchestration.
 */
export function renderFailureRecurrenceSection(
  projection: FailureRecurrenceProjection,
): RuntimeBriefSection | null {
  if (projection.groups.length === 0) {
    return null;
  }
  const rendered = projection.groups.slice(0, RENDERED_GROUP_LIMIT).map((group) => {
    // "identical args" is claimed only when the receipts actually recorded
    // argument identity; the quoted variant keeps tool output from
    // impersonating brief syntax.
    const identity = group.argsDigest !== null ? "identical args" : "(args unrecorded)";
    const variant = group.lastVariant ? `; last: "${group.lastVariant}"` : "";
    return `${group.toolName} (${group.failureKind}) ×${group.count} ${identity}${variant}`;
  });
  const overflow = projection.groups.length - RENDERED_GROUP_LIMIT;
  const suffix = overflow > 0 ? ` (+${overflow} more)` : "";
  return {
    key: "repeat-failures",
    salience: "normal",
    line: `repeat-failures: ${rendered.join(" | ")}${suffix}`,
    stub: `repeat-failures: ${projection.groups.length} repeated`,
  };
}

/**
 * Session-scoped wiring: read the recent committed tool receipts from the tape
 * and project recurrence. Strictly in-session — cross-session precedent stays
 * with the reversible-references RDP path.
 */
export function buildFailureRecurrenceSection(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
): RuntimeBriefSection | null {
  const events = queryRuntimeEvents(runtime, sessionId, {
    type: TOOL_RESULT_RECORDED_EVENT_TYPE,
    last: FAILURE_RECURRENCE_SCAN_LIMIT,
  });
  return renderFailureRecurrenceSection(projectFailureRecurrence(events));
}
