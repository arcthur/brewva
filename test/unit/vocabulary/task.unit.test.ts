import { describe, expect, test } from "bun:test";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import {
  foldTaskLedgerEvents,
  REQUIREMENT_MODALITIES,
  REQUIREMENT_PROVENANCES,
  REQUIREMENT_RISK_CLASSES,
  resolveRequirementAtoms,
  TASK_REQUIREMENT_RECORDED_EVENT_TYPE,
  type RequirementAtom,
} from "@brewva/brewva-vocabulary/task";

describe("requirement modality / provenance vocabulary", () => {
  test("pins the wire values", () => {
    expect(REQUIREMENT_MODALITIES).toEqual(["must", "should", "nice"]);
    expect(REQUIREMENT_PROVENANCES).toEqual(["prompt", "trap", "review"]);
  });
});

describe("REQUIREMENT_RISK_CLASSES vocabulary", () => {
  test("pins the wire values", () => {
    expect(REQUIREMENT_RISK_CLASSES).toEqual([
      "runtime",
      "security",
      "ux",
      "packaging",
      "architecture",
    ]);
  });
});

describe("TASK_REQUIREMENT_RECORDED_EVENT_TYPE", () => {
  test("pins the wire value", () => {
    expect(TASK_REQUIREMENT_RECORDED_EVENT_TYPE).toBe("task.requirement.recorded");
  });
});

function requirementEvent(input: {
  id: string;
  timestamp: number;
  atom: RequirementAtom;
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: "session-1",
    type: TASK_REQUIREMENT_RECORDED_EVENT_TYPE,
    timestamp: input.timestamp,
    // Wire payload shape is `{ atom }`, not the atom flattened (RFC
    // intent-realization loop Task 2 producer wiring).
    payload: { atom: input.atom },
  };
}

