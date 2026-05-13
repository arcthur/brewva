import { describe, expect } from "bun:test";
import { BrewvaRuntime, createHostedRuntimePort } from "@brewva/brewva-runtime";
import type { SessionWireFrame } from "@brewva/brewva-runtime/session";
import fc from "fast-check";
import { propertyTest } from "../../helpers/property.js";
import { cleanupWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

interface GeneratedTurn {
  turnId: string;
  promptText: string;
  transitionReasons: Array<
    "output_budget_escalation" | "compaction_retry" | "provider_fallback_retry"
  >;
  commit?: {
    attemptId: string;
    assistantText: string;
    toolOutputs: Array<{
      toolCallId: string;
      toolName: string;
      text: string;
      isError: boolean;
    }>;
  };
}

const boundedTextArbitrary = fc.string({ maxLength: 48 });
const safeIdArbitrary = fc
  .tuple(
    fc.constantFrom("a", "b", "c", "d", "e"),
    fc.array(fc.constantFrom("a", "b", "c", "d", "e", "0", "1", "2", "_", "-"), {
      maxLength: 15,
    }),
  )
  .map(([head, tail]) => `${head}${tail.join("")}`);

const generatedTurnArbitrary: fc.Arbitrary<GeneratedTurn> = fc.record({
  turnId: safeIdArbitrary.map((value) => `turn-${value}`),
  promptText: boundedTextArbitrary,
  transitionReasons: fc.array(
    fc.constantFrom("output_budget_escalation", "compaction_retry", "provider_fallback_retry"),
    { maxLength: 3 },
  ),
  commit: fc.option(
    fc.record({
      attemptId: fc.integer({ min: 1, max: 8 }).map((value) => `attempt-${value}`),
      assistantText: boundedTextArbitrary,
      toolOutputs: fc.array(
        fc.record({
          toolCallId: safeIdArbitrary.map((value) => `tool-${value}`),
          toolName: safeIdArbitrary,
          text: boundedTextArbitrary,
          isError: fc.boolean(),
        }),
        { maxLength: 3 },
      ),
    }),
    { nil: undefined },
  ),
});

function createRuntimeFixture(): {
  runtime: BrewvaRuntime;
  dispose: () => void;
} {
  const workspace = createTestWorkspace("session-wire-property");
  return {
    runtime: new BrewvaRuntime({ cwd: workspace }),
    dispose: () => cleanupWorkspace(workspace),
  };
}

function recordGeneratedTurns(
  runtime: BrewvaRuntime,
  sessionId: string,
  turns: GeneratedTurn[],
): void {
  turns.forEach((turn, index) => {
    const timestamp = 1_700_000_000_000 + index * 100;
    createHostedRuntimePort(runtime).extensions.hosted.events.record({
      sessionId,
      type: "turn_input_recorded",
      turn: index,
      timestamp,
      payload: {
        turnId: turn.turnId,
        trigger: "user",
        promptText: turn.promptText,
      },
    });

    turn.transitionReasons.forEach((reason, transitionIndex) => {
      createHostedRuntimePort(runtime).extensions.hosted.events.record({
        sessionId,
        type: "session_turn_transition",
        turn: index,
        timestamp: timestamp + transitionIndex + 1,
        payload: {
          reason,
          status: "entered",
          sequence: transitionIndex + 1,
          family: reason === "output_budget_escalation" ? "output_budget" : "recovery",
          attempt: transitionIndex === 0 ? null : transitionIndex,
          sourceEventId: null,
          sourceEventType: null,
          error: null,
          breakerOpen: false,
          model: "openai/gpt-5.4",
        },
      });
    });

    if (turn.commit) {
      createHostedRuntimePort(runtime).extensions.hosted.events.record({
        sessionId,
        type: "turn_render_committed",
        turn: index,
        timestamp: timestamp + 50,
        payload: {
          turnId: turn.turnId,
          attemptId: turn.commit.attemptId,
          status: "completed",
          assistantText: turn.commit.assistantText,
          toolOutputs: turn.commit.toolOutputs.map((toolOutput) => ({
            toolCallId: toolOutput.toolCallId,
            toolName: toolOutput.toolName,
            verdict: toolOutput.isError ? "fail" : "pass",
            isError: toolOutput.isError,
            text: toolOutput.text,
            display: {
              summaryText: toolOutput.text,
              detailsText: toolOutput.text,
              rawText: toolOutput.text,
            },
          })),
        },
      });
    }
  });
}

function normalizeFrames(frames: SessionWireFrame[]): Array<Record<string, unknown>> {
  return frames.map((frame) => {
    const normalized = structuredClone(frame) as unknown as Record<string, unknown>;
    delete normalized.frameId;
    delete normalized.sourceEventId;
    return normalized;
  });
}

describe("runtime session wire properties", () => {
  propertyTest("session wire replay is deterministic for the same durable event sequence", {
    propertyId: "runtime.session-wire.deterministic-replay",
    layer: "contract",
    arbitraries: [fc.array(generatedTurnArbitrary, { minLength: 1, maxLength: 5 })],
    predicate: (turns) => {
      const sessionId = "session-wire-property";
      const first = createRuntimeFixture();
      const second = createRuntimeFixture();

      try {
        recordGeneratedTurns(first.runtime, sessionId, turns);
        recordGeneratedTurns(second.runtime, sessionId, turns);

        const firstFrames = first.runtime.inspect.sessionWire.query(sessionId);
        const secondFrames = second.runtime.inspect.sessionWire.query(sessionId);

        expect(normalizeFrames(firstFrames)).toEqual(normalizeFrames(secondFrames));
        expect(first.runtime.inspect.sessionWire.query(sessionId)).toEqual(firstFrames);
        expect(new Set(firstFrames.map((frame) => frame.frameId)).size).toBe(firstFrames.length);
        expect(firstFrames.every((frame) => frame.schema === "brewva.session-wire.v2")).toBe(true);
        expect(firstFrames.every((frame) => frame.source === "replay")).toBe(true);
        expect(firstFrames.every((frame) => frame.durability === "durable")).toBe(true);
      } finally {
        first.dispose();
        second.dispose();
      }
    },
  });

  propertyTest("committed turn replay does not synthesize standalone tool finished frames", {
    propertyId: "runtime.session-wire.no-standalone-tool-finished",
    layer: "contract",
    arbitraries: [
      fc.array(
        generatedTurnArbitrary.filter((turn) => (turn.commit?.toolOutputs.length ?? 0) > 0),
        { minLength: 1, maxLength: 3 },
      ),
    ],
    predicate: (turns) => {
      const fixture = createRuntimeFixture();
      const sessionId = "session-wire-tools-property";
      try {
        recordGeneratedTurns(fixture.runtime, sessionId, turns);

        const frames = fixture.runtime.inspect.sessionWire.query(sessionId);

        expect(frames.some((frame) => frame.type === "turn.committed")).toBe(true);
        expect(frames.find((frame) => frame.type === "tool.finished")).toBeUndefined();
      } finally {
        fixture.dispose();
      }
    },
  });
});
