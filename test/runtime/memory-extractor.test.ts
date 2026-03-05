import { describe, expect, test } from "bun:test";
import {
  TASK_EVENT_TYPE,
  TRUTH_EVENT_TYPE,
  extractMemoryFromEvent,
  type BrewvaEventRecord,
} from "@brewva/brewva-runtime";

function event(input: {
  id: string;
  type: string;
  sessionId?: string;
  timestamp?: number;
  payload?: Record<string, unknown>;
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: input.sessionId ?? "mem-extractor-session",
    type: input.type,
    timestamp: input.timestamp ?? 1_700_000_000_000,
    payload: input.payload as BrewvaEventRecord["payload"],
  };
}

describe("memory extractor", () => {
  test("extracts truth upsert into deterministic memory unit candidate", () => {
    const result = extractMemoryFromEvent(
      event({
        id: "evt-truth-upsert",
        type: TRUTH_EVENT_TYPE,
        payload: {
          schema: "brewva.truth.ledger.v1",
          kind: "fact_upserted",
          fact: {
            id: "truth:command:1",
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
    expect(result.upserts[0]?.type).toBe("risk");
    expect(result.upserts[0]?.metadata?.truthFactId).toBe("truth:command:1");
    expect(result.resolves).toHaveLength(0);
  });

  test("extracts spec_set into goal decision + constraint units", () => {
    const result = extractMemoryFromEvent(
      event({
        id: "evt-task-spec-set",
        type: TASK_EVENT_TYPE,
        payload: {
          schema: "brewva.task.ledger.v1",
          kind: "spec_set",
          spec: {
            schema: "brewva.task.v1",
            goal: "Ship governance kernel runtime",
            constraints: ["No backward compatibility."],
            verification: {
              level: "standard",
              commands: ["bun test"],
            },
          },
        },
      }),
    );

    const statements = result.upserts.map((unit) => unit.statement);
    expect(statements).toContain("Ship governance kernel runtime");
    expect(statements).toContain("No backward compatibility.");
    expect(statements).toContain("verification.level=standard");
    expect(statements).toContain("verification.commands=bun test");
  });

  test("extracts blocker_recorded into risk unit candidate", () => {
    const result = extractMemoryFromEvent(
      event({
        id: "evt-task-blocker-recorded",
        type: TASK_EVENT_TYPE,
        payload: {
          schema: "brewva.task.ledger.v1",
          kind: "blocker_recorded",
          blocker: {
            id: "blocker-1",
            message: "Verification is failing: bun test exits 1",
            truthFactId: "truth:verifier:tests",
          },
        },
      }),
    );

    expect(result.upserts).toHaveLength(1);
    expect(result.upserts[0]?.type).toBe("risk");
    expect(result.upserts[0]?.metadata?.taskBlockerId).toBe("blocker-1");
    expect(result.upserts[0]?.metadata?.truthFactId).toBe("truth:verifier:tests");
    expect(result.resolves).toHaveLength(0);
  });

  test("extracts task blocker_resolved into resolve directive", () => {
    const result = extractMemoryFromEvent(
      event({
        id: "evt-task-resolved",
        type: TASK_EVENT_TYPE,
        payload: {
          schema: "brewva.task.ledger.v1",
          kind: "blocker_resolved",
          blockerId: "blocker-1",
        },
      }),
    );

    expect(result.upserts).toHaveLength(0);
    expect(result.resolves).toEqual([
      {
        sessionId: "mem-extractor-session",
        sourceType: "task_blocker",
        sourceId: "blocker-1",
        resolvedAt: 1_700_000_000_000,
      },
    ]);
  });

  test("ignores task status_set events (task state is injected elsewhere)", () => {
    const result = extractMemoryFromEvent(
      event({
        id: "evt-task-status",
        type: TASK_EVENT_TYPE,
        payload: {
          schema: "brewva.task.ledger.v1",
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

  test("ignores non-projectable event types", () => {
    const result = extractMemoryFromEvent(
      event({
        id: "evt-non-projectable",
        type: "tool_call_result_recorded",
        payload: {
          schema: "brewva.ledger.tool_result.v1",
        },
      }),
    );

    expect(result.upserts).toHaveLength(0);
    expect(result.resolves).toHaveLength(0);
  });
});