describe("foldTaskLedgerEvents — requirements fold", () => {
  test("mints a new requirement atom from a task.requirement.recorded event", () => {
    const atom: RequirementAtom = {
      id: "req-1",
      statement: "Must validate input.",
      modality: "must",
      provenance: "prompt",
    };
    const state = foldTaskLedgerEvents([requirementEvent({ id: "e1", timestamp: 1, atom })]);
    expect(state.requirements).toEqual([atom]);
  });

  test("a later event with the same id replaces the earlier atom (amendment), keeping first-appearance order", () => {
    const first: RequirementAtom = {
      id: "req-1",
      statement: "Must validate input.",
      modality: "must",
      provenance: "prompt",
    };
    const second: RequirementAtom = {
      id: "req-2",
      statement: "Should log errors.",
      modality: "should",
      provenance: "trap",
    };
    const amendedFirst: RequirementAtom = {
      id: "req-1",
      statement: "Must validate and sanitize input.",
      modality: "must",
      provenance: "review",
    };

    const state = foldTaskLedgerEvents([
      requirementEvent({ id: "e1", timestamp: 1, atom: first }),
      requirementEvent({ id: "e2", timestamp: 2, atom: second }),
      requirementEvent({ id: "e3", timestamp: 3, atom: amendedFirst }),
    ]);

    // Amendment replaces the content but first-appearance ORDER is preserved:
    // req-1 (amended) still comes before req-2.
    expect(state.requirements).toEqual([amendedFirst, second]);
  });

  test("multiple distinct atoms preserve first-appearance order", () => {
    const atoms: RequirementAtom[] = [
      { id: "req-a", statement: "A.", modality: "must", provenance: "prompt" },
      { id: "req-b", statement: "B.", modality: "nice", provenance: "review" },
      { id: "req-c", statement: "C.", modality: "should", provenance: "trap" },
    ];
    const state = foldTaskLedgerEvents(
      atoms.map((atom, index) => requirementEvent({ id: `e${index}`, timestamp: index, atom })),
    );
    expect(state.requirements).toEqual(atoms);
  });

  test("no requirement events yields an empty requirements array", () => {
    const state = foldTaskLedgerEvents([]);
    expect(state.requirements).toEqual([]);
  });

  test("requirements fold does not disturb unrelated fold state (existing lastEvent behavior)", () => {
    const atom: RequirementAtom = {
      id: "req-1",
      statement: "Must validate input.",
      modality: "must",
      provenance: "prompt",
    };
    const state = foldTaskLedgerEvents([requirementEvent({ id: "e1", timestamp: 1, atom })]);
    expect(state.requirements).toEqual([atom]);
    expect(state.items).toEqual([]);
    expect(state.blockers).toEqual([]);
  });

  test("a task.requirement.recorded event whose payload fails atom validation does not appear in requirements and does not throw", () => {
    const malformedEvent: BrewvaEventRecord = {
      id: "e1",
      sessionId: "session-1",
      type: TASK_REQUIREMENT_RECORDED_EVENT_TYPE,
      timestamp: 1,
      // `atom.id` is a number, not a string, so the internal atom guard
      // rejects it and the event falls through to generic handling instead
      // of folding into `requirements`.
      payload: { atom: { id: 1 } },
    };

    // No thrown error reaches this point (a throw here would fail the test
    // before the assertion below runs), and the fold falls through to
    // generic handling instead of adding a malformed atom to `requirements`.
    const state = foldTaskLedgerEvents([malformedEvent]);
    expect(state.requirements).toEqual([]);
  });

  test("folds an atom carrying full enrichment (riskClass, observableSignals, verificationStrategy, runtimePrerequisites)", () => {
    const atom: RequirementAtom = {
      id: "req-1",
      statement: "Must debounce the global hotkey handler.",
      modality: "must",
      provenance: "prompt",
      riskClass: "runtime",
      observableSignals: ["no duplicate fires within 50ms", "handler unregisters on app quit"],
      verificationStrategy: "runtime_smoke: hold the key and confirm a single fire",
      runtimePrerequisites: ["Accessibility permission granted"],
    };
    const state = foldTaskLedgerEvents([requirementEvent({ id: "e1", timestamp: 1, atom })]);
    expect(state.requirements).toEqual([atom]);
  });

  test("a bare core atom (no enrichment fields) still reads back identically — enrichment is purely additive", () => {
    const atom: RequirementAtom = {
      id: "req-1",
      statement: "Must validate input.",
      modality: "must",
      provenance: "prompt",
    };
    const state = foldTaskLedgerEvents([requirementEvent({ id: "e1", timestamp: 1, atom })]);
    expect(state.requirements).toEqual([atom]);
    expect(state.requirements[0]).not.toHaveProperty("riskClass");
    expect(state.requirements[0]).not.toHaveProperty("observableSignals");
    expect(state.requirements[0]).not.toHaveProperty("verificationStrategy");
    expect(state.requirements[0]).not.toHaveProperty("runtimePrerequisites");
  });

  test("an atom whose riskClass is malformed (unknown value) folds with riskClass omitted, not rejected outright", () => {
    const malformedEvent: BrewvaEventRecord = {
      id: "e1",
      sessionId: "session-1",
      type: TASK_REQUIREMENT_RECORDED_EVENT_TYPE,
      timestamp: 1,
      payload: {
        atom: {
          id: "req-1",
          statement: "Must validate input.",
          modality: "must",
          provenance: "prompt",
          riskClass: "not-a-real-risk-class",
          observableSignals: "not-an-array",
        },
      },
    };
    const state = foldTaskLedgerEvents([malformedEvent]);
    // Core fields still validate the atom (it is NOT rejected wholesale), but
    // the malformed enrichment fields coerce away instead of polluting state.
    expect(state.requirements).toEqual([
      { id: "req-1", statement: "Must validate input.", modality: "must", provenance: "prompt" },
    ]);
    expect(state.requirements[0]).not.toHaveProperty("riskClass");
    expect(state.requirements[0]).not.toHaveProperty("observableSignals");
  });

  test("non-array observableSignals/runtimePrerequisites coerce to omitted rather than throwing or rejecting the atom", () => {
    const malformedEvent: BrewvaEventRecord = {
      id: "e1",
      sessionId: "session-1",
      type: TASK_REQUIREMENT_RECORDED_EVENT_TYPE,
      timestamp: 1,
      payload: {
        atom: {
          id: "req-1",
          statement: "Must validate input.",
          modality: "must",
          provenance: "prompt",
          runtimePrerequisites: { not: "an array" },
        },
      },
    };
    const state = foldTaskLedgerEvents([malformedEvent]);
    expect(state.requirements).toHaveLength(1);
    expect(state.requirements[0]?.id).toBe("req-1");
    expect(state.requirements[0]).not.toHaveProperty("runtimePrerequisites");
  });

  test("a non-array entry inside observableSignals is filtered rather than rejecting the whole atom", () => {
    const malformedEvent: BrewvaEventRecord = {
      id: "e1",
      sessionId: "session-1",
      type: TASK_REQUIREMENT_RECORDED_EVENT_TYPE,
      timestamp: 1,
      payload: {
        atom: {
          id: "req-1",
          statement: "Must validate input.",
          modality: "must",
          provenance: "prompt",
          observableSignals: ["valid signal", 42, null, "another valid signal"],
        },
      },
    };
    const state = foldTaskLedgerEvents([malformedEvent]);
    expect(state.requirements[0]?.observableSignals).toEqual([
      "valid signal",
      "another valid signal",
    ]);
  });
});

