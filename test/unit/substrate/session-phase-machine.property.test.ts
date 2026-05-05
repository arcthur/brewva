import { describe, expect } from "bun:test";
import {
  SESSION_CRASH_POINTS,
  SESSION_PHASE_KINDS,
  SESSION_TERMINATION_REASONS,
  advanceSessionPhaseResult,
  canTransitionSessionPhase,
  type SessionPhase,
  type SessionPhaseEvent,
} from "@brewva/brewva-substrate/session";
import fc from "fast-check";
import invalidTransitionFixture from "../../fixtures/property-counterexamples/session-phase-machine.invalid-transition.json" with { type: "json" };
import { propertyTest } from "../../helpers/property.js";

const boundedIdArbitrary = fc.string({ minLength: 1, maxLength: 24 });
const turnArbitrary = fc.integer({ min: 0, max: 1_000 });
const sessionCrashPointArbitrary = fc.constantFrom(...SESSION_CRASH_POINTS);
const sessionTerminationReasonArbitrary = fc.constantFrom(...SESSION_TERMINATION_REASONS);

const sessionPhaseArbitrary: fc.Arbitrary<SessionPhase> = fc.oneof(
  fc.constant({ kind: "idle" } as const),
  fc.record({
    kind: fc.constant("model_streaming" as const),
    modelCallId: boundedIdArbitrary,
    turn: turnArbitrary,
  }),
  fc.record({
    kind: fc.constant("tool_executing" as const),
    toolCallId: boundedIdArbitrary,
    toolName: boundedIdArbitrary,
    turn: turnArbitrary,
  }),
  fc.record({
    kind: fc.constant("waiting_approval" as const),
    requestId: boundedIdArbitrary,
    toolCallId: boundedIdArbitrary,
    toolName: boundedIdArbitrary,
    turn: turnArbitrary,
  }),
  fc.record({
    kind: fc.constant("recovering" as const),
    recoveryAnchor: fc.option(boundedIdArbitrary, { nil: undefined }),
    turn: turnArbitrary,
  }),
  fc.record({
    kind: fc.constant("crashed" as const),
    crashAt: sessionCrashPointArbitrary,
    turn: turnArbitrary,
    modelCallId: fc.option(boundedIdArbitrary, { nil: undefined }),
    toolCallId: fc.option(boundedIdArbitrary, { nil: undefined }),
    recoveryAnchor: fc.option(boundedIdArbitrary, { nil: undefined }),
  }),
  fc.record({
    kind: fc.constant("terminated" as const),
    reason: sessionTerminationReasonArbitrary,
  }),
);

const sessionPhaseEventArbitrary: fc.Arbitrary<SessionPhaseEvent> = fc.oneof(
  fc.record({
    type: fc.constant("start_model_stream" as const),
    modelCallId: boundedIdArbitrary,
    turn: turnArbitrary,
  }),
  fc.constant({ type: "finish_model_stream" } as const),
  fc.record({
    type: fc.constant("start_tool_execution" as const),
    toolCallId: boundedIdArbitrary,
    toolName: boundedIdArbitrary,
    turn: turnArbitrary,
  }),
  fc.constant({ type: "finish_tool_execution" } as const),
  fc.record({
    type: fc.constant("wait_for_approval" as const),
    requestId: boundedIdArbitrary,
  }),
  fc.constant({ type: "approval_resolved" } as const),
  fc.record({
    type: fc.constant("crash" as const),
    crashAt: sessionCrashPointArbitrary,
    turn: fc.option(turnArbitrary, { nil: undefined }),
    recoveryAnchor: fc.option(boundedIdArbitrary, { nil: undefined }),
    modelCallId: fc.option(boundedIdArbitrary, { nil: undefined }),
    toolCallId: fc.option(boundedIdArbitrary, { nil: undefined }),
  }),
  fc.constant({ type: "resume" } as const),
  fc.constant({ type: "finish_recovery" } as const),
  fc.record({
    type: fc.constant("terminate" as const),
    reason: sessionTerminationReasonArbitrary,
  }),
);

function clonePhase(phase: SessionPhase): SessionPhase {
  return structuredClone(phase);
}

function fixtureExamples(): Array<[SessionPhase, SessionPhaseEvent]> {
  return invalidTransitionFixture.examples as Array<[SessionPhase, SessionPhaseEvent]>;
}

describe("substrate session phase machine properties", () => {
  propertyTest("canTransition mirrors transition result", {
    propertyId: "substrate.session-phase.can-transition-mirror",
    layer: "unit",
    arbitraries: [sessionPhaseArbitrary, sessionPhaseEventArbitrary],
    predicate: (phase, event) => {
      expect(canTransitionSessionPhase(phase, event)).toBe(
        advanceSessionPhaseResult(phase, event).ok,
      );
    },
  });

  propertyTest("invalid transitions do not mutate phase and return canonical error", {
    propertyId: "substrate.session-phase.invalid-transition-shape",
    layer: "unit",
    arbitraries: [sessionPhaseArbitrary, sessionPhaseEventArbitrary],
    examples: fixtureExamples(),
    predicate: (phase, event) => {
      const before = clonePhase(phase);
      const result = advanceSessionPhaseResult(phase, event);

      expect(phase).toEqual(before);
      if (!result.ok) {
        expect(result).toEqual({ ok: false, error: "invalid session phase transition" });
      }
    },
  });

  propertyTest("terminal phase rejects crash and terminate transitions", {
    propertyId: "substrate.session-phase.terminal-is-closed",
    layer: "unit",
    arbitraries: [sessionTerminationReasonArbitrary, sessionPhaseEventArbitrary],
    predicate: (reason, event) => {
      const phase: SessionPhase = { kind: "terminated", reason };
      const result = advanceSessionPhaseResult(phase, event);

      if (event.type === "crash" || event.type === "terminate") {
        expect(result.ok).toBe(false);
      }
    },
  });

  propertyTest("resume and finish recovery are accepted only from recovery phases", {
    propertyId: "substrate.session-phase.recovery-transition-gates",
    layer: "unit",
    arbitraries: [sessionPhaseArbitrary],
    predicate: (phase) => {
      expect(advanceSessionPhaseResult(phase, { type: "resume" }).ok).toBe(
        phase.kind === "crashed",
      );
      expect(advanceSessionPhaseResult(phase, { type: "finish_recovery" }).ok).toBe(
        phase.kind === "recovering",
      );
    },
  });

  propertyTest("valid event folds always produce known phase kinds", {
    propertyId: "substrate.session-phase.fold-known-kinds",
    layer: "unit",
    arbitraries: [fc.array(sessionPhaseEventArbitrary, { maxLength: 20 })],
    predicate: (events) => {
      let phase: SessionPhase = { kind: "idle" };

      for (const event of events) {
        const result = advanceSessionPhaseResult(phase, event);
        if (result.ok) {
          phase = result.phase;
          expect(SESSION_PHASE_KINDS).toContain(phase.kind);
        }
      }
    },
  });
});
