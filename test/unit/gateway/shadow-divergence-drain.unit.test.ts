import { describe, expect, test } from "bun:test";
import type { BrewvaRuntime, KernelShadowEvidenceEntry } from "@brewva/brewva-runtime";
import { drainShadowDivergenceEvidence } from "../../../packages/brewva-gateway/src/hosted/internal/turn/shadow-divergence-drain.js";

interface RecordedAdvisory {
  readonly sessionId: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

function entry(input: {
  sequence: number;
  sessionId: string;
  toolCallId: string;
  realKind: "allow" | "block" | "defer";
  shadowKind?: "allow" | "block" | "defer";
  error?: string;
}): KernelShadowEvidenceEntry {
  return {
    id: `kernel-shadow:${input.sequence}`,
    sequence: input.sequence,
    timestamp: 1000 + input.sequence,
    mode: "shadow",
    stage: "tool.authority",
    interceptorId: "observation-shape-shadow/v1",
    sessionId: input.sessionId,
    toolCallId: input.toolCallId,
    toolName: "browser_get",
    real: { kind: input.realKind },
    ...(input.shadowKind ? { shadow: { kind: input.shadowKind } } : {}),
    ...(input.error ? { error: input.error } : {}),
  } as KernelShadowEvidenceEntry;
}

function fakeRuntime(state: {
  entries: KernelShadowEvidenceEntry[];
  evicted: number;
  recorded: RecordedAdvisory[];
}): BrewvaRuntime {
  return {
    kernel: {
      intercept: {
        evidence: {
          list: (query?: { sessionId?: string }) =>
            state.entries.filter(
              (candidate) => !query?.sessionId || candidate.sessionId === query.sessionId,
            ),
          evictedCount: () => state.evicted,
        },
      },
      recordAdvisoryEvent: (input: {
        sessionId: string;
        kind: string;
        payload: unknown;
        id?: string;
        timestamp?: number;
      }) => {
        state.recorded.push({
          sessionId: input.sessionId,
          kind: input.kind,
          payload: input.payload as Record<string, unknown>,
        });
        return {
          event: {
            id: input.id ?? `ev-${state.recorded.length}`,
            sessionId: input.sessionId,
            type: "custom",
            timestamp: input.timestamp ?? 0,
            payload: { namespace: "runtime.ops", kind: input.kind, payload: input.payload },
          },
        };
      },
    },
  } as unknown as BrewvaRuntime;
}

describe("shadow divergence drain", () => {
  test("emits an evidence-gap receipt when the ring buffer evicted entries", () => {
    const state = {
      entries: [] as KernelShadowEvidenceEntry[],
      evicted: 0,
      recorded: [] as RecordedAdvisory[],
    };
    const runtime = fakeRuntime(state);

    expect(drainShadowDivergenceEvidence(runtime, "sess")).toBe(0);
    expect(state.recorded).toHaveLength(0);

    state.evicted = 7;
    drainShadowDivergenceEvidence(runtime, "sess");
    expect(state.recorded).toHaveLength(1);
    expect(state.recorded[0]?.payload).toMatchObject({
      evidenceGap: true,
      evictedCount: 7,
      evictedSinceLastDrain: 7,
    });

    // No further gap receipts until the eviction counter advances again.
    drainShadowDivergenceEvidence(runtime, "sess");
    expect(state.recorded).toHaveLength(1);
    state.evicted = 9;
    drainShadowDivergenceEvidence(runtime, "sess");
    expect(state.recorded).toHaveLength(2);
    expect(state.recorded[1]?.payload).toMatchObject({ evictedSinceLastDrain: 2 });
  });

  test("every session records its own gap after a shared eviction (unattributable loss)", () => {
    const state = {
      entries: [] as KernelShadowEvidenceEntry[],
      evicted: 5,
      recorded: [] as RecordedAdvisory[],
    };
    const runtime = fakeRuntime(state);

    drainShadowDivergenceEvidence(runtime, "session-a");
    drainShadowDivergenceEvidence(runtime, "session-b");

    expect(state.recorded).toHaveLength(2);
    expect(state.recorded[0]).toMatchObject({
      sessionId: "session-a",
      payload: { evidenceGap: true, evictedCount: 5 },
    });
    expect(state.recorded[1]).toMatchObject({
      sessionId: "session-b",
      payload: { evidenceGap: true, evictedCount: 5 },
    });
    // Neither session re-records without a new eviction.
    drainShadowDivergenceEvidence(runtime, "session-a");
    drainShadowDivergenceEvidence(runtime, "session-b");
    expect(state.recorded).toHaveLength(2);
  });

  test("skips agreements and errored entries, persists divergences once", () => {
    const state = {
      entries: [
        entry({
          sequence: 0,
          sessionId: "sess",
          toolCallId: "c-agree",
          realKind: "defer",
          shadowKind: "defer",
        }),
        entry({
          sequence: 1,
          sessionId: "sess",
          toolCallId: "c-div",
          realKind: "defer",
          shadowKind: "allow",
        }),
        entry({
          sequence: 2,
          sessionId: "sess",
          toolCallId: "c-err",
          realKind: "defer",
          error: "boom",
        }),
      ],
      evicted: 0,
      recorded: [] as RecordedAdvisory[],
    };
    const runtime = fakeRuntime(state);

    expect(drainShadowDivergenceEvidence(runtime, "sess")).toBe(1);
    expect(state.recorded).toHaveLength(1);
    expect(state.recorded[0]?.payload).toMatchObject({ toolCallId: "c-div" });
    expect(drainShadowDivergenceEvidence(runtime, "sess")).toBe(0);
    expect(state.recorded).toHaveLength(1);
  });
});
