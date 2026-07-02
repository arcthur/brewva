import { describe, expect, test } from "bun:test";
import type { HostedRuntimeAdapterPort } from "@brewva/brewva-gateway/hosted";
import { buildShadowAdmissionProjection } from "../../../packages/brewva-cli/src/operator/inspect/shadow-admission.js";

interface FakeEvent {
  readonly id: string;
  readonly sessionId: string;
  readonly type: string;
  readonly timestamp: number;
  readonly payload?: Record<string, unknown>;
}

function runtimeWithEvents(events: readonly FakeEvent[]): HostedRuntimeAdapterPort {
  return {
    ops: {
      events: {
        records: {
          query: (_sessionId: string, query?: { type?: string }) =>
            events.filter((event) => !query?.type || event.type === query.type),
        },
      },
    },
  } as unknown as HostedRuntimeAdapterPort;
}

function divergenceEvent(input: {
  id: string;
  toolName: string;
  realKind: string;
  shadowKind: string;
  timestamp?: number;
  realReason?: string;
}): FakeEvent {
  return {
    id: input.id,
    sessionId: "sess",
    type: "kernel.shadow.divergence.recorded",
    timestamp: input.timestamp ?? 1,
    payload: {
      interceptorId: "observation-shape-shadow/v1",
      toolCallId: `call-${input.id}`,
      toolName: input.toolName,
      real: {
        kind: input.realKind,
        ...(input.realReason ? { reason: input.realReason } : {}),
      },
      shadow: { kind: input.shadowKind },
    },
  };
}

describe("shadow admission inspect projection (RFC R4 Phase 1)", () => {
  test("projects an empty report when no divergence receipts exist", () => {
    const projection = buildShadowAdmissionProjection(runtimeWithEvents([]), "sess");
    expect(projection).toEqual({
      sideEffectPolicy: "inspect_projection_only",
      totalDivergences: 0,
      wouldAllowWhereRealAsked: 0,
      unsafeAllowDivergences: 0,
      evidenceGaps: 0,
      groups: [],
    });
  });

  test("counts evidence gaps separately and dedupes retried receipts", () => {
    const duplicated = divergenceEvent({
      id: "dup",
      toolName: "browser_get",
      realKind: "defer",
      shadowKind: "allow",
      timestamp: 5,
    });
    const projection = buildShadowAdmissionProjection(
      runtimeWithEvents([
        duplicated,
        { ...duplicated, id: "dup-retry", timestamp: 6 },
        {
          id: "gap-1",
          sessionId: "sess",
          type: "kernel.shadow.divergence.recorded",
          timestamp: 7,
          payload: { evidenceGap: true, evictedCount: 12, evictedSinceLastDrain: 12 },
        },
      ]),
      "sess",
    );
    expect(projection.totalDivergences).toBe(1);
    expect(projection.evidenceGaps).toBe(1);
    expect(projection.groups).toHaveLength(1);
    expect(projection.groups[0]?.count).toBe(1);
  });

  test("shadow-stricter divergences are neither promotion candidates nor unsafe", () => {
    const projection = buildShadowAdmissionProjection(
      runtimeWithEvents([
        divergenceEvent({
          id: "s1",
          toolName: "read",
          realKind: "allow",
          shadowKind: "defer",
          timestamp: 1,
        }),
        divergenceEvent({
          id: "s2",
          toolName: "read",
          realKind: "allow",
          shadowKind: "defer",
          timestamp: 2,
        }),
      ]),
      "sess",
    );
    expect(projection.totalDivergences).toBe(2);
    expect(projection.wouldAllowWhereRealAsked).toBe(0);
    expect(projection.unsafeAllowDivergences).toBe(0);
    expect(projection.groups[0]).toMatchObject({ realKind: "allow", shadowKind: "defer" });
  });

  test("groups by tool and decision pair, counting promotion candidates", () => {
    const projection = buildShadowAdmissionProjection(
      runtimeWithEvents([
        divergenceEvent({
          id: "e1",
          toolName: "browser_snapshot",
          realKind: "defer",
          shadowKind: "allow",
          timestamp: 1,
        }),
        divergenceEvent({
          id: "e2",
          toolName: "browser_snapshot",
          realKind: "defer",
          shadowKind: "allow",
          timestamp: 2,
          realReason: "approval_required",
        }),
        divergenceEvent({
          id: "e3",
          toolName: "process",
          realKind: "block",
          shadowKind: "allow",
          timestamp: 3,
        }),
      ]),
      "sess",
    );

    expect(projection.totalDivergences).toBe(3);
    expect(projection.wouldAllowWhereRealAsked).toBe(2);
    expect(projection.unsafeAllowDivergences).toBe(1);
    expect(projection.groups).toHaveLength(2);
    expect(projection.groups[0]).toMatchObject({
      toolName: "browser_snapshot",
      realKind: "defer",
      shadowKind: "allow",
      count: 2,
      realReason: "approval_required",
      lastTimestamp: 2,
    });
    expect(projection.groups[1]).toMatchObject({
      toolName: "process",
      realKind: "block",
      shadowKind: "allow",
      count: 1,
    });
  });

  test("ignores malformed payloads and unrelated event types", () => {
    const projection = buildShadowAdmissionProjection(
      runtimeWithEvents([
        {
          id: "junk-1",
          sessionId: "sess",
          type: "kernel.shadow.divergence.recorded",
          timestamp: 1,
          payload: { toolName: "", real: { kind: "defer" } },
        },
        {
          id: "other",
          sessionId: "sess",
          type: "tool.result.recorded",
          timestamp: 2,
          payload: { toolName: "read" },
        },
      ]),
      "sess",
    );
    expect(projection.totalDivergences).toBe(0);
    expect(projection.groups).toEqual([]);
  });
});
