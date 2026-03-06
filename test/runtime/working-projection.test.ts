import { describe, expect, test } from "bun:test";
import type { ProjectionUnit } from "../../packages/brewva-runtime/src/projection/types.js";
import { buildWorkingProjectionSnapshot } from "../../packages/brewva-runtime/src/projection/working-projection.js";

function unit(input: {
  id: string;
  projectionKey: string;
  label: string;
  statement: string;
  status?: ProjectionUnit["status"];
}): ProjectionUnit {
  const now = Date.now();
  return {
    id: input.id,
    sessionId: "session-1",
    status: input.status ?? "active",
    projectionKey: input.projectionKey,
    label: input.label,
    statement: input.statement,
    fingerprint: `fp-${input.id}`,
    sourceRefs: [
      {
        eventId: `evt-${input.id}`,
        eventType: "task_event",
        sessionId: "session-1",
        timestamp: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  };
}

describe("working projection snapshot", () => {
  test("builds ordered source-backed entries from active units", () => {
    const snapshot = buildWorkingProjectionSnapshot({
      sessionId: "session-1",
      units: [
        unit({
          id: "u1",
          projectionKey: "truth_fact:ci",
          label: "truth.command_failure",
          statement: "Current deployment is blocked by CI",
        }),
        unit({
          id: "u2",
          projectionKey: "task_spec.goal",
          label: "task.goal",
          statement: "Use Bun for all test workflows",
        }),
        unit({
          id: "u3",
          projectionKey: "task_spec.constraint:no-backward-compatibility",
          label: "task.constraint",
          statement: "No backward compatibility layer",
        }),
        unit({
          id: "u4",
          projectionKey: "resolved.old",
          label: "task.constraint",
          statement: "Obsolete resolved item",
          status: "resolved",
        }),
      ],
      maxChars: 2_000,
    });

    expect(snapshot.content.includes("[WorkingProjection]")).toBe(true);
    expect(snapshot.content.includes("task.goal: Use Bun for all test workflows")).toBe(true);
    expect(snapshot.content.includes("task.constraint: No backward compatibility layer")).toBe(
      true,
    );
    expect(snapshot.content.includes("Obsolete resolved item")).toBe(false);
    expect(snapshot.entries).toHaveLength(3);
    expect([...snapshot.sourceUnitIds].toSorted()).toEqual(["u1", "u2", "u3"]);
  });

  test("respects maxChars cap", () => {
    const snapshot = buildWorkingProjectionSnapshot({
      sessionId: "session-1",
      units: [
        unit({
          id: "u1",
          projectionKey: "truth_fact:long",
          label: "truth.long",
          statement: "a".repeat(2_000),
        }),
      ],
      maxChars: 220,
    });

    expect(snapshot.content.length).toBeLessThanOrEqual(220);
  });
});
