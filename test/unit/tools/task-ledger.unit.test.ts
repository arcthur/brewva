import { describe, expect, test } from "bun:test";
import { createTaskLedgerTools } from "@brewva/brewva-tools/workflow";
import {
  TASK_REQUIREMENT_RECORDED_EVENT_TYPE,
  type RequirementAtom,
} from "@brewva/brewva-vocabulary/task";
import { createBundledToolRuntime, createRuntimeFixture } from "../../helpers/runtime.js";

const toolContext = (sessionId: string) =>
  ({
    sessionManager: {
      getSessionId: () => sessionId,
    },
  }) as never;

describe("task_set_spec requirement-atom producer", () => {
  test("mints req-<n> ids for new requirement entries, in call order, with provenance prompt", async () => {
    const runtime = createRuntimeFixture();
    const [taskSetSpec] = createTaskLedgerTools({ runtime: createBundledToolRuntime(runtime) });
    const sessionId = "task-set-spec-requirements-mint-1";

    const result = await taskSetSpec!.execute(
      "tool-1",
      {
        goal: "Ship the feature",
        requirements: [
          { statement: "Handles empty input", modality: "must" },
          { statement: "Renders within 100ms", modality: "should" },
        ],
      },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(result.outcome.kind).toBe("ok");
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
      "2 requirement atoms recorded",
    );

    const state = runtime.ops.task.state.get(sessionId);
    expect(state.requirements).toEqual([
      { id: "req-1", statement: "Handles empty input", modality: "must", provenance: "prompt" },
      { id: "req-2", statement: "Renders within 100ms", modality: "should", provenance: "prompt" },
    ]);

    const events = runtime.ops.events.records.query(sessionId, {
      type: TASK_REQUIREMENT_RECORDED_EVENT_TYPE,
    });
    expect(events).toHaveLength(2);
    expect(events.map((event) => (event.payload as { atom: RequirementAtom }).atom)).toEqual([
      { id: "req-1", statement: "Handles empty input", modality: "must", provenance: "prompt" },
      { id: "req-2", statement: "Renders within 100ms", modality: "should", provenance: "prompt" },
    ]);
  });

  test("amends an atom in place when the statement exactly matches an existing folded atom", async () => {
    const runtime = createRuntimeFixture();
    const [taskSetSpec] = createTaskLedgerTools({ runtime: createBundledToolRuntime(runtime) });
    const sessionId = "task-set-spec-requirements-amend-1";

    await taskSetSpec!.execute(
      "tool-1",
      {
        goal: "Ship the feature",
        requirements: [{ statement: "Handles empty input", modality: "should" }],
      },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    // Same statement, different modality, in a later call -> amends req-1 in
    // place (same id) rather than minting req-2.
    const amendResult = await taskSetSpec!.execute(
      "tool-2",
      {
        goal: "Ship the feature",
        requirements: [
          { statement: "Handles empty input", modality: "must" },
          { statement: "Logs errors", modality: "nice" },
        ],
      },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(amendResult.outcome.kind).toBe("ok");
    const amendText = amendResult.content[0]?.type === "text" ? amendResult.content[0].text : "";
    expect(amendText).toContain("2 requirement atoms recorded");
    expect(amendText).toContain("1 amended");

    const state = runtime.ops.task.state.get(sessionId);
    expect(state.requirements).toEqual([
      { id: "req-1", statement: "Handles empty input", modality: "must", provenance: "prompt" },
      { id: "req-2", statement: "Logs errors", modality: "nice", provenance: "prompt" },
    ]);
  });

  test("dedupes repeated statements within a single call: the second entry amends the first, no double mint", async () => {
    const runtime = createRuntimeFixture();
    const [taskSetSpec] = createTaskLedgerTools({ runtime: createBundledToolRuntime(runtime) });
    const sessionId = "task-set-spec-requirements-in-call-dedup-1";

    const result = await taskSetSpec!.execute(
      "tool-1",
      {
        goal: "Ship the feature",
        requirements: [
          { statement: "Handles empty input", modality: "should" },
          { statement: "Handles empty input", modality: "must" },
        ],
      },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(result.outcome.kind).toBe("ok");

    const state = runtime.ops.task.state.get(sessionId);
    // Only one atom exists: the second entry (same statement) amended the
    // atom minted by the first entry within the same call, so there is no
    // req-2 and the final modality is the last one seen ("must").
    expect(state.requirements).toEqual([
      { id: "req-1", statement: "Handles empty input", modality: "must", provenance: "prompt" },
    ]);
  });

  test("omitting requirements records the spec with no requirement atoms and no mention in result text", async () => {
    const runtime = createRuntimeFixture();
    const [taskSetSpec] = createTaskLedgerTools({ runtime: createBundledToolRuntime(runtime) });
    const sessionId = "task-set-spec-requirements-omitted-1";

    const result = await taskSetSpec!.execute(
      "tool-1",
      { goal: "Ship the feature" },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(result.outcome.kind).toBe("ok");
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").not.toContain(
      "requirement atoms recorded",
    );

    const state = runtime.ops.task.state.get(sessionId);
    expect(state.requirements).toEqual([]);
  });

  test("an empty requirements array behaves the same as omitting it", async () => {
    const runtime = createRuntimeFixture();
    const [taskSetSpec] = createTaskLedgerTools({ runtime: createBundledToolRuntime(runtime) });
    const sessionId = "task-set-spec-requirements-empty-array-1";

    const result = await taskSetSpec!.execute(
      "tool-1",
      { goal: "Ship the feature", requirements: [] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(result.outcome.kind).toBe("ok");
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").not.toContain(
      "requirement atoms recorded",
    );
    expect(runtime.ops.task.state.get(sessionId).requirements).toEqual([]);
  });

  test("minting across calls derives the next id from the folded atom count, not a second counter", async () => {
    const runtime = createRuntimeFixture();
    const [taskSetSpec] = createTaskLedgerTools({ runtime: createBundledToolRuntime(runtime) });
    const sessionId = "task-set-spec-requirements-cross-call-mint-1";

    await taskSetSpec!.execute(
      "tool-1",
      { goal: "Ship the feature", requirements: [{ statement: "Req A", modality: "must" }] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    await taskSetSpec!.execute(
      "tool-2",
      { goal: "Ship the feature", requirements: [{ statement: "Req B", modality: "should" }] },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    const state = runtime.ops.task.state.get(sessionId);
    expect(state.requirements).toEqual([
      { id: "req-1", statement: "Req A", modality: "must", provenance: "prompt" },
      { id: "req-2", statement: "Req B", modality: "should", provenance: "prompt" },
    ]);
  });
});

describe("task_set_spec requirements validation (whole-call rejection)", () => {
  test("an invalid modality among otherwise-valid entries rejects the WHOLE call: no spec, no atoms, no events", async () => {
    const runtime = createRuntimeFixture();
    const [taskSetSpec] = createTaskLedgerTools({ runtime: createBundledToolRuntime(runtime) });
    const sessionId = "task-set-spec-requirements-invalid-modality-1";

    const result = await taskSetSpec!.execute(
      "tool-1",
      {
        goal: "Ship the feature",
        requirements: [
          { statement: "Handles empty input", modality: "must" },
          { statement: "Renders within 100ms", modality: "urgent" as never },
        ],
      },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("err");
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Renders within 100ms");
    expect(text).toContain("urgent");
    expect(text).toContain("must");
    expect(text).toContain("should");
    expect(text).toContain("nice");

    // No partial effect: neither the spec nor any requirement atom nor any
    // event was recorded for this call — an invalid entry rejects the whole
    // call rather than silently under-reporting one bad entry.
    const state = runtime.ops.task.state.get(sessionId);
    expect(state.requirements).toEqual([]);
    expect(state).not.toHaveProperty("spec");
    const events = runtime.ops.events.records.query(sessionId, {});
    expect(events).toHaveLength(0);
  });

  test("a non-string statement rejects the WHOLE call, naming the offending index", async () => {
    const runtime = createRuntimeFixture();
    const [taskSetSpec] = createTaskLedgerTools({ runtime: createBundledToolRuntime(runtime) });
    const sessionId = "task-set-spec-requirements-invalid-statement-1";

    const result = await taskSetSpec!.execute(
      "tool-1",
      {
        goal: "Ship the feature",
        requirements: [
          { statement: "Valid entry", modality: "must" },
          { statement: 42 as never, modality: "should" },
        ],
      },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("err");
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("requirements[1]");

    const state = runtime.ops.task.state.get(sessionId);
    expect(state.requirements).toEqual([]);
    expect(state).not.toHaveProperty("spec");
    const events = runtime.ops.events.records.query(sessionId, {});
    expect(events).toHaveLength(0);
  });

  test("a missing statement (undefined) rejects the WHOLE call", async () => {
    const runtime = createRuntimeFixture();
    const [taskSetSpec] = createTaskLedgerTools({ runtime: createBundledToolRuntime(runtime) });
    const sessionId = "task-set-spec-requirements-missing-statement-1";

    const result = await taskSetSpec!.execute(
      "tool-1",
      {
        goal: "Ship the feature",
        requirements: [{ modality: "must" } as never],
      },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("err");
    const state = runtime.ops.task.state.get(sessionId);
    expect(state.requirements).toEqual([]);
    expect(state).not.toHaveProperty("spec");
  });
});

describe("task_set_spec requirement-atom enrichment", () => {
  test("accepts all four enrichment fields on a requirement entry and threads them into the recorded atom", async () => {
    const runtime = createRuntimeFixture();
    const [taskSetSpec] = createTaskLedgerTools({ runtime: createBundledToolRuntime(runtime) });
    const sessionId = "task-set-spec-requirements-enrichment-full-1";

    const result = await taskSetSpec!.execute(
      "tool-1",
      {
        goal: "Ship the global hotkey feature",
        requirements: [
          {
            statement: "Must debounce the hotkey handler",
            modality: "must",
            riskClass: "runtime",
            observableSignals: ["no duplicate fires within 50ms"],
            verificationStrategy: "runtime_smoke: hold key, confirm single fire",
            runtimePrerequisites: ["Accessibility permission granted"],
          },
        ],
      },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(result.outcome.kind).toBe("ok");

    const state = runtime.ops.task.state.get(sessionId);
    expect(state.requirements).toEqual([
      {
        id: "req-1",
        statement: "Must debounce the hotkey handler",
        modality: "must",
        provenance: "prompt",
        riskClass: "runtime",
        observableSignals: ["no duplicate fires within 50ms"],
        verificationStrategy: "runtime_smoke: hold key, confirm single fire",
        runtimePrerequisites: ["Accessibility permission granted"],
      },
    ]);

    const events = runtime.ops.events.records.query(sessionId, {
      type: TASK_REQUIREMENT_RECORDED_EVENT_TYPE,
    });
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { atom: RequirementAtom }).atom).toEqual(state.requirements[0]!);
  });

  test("a bare entry with no enrichment fields records an atom identical to the pre-enrichment shape", async () => {
    const runtime = createRuntimeFixture();
    const [taskSetSpec] = createTaskLedgerTools({ runtime: createBundledToolRuntime(runtime) });
    const sessionId = "task-set-spec-requirements-enrichment-bare-1";

    await taskSetSpec!.execute(
      "tool-1",
      {
        goal: "Ship the feature",
        requirements: [{ statement: "Handles empty input", modality: "must" }],
      },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    const state = runtime.ops.task.state.get(sessionId);
    expect(state.requirements).toEqual([
      { id: "req-1", statement: "Handles empty input", modality: "must", provenance: "prompt" },
    ]);
    expect(state.requirements[0]).not.toHaveProperty("riskClass");
    expect(state.requirements[0]).not.toHaveProperty("observableSignals");
    expect(state.requirements[0]).not.toHaveProperty("verificationStrategy");
    expect(state.requirements[0]).not.toHaveProperty("runtimePrerequisites");
  });

  test("enrichment-by-amendment via the tool: a plain atom recorded in one call, enriched by the same statement in a later call, keeps its id", async () => {
    const runtime = createRuntimeFixture();
    const [taskSetSpec] = createTaskLedgerTools({ runtime: createBundledToolRuntime(runtime) });
    const sessionId = "task-set-spec-requirements-enrichment-amend-1";

    await taskSetSpec!.execute(
      "tool-1",
      {
        goal: "Ship the feature",
        requirements: [{ statement: "Must debounce the hotkey handler", modality: "must" }],
      },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    const amendResult = await taskSetSpec!.execute(
      "tool-2",
      {
        goal: "Ship the feature",
        requirements: [
          {
            statement: "Must debounce the hotkey handler",
            modality: "must",
            riskClass: "runtime",
            verificationStrategy: "runtime_smoke",
          },
        ],
      },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(amendResult.outcome.kind).toBe("ok");
    const amendText = amendResult.content[0]?.type === "text" ? amendResult.content[0].text : "";
    expect(amendText).toContain("1 amended");

    const state = runtime.ops.task.state.get(sessionId);
    expect(state.requirements).toEqual([
      {
        id: "req-1", // same id as the first, bare-atom call
        statement: "Must debounce the hotkey handler",
        modality: "must",
        provenance: "prompt",
        riskClass: "runtime",
        verificationStrategy: "runtime_smoke",
      },
    ]);
  });

  test("an unknown riskClass value rejects the whole call (schema-level enum validation), naming the offending index", async () => {
    const runtime = createRuntimeFixture();
    const [taskSetSpec] = createTaskLedgerTools({ runtime: createBundledToolRuntime(runtime) });
    const sessionId = "task-set-spec-requirements-enrichment-invalid-riskclass-1";

    const result = await taskSetSpec!.execute(
      "tool-1",
      {
        goal: "Ship the feature",
        requirements: [
          { statement: "Valid entry", modality: "must" },
          {
            statement: "Bad risk class entry",
            modality: "should",
            riskClass: "not-a-real-class" as never,
          },
        ],
      },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );

    expect(result.outcome.kind).toBe("err");
    const state = runtime.ops.task.state.get(sessionId);
    expect(state.requirements).toEqual([]);
    expect(state).not.toHaveProperty("spec");
  });

  test("non-array observableSignals/runtimePrerequisites entries coerce to omitted rather than rejecting the call", async () => {
    const runtime = createRuntimeFixture();
    const [taskSetSpec] = createTaskLedgerTools({ runtime: createBundledToolRuntime(runtime) });
    const sessionId = "task-set-spec-requirements-enrichment-coerce-1";

    const result = await taskSetSpec!.execute(
      "tool-1",
      {
        goal: "Ship the feature",
        requirements: [
          {
            statement: "Handles empty input",
            modality: "must",
            observableSignals: ["valid", 42, null, "also valid"] as never,
          },
        ],
      },
      undefined as never,
      undefined as never,
      toolContext(sessionId),
    );
    expect(result.outcome.kind).toBe("ok");

    const state = runtime.ops.task.state.get(sessionId);
    expect(state.requirements[0]?.observableSignals).toEqual(["valid", "also valid"]);
  });
});