describe("resolveRequirementAtoms — enrichment", () => {
  test("mints a new atom carrying enrichment fields from the incoming entry", () => {
    const resolved = resolveRequirementAtoms(
      [],
      [
        {
          statement: "Must debounce the hotkey handler.",
          modality: "must",
          provenance: "prompt",
          riskClass: "runtime",
          observableSignals: ["no duplicate fires"],
          verificationStrategy: "runtime_smoke",
          runtimePrerequisites: ["Accessibility permission"],
        },
      ],
    );
    expect(resolved.atoms).toEqual([
      {
        id: "req-1",
        statement: "Must debounce the hotkey handler.",
        modality: "must",
        provenance: "prompt",
        riskClass: "runtime",
        observableSignals: ["no duplicate fires"],
        verificationStrategy: "runtime_smoke",
        runtimePrerequisites: ["Accessibility permission"],
      },
    ]);
  });

  test("mints a new atom with no enrichment fields when the entry supplies none (additive, not required)", () => {
    const resolved = resolveRequirementAtoms(
      [],
      [{ statement: "Must validate input.", modality: "must", provenance: "prompt" }],
    );
    expect(resolved.atoms).toEqual([
      { id: "req-1", statement: "Must validate input.", modality: "must", provenance: "prompt" },
    ]);
    expect(resolved.atoms[0]).not.toHaveProperty("riskClass");
  });

  test("enrichment-by-amendment: a plain atom later amended (same statement) with enrichment keeps its id and gains the enrichment", () => {
    const minted = resolveRequirementAtoms(
      [],
      [{ statement: "Must debounce the hotkey handler.", modality: "must", provenance: "prompt" }],
    );
    expect(minted.atoms).toEqual([
      {
        id: "req-1",
        statement: "Must debounce the hotkey handler.",
        modality: "must",
        provenance: "prompt",
      },
    ]);

    const amended = resolveRequirementAtoms(minted.atoms, [
      {
        statement: "Must debounce the hotkey handler.",
        modality: "must",
        provenance: "prompt",
        riskClass: "runtime",
        observableSignals: ["no duplicate fires within 50ms"],
        verificationStrategy: "runtime_smoke",
        runtimePrerequisites: [],
      },
    ]);
    expect(amended.amendedCount).toBe(1);
    expect(amended.atoms).toEqual([
      {
        id: "req-1", // same id — enrichment amends in place, never re-mints
        statement: "Must debounce the hotkey handler.",
        modality: "must",
        provenance: "prompt", // provenance of an existing atom is never overwritten
        riskClass: "runtime",
        observableSignals: ["no duplicate fires within 50ms"],
        verificationStrategy: "runtime_smoke",
        runtimePrerequisites: [],
      },
    ]);
  });

  test("last-writer-wins per atom: a later amendment that OMITS a previously-enriched field drops that field from the merged atom", () => {
    const enrichedOnce = resolveRequirementAtoms(
      [],
      [
        {
          statement: "Must debounce the hotkey handler.",
          modality: "must",
          provenance: "prompt",
          riskClass: "runtime",
          observableSignals: ["no duplicate fires"],
          verificationStrategy: "runtime_smoke",
          runtimePrerequisites: ["Accessibility permission"],
        },
      ],
    );

    // The later event re-states the same statement but omits riskClass and
    // runtimePrerequisites entirely (not "clears" them, just doesn't mention
    // them) — per the stated rule, the merged atom reflects ONLY what the
    // newer event says: riskClass and runtimePrerequisites are dropped, not
    // carried over from the older atom.
    const reAmended = resolveRequirementAtoms(enrichedOnce.atoms, [
      {
        statement: "Must debounce the hotkey handler.",
        modality: "must",
        provenance: "prompt",
        observableSignals: ["single fire confirmed via runtime smoke"],
      },
    ]);

    expect(reAmended.atoms).toEqual([
      {
        id: "req-1",
        statement: "Must debounce the hotkey handler.",
        modality: "must",
        provenance: "prompt",
        observableSignals: ["single fire confirmed via runtime smoke"],
      },
    ]);
    expect(reAmended.atoms[0]).not.toHaveProperty("riskClass");
    expect(reAmended.atoms[0]).not.toHaveProperty("runtimePrerequisites");
    expect(reAmended.atoms[0]).not.toHaveProperty("verificationStrategy");
  });

  test("a review-minted atom later enriched by a same-statement entry keeps its provenance and id", () => {
    const reviewMinted = resolveRequirementAtoms(
      [],
      [{ statement: "Must sanitize user input.", modality: "must", provenance: "review" }],
    );
    expect(reviewMinted.atoms[0]?.provenance).toBe("review");

    const enriched = resolveRequirementAtoms(reviewMinted.atoms, [
      {
        statement: "Must sanitize user input.",
        modality: "must",
        provenance: "prompt",
        riskClass: "security",
        verificationStrategy: "requirements: re-derive sanitizer from code",
      },
    ]);
    expect(enriched.atoms).toEqual([
      {
        id: reviewMinted.atoms[0]!.id,
        statement: "Must sanitize user input.",
        modality: "must",
        provenance: "review", // origin never overwritten by a later amend
        riskClass: "security",
        verificationStrategy: "requirements: re-derive sanitizer from code",
      },
    ]);
  });
});
