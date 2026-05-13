import { describe, expect, test } from "bun:test";
import { CLAIM_LEDGER_SCHEMA } from "@brewva/brewva-runtime/claim";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import { type BrewvaEventRecord } from "@brewva/brewva-runtime/events";
import {
  TASK_EVENT_TYPE,
  CLAIM_EVENT_TYPE,
  asBrewvaEventType,
} from "@brewva/brewva-runtime/events";
import { TASK_LEDGER_SCHEMA } from "@brewva/brewva-runtime/task";
import { extractProjectionFromEvent } from "../../../packages/brewva-runtime/src/domain/projection/extractor.js";

function event(input: {
  id: string;
  type: string;
  sessionId?: string;
  timestamp?: number;
  payload?: Record<string, unknown>;
}): BrewvaEventRecord {
  const timestamp = input.timestamp ?? 1_700_000_000_000;
  return {
    id: input.id,
    sessionId: asBrewvaSessionId(input.sessionId ?? "projection-extractor-session"),
    type: asBrewvaEventType(input.type),
    timestamp,
    payload: input.payload as BrewvaEventRecord["payload"],
  };
}

describe("projection extractor", () => {
  test("extracts claim upsert into deterministic projection unit candidate", () => {
    const result = extractProjectionFromEvent(
      event({
        id: "evt-claim-upsert",
        type: CLAIM_EVENT_TYPE,
        payload: {
          schema: CLAIM_LEDGER_SCHEMA,
          kind: "claim_upserted",
          claimId: "claim:command:1",
          claim: {
            id: "claim:command:1",
            kind: "command_failure",
            status: "active",
            severity: "error",
            summary: "command failed: bun test",
            evidenceIds: ["ev-1"],
            firstSeenAt: 1_700_000_000_000,
            lastSeenAt: 1_700_000_000_001,
          },
        },
      }),
    );

    expect(result.upserts).toHaveLength(1);
    expect(result.upserts[0]?.projectionKey).toBe("claim:claim:command:1");
    expect(result.upserts[0]?.label).toBe("claim.command_failure");
    expect(result.upserts[0]?.metadata?.claimId).toBe("claim:command:1");
    expect(result.resolves).toHaveLength(0);
  });

  test("extracts spec_set into source-backed task projection units", () => {
    const result = extractProjectionFromEvent(
      event({
        id: "evt-task-spec-set",
        type: TASK_EVENT_TYPE,
        payload: {
          schema: TASK_LEDGER_SCHEMA,
          kind: "spec_set",
          spec: {
            schema: "brewva.task.v1",
            goal: "Ship governance kernel runtime",
            constraints: ["No backward compatibility."],
            verification: {
              commands: ["bun test"],
            },
          },
        },
      }),
    );

    const statements = result.upserts.map((unit) => unit.statement);
    expect(statements).toContain("Ship governance kernel runtime");
    expect(statements).toContain("No backward compatibility.");
    expect(statements).toContain("bun test");
    expect(result.resolves).toEqual([
      {
        sessionId: "projection-extractor-session",
        sourceType: "projection_group",
        groupKey: "task_spec",
        keepProjectionKeys: [
          "task_spec.goal",
          "task_spec.constraint:no backward compatibility.",
          "task_spec.verification.command:bun test",
        ],
        resolvedAt: 1_700_000_000_000,
      },
    ]);
  });

  test("extracts blocker_recorded into risk unit candidate", () => {
    const result = extractProjectionFromEvent(
      event({
        id: "evt-task-blocker-recorded",
        type: TASK_EVENT_TYPE,
        payload: {
          schema: TASK_LEDGER_SCHEMA,
          kind: "blocker_recorded",
          blocker: {
            id: "blocker-1",
            message: "Verification is failing: bun test exits 1",
            claimId: "claim:verifier:tests",
          },
        },
      }),
    );

    expect(result.upserts).toHaveLength(1);
    expect(result.upserts[0]?.projectionKey).toBe("task_blocker:blocker-1");
    expect(result.upserts[0]?.label).toBe("task.blocker");
    expect(result.upserts[0]?.metadata?.taskBlockerId).toBe("blocker-1");
    expect(result.upserts[0]?.metadata?.claimId).toBe("claim:verifier:tests");
    expect(result.resolves).toHaveLength(0);
  });

  test("extracts task blocker_resolved into resolve directive", () => {
    const result = extractProjectionFromEvent(
      event({
        id: "evt-task-resolved",
        type: TASK_EVENT_TYPE,
        payload: {
          schema: TASK_LEDGER_SCHEMA,
          kind: "blocker_resolved",
          blockerId: "blocker-1",
        },
      }),
    );

    expect(result.upserts).toHaveLength(0);
    expect(result.resolves).toEqual([
      {
        sessionId: "projection-extractor-session",
        sourceType: "task_blocker",
        sourceId: "blocker-1",
        resolvedAt: 1_700_000_000_000,
      },
    ]);
  });

  test("ignores task status_set events (task state is injected elsewhere)", () => {
    const result = extractProjectionFromEvent(
      event({
        id: "evt-task-status",
        type: TASK_EVENT_TYPE,
        payload: {
          schema: TASK_LEDGER_SCHEMA,
          kind: "status_set",
          status: {
            phase: "execute",
            health: "ok",
            updatedAt: 1_700_000_000_500,
          },
        },
      }),
    );

    expect(result.upserts).toHaveLength(0);
    expect(result.resolves).toHaveLength(0);
  });

  test("extracts workflow verification candidate from verification outcome events", () => {
    const result = extractProjectionFromEvent(
      event({
        id: "evt-verify-workflow",
        type: "verification_outcome_recorded",
        payload: {
          outcome: "fail",
          level: "standard",
          failedChecks: ["tests"],
          evidenceFreshness: "fresh",
        },
      }),
    );

    expect(result.upserts).toHaveLength(1);
    expect(result.upserts[0]?.projectionKey).toBe("workflow_artifact:verification");
    expect(result.upserts[0]?.label).toBe("workflow.verification");
    expect(result.upserts[0]?.statement).toContain("state=blocked; freshness=fresh;");
    expect(result.upserts[0]?.metadata?.workflowState).toBe("blocked");
    expect(result.resolves).toHaveLength(0);
  });

  test("ignores non-projectable event types", () => {
    const result = extractProjectionFromEvent(
      event({
        id: "evt-non-projectable",
        type: "tool_call_result_recorded",
        payload: {
          schema: "brewva.inspect.ledger.tool_result.v1",
        },
      }),
    );

    expect(result.upserts).toHaveLength(0);
    expect(result.resolves).toHaveLength(0);
  });
});
