import { buildClaimUpsertedEvent } from "@brewva/brewva-runtime/claim";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import {
  TASK_EVENT_TYPE,
  TAPE_CHECKPOINT_EVENT_TYPE,
  CLAIM_EVENT_TYPE,
} from "@brewva/brewva-runtime/events";
import type { BrewvaEventRecord } from "@brewva/brewva-runtime/events";
import { buildTapeCheckpointPayload } from "@brewva/brewva-runtime/tape";
import { buildItemAddedEvent } from "@brewva/brewva-runtime/task";
import type { TaskState } from "@brewva/brewva-runtime/task";

export function taskEvent(input: {
  sessionId: string;
  id: string;
  timestamp: number;
  text: string;
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: asBrewvaSessionId(input.sessionId),
    type: TASK_EVENT_TYPE,
    timestamp: input.timestamp,
    payload: buildItemAddedEvent({
      text: input.text,
      status: "todo",
    }) as BrewvaEventRecord["payload"],
  };
}

export function claimEvent(input: {
  sessionId: string;
  id: string;
  timestamp: number;
  factId: string;
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: asBrewvaSessionId(input.sessionId),
    type: CLAIM_EVENT_TYPE,
    timestamp: input.timestamp,
    payload: buildClaimUpsertedEvent({
      id: input.factId,
      kind: "test_fact",
      status: "active",
      severity: "warn",
      summary: "fact-summary",
      evidenceIds: ["led-1"],
      firstSeenAt: input.timestamp,
      lastSeenAt: input.timestamp,
    }) as unknown as BrewvaEventRecord["payload"],
  };
}

export function checkpointEvent(input: {
  sessionId: string;
  id: string;
  timestamp: number;
  taskState: TaskState;
  claimState: {
    claims: Array<{
      id: string;
      kind: string;
      status: "active" | "resolved";
      severity: "info" | "warn" | "error";
      summary: string;
      evidenceIds: string[];
      firstSeenAt: number;
      lastSeenAt: number;
      resolvedAt?: number;
    }>;
    updatedAt: number | null;
  };
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: asBrewvaSessionId(input.sessionId),
    type: TAPE_CHECKPOINT_EVENT_TYPE,
    timestamp: input.timestamp,
    payload: buildTapeCheckpointPayload({
      taskState: input.taskState,
      claimState: input.claimState,
      costSummary: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        models: {},
        skills: {},
        tools: {},
        alerts: [],
        budget: {
          action: "warn",
          sessionExceeded: false,
          blocked: false,
        },
      },
      evidenceState: {
        totalRecords: 0,
        failureRecords: 0,
        anchorEpoch: 0,
        recentFailures: [],
        failureClassCounts: {
          execution: 0,
          invocation_validation: 0,
          policy_denied: 0,
          shell_syntax: 0,
          script_composition: 0,
        },
      },
      projectionState: {
        updatedAt: null,
        unitCount: 0,
      },
      reason: "unit_test",
      basedOnEventId: "evt-prev",
    }) as unknown as BrewvaEventRecord["payload"],
  };
}

export function toolResultFailureEvent(input: {
  sessionId: string;
  id: string;
  timestamp: number;
  turn?: number;
  toolName: string;
  failureClass?:
    | "execution"
    | "invocation_validation"
    | "policy_denied"
    | "shell_syntax"
    | "script_composition";
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: asBrewvaSessionId(input.sessionId),
    type: "tool_result_recorded",
    timestamp: input.timestamp,
    turn: input.turn,
    payload: {
      toolName: input.toolName,
      verdict: "fail",
      channelSuccess: false,
      ledgerId: `ledger:${input.id}`,
      failureClass: input.failureClass ?? null,
      failureContext: {
        args: {
          command: "bun test",
        },
        outputText: "Error: failed",
        turn: input.turn ?? 0,
        failureClass: input.failureClass,
      },
    } as BrewvaEventRecord["payload"],
  };
}

export function anchorEvent(input: {
  sessionId: string;
  id: string;
  timestamp: number;
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: asBrewvaSessionId(input.sessionId),
    type: "anchor",
    timestamp: input.timestamp,
    payload: {
      schema: "brewva.tape.anchor.v1",
      name: "phase",
      createdAt: input.timestamp,
    } as BrewvaEventRecord["payload"],
  };
}
