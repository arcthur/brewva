import { TOOL_COMMITTED_EVENT_TYPE } from "@brewva/brewva-vocabulary/tool-invocations";
import { toolFamily } from "./tool-family.js";
import type { SelfEvalRunMetrics, SelfEvalTapeEvent, SelfEvalTerminalOutcome } from "./types.js";

// Tape spellings are authoritative: there is no exported constant for these two
// lifecycle types, so the tape string IS the contract. Verified against a real
// hosted tape — runtime.suspended{cause:"approval_pending"} marks an approval
// pause, turn.ended{cause:"terminal_commit"} a clean end.
const TURN_STARTED_EVENT_TYPE = "turn.started" as const;
const TURN_ENDED_EVENT_TYPE = "turn.ended" as const;
const RUNTIME_SUSPENDED_EVENT_TYPE = "runtime.suspended" as const;
const APPROVAL_PENDING_CAUSE = "approval_pending" as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function committedToolName(event: SelfEvalTapeEvent): string | undefined {
  if (event.type !== TOOL_COMMITTED_EVENT_TYPE) return undefined;
  const payload = event.payload;
  if (!isRecord(payload) || !isRecord(payload.call)) return undefined;
  return readString(payload.call.toolName);
}

/**
 * The run's terminal state is its LAST lifecycle event. runtime.suspended
 * recurs mid-run for every approval pause, so "any suspension" is not the
 * signal — only a suspension left unresolved (no later turn.ended) means the run
 * ended waiting on a human. This is exactly the completed-vs-fail-closed-suspend
 * distinction Phase 1 turns on: a covered effect class auto-approves through to
 * a terminal_commit, an uncovered one fail-closed suspends and stays suspended.
 */
export function deriveTerminalOutcome(
  events: readonly SelfEvalTapeEvent[],
): SelfEvalTerminalOutcome {
  let terminal: SelfEvalTapeEvent | undefined;
  for (const event of events) {
    if (event.type === TURN_ENDED_EVENT_TYPE || event.type === RUNTIME_SUSPENDED_EVENT_TYPE) {
      terminal = event;
    }
  }
  if (!terminal) return "unknown";
  const payload = isRecord(terminal.payload) ? terminal.payload : undefined;
  if (terminal.type === RUNTIME_SUSPENDED_EVENT_TYPE) {
    // A suspend is the fail-closed signal only for approval_pending; any other
    // suspend cause is honestly incomplete, not guessed.
    const cause = payload ? readString(payload.cause) : undefined;
    return cause === APPROVAL_PENDING_CAUSE ? "suspended_for_approval" : "incomplete";
  }
  // turn.ended: `cause` is ALWAYS "terminal_commit" (type-constrained), so it is
  // NOT the completion signal — the optional `status` is. It is OMITTED on
  // success and present ("failed"/"cancelled") otherwise (turn/impl
  // commitTurnEnded), so absent-or-"completed" means completed.
  const status = payload ? readString(payload.status) : undefined;
  return status === undefined || status === "completed" ? "completed" : "incomplete";
}

/**
 * Frozen self-eval evaluator (D6): pure, deterministic per-run metric extraction
 * from a single run's committed tape. Determinism given the same events IS the
 * repeatability gate — no structural field depends on wall-clock, live-run
 * nondeterminism, or anything beyond tape order.
 *
 * Reads only committed evidence (tool.committed = "a tool actually ran", the
 * same signal analyze:advisory-receipts scores), never tool.proposed/started,
 * so the profile reflects exercised surface rather than intent.
 */
export function extractSelfEvalRunMetrics(
  events: readonly SelfEvalTapeEvent[],
): SelfEvalRunMetrics {
  const distinct = new Set<string>();
  const perFamily = new Map<string, number>();
  let toolCallCount = 0;
  let turnCount = 0;

  for (const event of events) {
    if (event.type === TURN_STARTED_EVENT_TYPE) {
      turnCount += 1;
      continue;
    }
    const toolName = committedToolName(event);
    if (!toolName) continue;
    toolCallCount += 1;
    distinct.add(toolName);
    const family = toolFamily(toolName);
    perFamily.set(family, (perFamily.get(family) ?? 0) + 1);
  }

  return {
    distinctTools: [...distinct].toSorted((left, right) => left.localeCompare(right)),
    distinctToolCount: distinct.size,
    perFamilyCounts: Object.fromEntries(
      [...perFamily.entries()].toSorted((left, right) => left[0].localeCompare(right[0])),
    ),
    toolCallCount,
    turnCount,
    terminalOutcome: deriveTerminalOutcome(events),
  };
}
