import { describe, expect, test } from "bun:test";
import {
  TASK_REQUIREMENT_RECORDED_EVENT_TYPE,
  type RequirementAtom,
} from "@brewva/brewva-vocabulary/task";
import { createOrientRequirementInjectionLifecycle } from "../../../../packages/brewva-gateway/src/hosted/internal/session/skills/orient-requirement-injection.js";
import { createRuntimeFixture } from "../../../helpers/runtime.js";

const EVENT_TAP_ATOM_STATEMENT = "Fn suppression must be keycode-scoped, not all .flagsChanged";

function ctxFor(sessionId: string) {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
    },
  } as never;
}

function beforeAgentStartEvent(input: { prompt: string; systemPrompt?: string }) {
  return {
    type: "before_agent_start" as const,
    prompt: input.prompt,
    parts: [],
    systemPrompt: input.systemPrompt ?? "",
  };
}

describe("orient-phase trap atom injection", () => {
  test("a matching prompt records the seed atom once, with provenance trap AND riskClass runtime (the min-grade cap source)", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "orient-injection-matching-prompt-1";
    const lifecycle = createOrientRequirementInjectionLifecycle(runtime);

    lifecycle.beforeAgentStart(
      beforeAgentStartEvent({ prompt: "Please add a global hotkey for Fn using an event tap." }),
      ctxFor(sessionId),
    );

    const state = runtime.ops.task.state.get(sessionId);
    expect(state.requirements).toEqual([
      {
        id: "req-1",
        statement: EVENT_TAP_ATOM_STATEMENT,
        modality: "must",
        provenance: "trap",
        riskClass: "runtime",
      },
    ]);

    const events = runtime.ops.events.records.query(sessionId, {
      type: TASK_REQUIREMENT_RECORDED_EVENT_TYPE,
    });
    expect(events).toHaveLength(1);
    const [recordedEvent] = events;
    expect(recordedEvent?.type).toBe(TASK_REQUIREMENT_RECORDED_EVENT_TYPE);
    expect((recordedEvent!.payload as { atom: RequirementAtom }).atom).toEqual({
      id: "req-1",
      statement: EVENT_TAP_ATOM_STATEMENT,
      modality: "must",
      provenance: "trap",
      // A-F2: the trap seeds the risk class, so the min-grade cap engages on the
      // automatic atom — a presence re-grep cannot satisfy this runtime-risk atom.
      riskClass: "runtime",
    });

    // No spec.set event was emitted: injection is atom-only, never spec-planed.
    const specEvents = runtime.ops.events.records.query(sessionId, { type: "task.spec.set" });
    expect(specEvents).toHaveLength(0);
  });

  test("idempotent across a second orient with the same prompt: no duplicate atom, no duplicate event", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "orient-injection-idempotent-1";
    const lifecycle = createOrientRequirementInjectionLifecycle(runtime);
    const event = beforeAgentStartEvent({ prompt: "install a global hotkey via CGEvent tap" });

    lifecycle.beforeAgentStart(event, ctxFor(sessionId));
    lifecycle.beforeAgentStart(event, ctxFor(sessionId));

    const state = runtime.ops.task.state.get(sessionId);
    expect(state.requirements).toEqual([
      {
        id: "req-1",
        statement: EVENT_TAP_ATOM_STATEMENT,
        modality: "must",
        provenance: "trap",
        riskClass: "runtime",
      },
    ]);

    const events = runtime.ops.events.records.query(sessionId, {
      type: TASK_REQUIREMENT_RECORDED_EVENT_TYPE,
    });
    expect(events).toHaveLength(1);
  });

  test("a non-matching prompt records nothing", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "orient-injection-non-matching-1";
    const lifecycle = createOrientRequirementInjectionLifecycle(runtime);

    lifecycle.beforeAgentStart(
      beforeAgentStartEvent({ prompt: "Summarize the recent discussion in this repo." }),
      ctxFor(sessionId),
    );

    const state = runtime.ops.task.state.get(sessionId);
    expect(state.requirements).toEqual([]);
    const events = runtime.ops.events.records.query(sessionId, {
      type: TASK_REQUIREMENT_RECORDED_EVENT_TYPE,
    });
    expect(events).toHaveLength(0);
  });

  test("a CJK needle in the prompt fires the seed atom", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "orient-injection-cjk-prompt-1";
    const lifecycle = createOrientRequirementInjectionLifecycle(runtime);

    lifecycle.beforeAgentStart(
      beforeAgentStartEvent({ prompt: "帮我实现全局快捷键监听，支持键盘监听" }),
      ctxFor(sessionId),
    );

    const state = runtime.ops.task.state.get(sessionId);
    expect(state.requirements).toEqual([
      {
        id: "req-1",
        statement: EVENT_TAP_ATOM_STATEMENT,
        modality: "must",
        provenance: "trap",
        riskClass: "runtime",
      },
    ]);
  });

  test("a task-spec goal (task_taxonomy input) matches even when the prompt itself does not", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "orient-injection-task-taxonomy-goal-1";
    // Author sets a spec whose GOAL names the domain concern, but this turn's
    // prompt text is generic ("continue"). The task_taxonomy input must still
    // fire from the folded spec goal, independent of the prompt.
    runtime.ops.task.spec.set(sessionId, {
      spec: { schema: "brewva.task.v1", goal: "Implement the global hotkey event tap handler" },
    });
    const lifecycle = createOrientRequirementInjectionLifecycle(runtime);

    lifecycle.beforeAgentStart(beforeAgentStartEvent({ prompt: "continue" }), ctxFor(sessionId));

    const state = runtime.ops.task.state.get(sessionId);
    expect(state.requirements).toEqual([
      {
        id: "req-1",
        statement: EVENT_TAP_ATOM_STATEMENT,
        modality: "must",
        provenance: "trap",
        riskClass: "runtime",
      },
    ]);
  });

  test("an atom whose statement is already on the ledger (author-declared via task_set_spec) is not re-recorded", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "orient-injection-already-declared-1";
    // The author already declared the exact same statement through the
    // task_set_spec producer path, with provenance "prompt" — the orient pass
    // must dedupe by statement across ALL provenances and mint nothing new.
    runtime.ops.task.spec.set(sessionId, {
      spec: { schema: "brewva.task.v1", goal: "Ship the feature" },
      requirements: [
        {
          id: "req-1",
          statement: EVENT_TAP_ATOM_STATEMENT,
          modality: "must",
          provenance: "prompt",
        },
      ],
    });
    const lifecycle = createOrientRequirementInjectionLifecycle(runtime);

    lifecycle.beforeAgentStart(
      beforeAgentStartEvent({ prompt: "add a global hotkey using an event tap" }),
      ctxFor(sessionId),
    );

    const state = runtime.ops.task.state.get(sessionId);
    // Still exactly one atom, still req-1, still provenance "prompt" (the
    // orient pass did not amend it, did not mint req-2, and did not flip
    // provenance to "trap" for an atom the author already owns).
    expect(state.requirements).toEqual([
      {
        id: "req-1",
        statement: EVENT_TAP_ATOM_STATEMENT,
        modality: "must",
        provenance: "prompt",
      },
    ]);
    const events = runtime.ops.events.records.query(sessionId, {
      type: TASK_REQUIREMENT_RECORDED_EVENT_TYPE,
    });
    // Exactly the one event from the task_set_spec producer call — orient
    // added zero more.
    expect(events).toHaveLength(1);
  });

  test("no prompt match and no task spec present: injection is a pure no-op (no events at all)", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "orient-injection-noop-1";
    const lifecycle = createOrientRequirementInjectionLifecycle(runtime);

    lifecycle.beforeAgentStart(
      beforeAgentStartEvent({ prompt: "What's the weather like today?" }),
      ctxFor(sessionId),
    );

    const events = runtime.ops.events.records.query(sessionId, {});
    expect(events).toHaveLength(0);
  });

  test("advisory only: the injection never returns a systemPrompt, message, or any gate/mutation result", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "orient-injection-advisory-only-1";
    const lifecycle = createOrientRequirementInjectionLifecycle(runtime);

    const result = lifecycle.beforeAgentStart(
      beforeAgentStartEvent({ prompt: "add a global hotkey using an event tap" }),
      ctxFor(sessionId),
    );

    // The atom lands on the ledger (visible via task_view_state / task.state.get)
    // and nothing else changes: no systemPrompt injection, no custom message,
    // no returned result object forcing a gate or skill.
    expect(result).toBe(undefined);
  });
});
