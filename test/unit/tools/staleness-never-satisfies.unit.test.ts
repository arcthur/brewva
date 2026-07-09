import { describe, expect, test } from "bun:test";
import { makeEvent } from "@brewva/brewva-vocabulary/events";
import { projectRequirementFitness } from "@brewva/brewva-vocabulary/fitness";
import { VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import type { ReviewTargetRef } from "@brewva/brewva-vocabulary/review";
import { TASK_REQUIREMENT_RECORDED_EVENT_TYPE } from "@brewva/brewva-vocabulary/task";
import { TOOL_COMMITTED_EVENT_TYPE } from "@brewva/brewva-vocabulary/tool-invocations";
import { SOURCE_PATCH_APPLIED_EVENT_TYPE } from "@brewva/brewva-vocabulary/workbench";
import { assembleRequirementFitnessInputFromEvents } from "../../../packages/brewva-tools/src/runtime-port/verification.js";

// STALENESS NEVER SATISFIES (rfc-independence-trust-conditions): the assembler's
// mirror of the projection's finding rule. An independent outcome feeds the join
// only while its targetRef still matches the tree, judged against the receipt's
// OWN timestamp (P1-A). Hand-built events pin the timestamp matrix
// deterministically — the runtime fixture cannot guarantee sub-millisecond
// ordering (same reasoning as the review-debt fold tests).

const SESSION = "staleness-never-satisfies";

function atomEvent(id: string, timestamp: number) {
  return makeEvent(
    TASK_REQUIREMENT_RECORDED_EVENT_TYPE,
    {
      sessionId: SESSION,
      atom: {
        id,
        statement: `statement ${id}`,
        modality: "must",
        provenance: "prompt",
        riskClass: "runtime",
      },
    },
    { timestamp, id: `atom-${id}` },
  );
}

function writeEvent(path: string, timestamp: number) {
  return makeEvent(
    TOOL_COMMITTED_EVENT_TYPE,
    {
      call: { sessionId: SESSION, toolName: "edit", args: { file_path: path } },
      result: { outcome: { kind: "ok" } },
    },
    { timestamp, id: `write-${path}-${timestamp}` },
  );
}

function patchAppliedEvent(patchSetId: string, timestamp: number) {
  return makeEvent(
    SOURCE_PATCH_APPLIED_EVENT_TYPE,
    {
      sessionId: SESSION,
      ok: true,
      planId: `plan-${patchSetId}`,
      patchSetId,
      appliedPaths: ["a.ts"],
      failedPaths: [],
    },
    { timestamp, id: `patch-${patchSetId}-${timestamp}` },
  );
}

function independentPassEvent(opts: {
  timestamp: number;
  atomRefs: readonly string[];
  targetRef: ReviewTargetRef | null;
  contextId?: string;
}) {
  return makeEvent(
    VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
    {
      sessionId: SESSION,
      outcome: "pass",
      level: "requirements",
      perspective: "independent",
      independenceBasis: ["fresh_context"],
      reviewerContext: { model: null, contextId: opts.contextId ?? "review-run-1", lenses: [] },
      ...(opts.targetRef ? { targetRef: opts.targetRef } : {}),
      atomRefs: [...opts.atomRefs],
    },
    { timestamp: opts.timestamp, id: `indep-${opts.timestamp}` },
  );
}

const FILE_REF: ReviewTargetRef = { kind: "file_digests", digests: { "a.ts": "sha-a" } };

function statesOf(events: ReturnType<typeof makeEvent>[]) {
  const projection = projectRequirementFitness(
    assembleRequirementFitnessInputFromEvents(events as never),
  );
  return {
    projection,
    state: (id: string) => projection.atoms.find((entry) => entry.atomId === id)?.state,
  };
}

describe("assembler mirror rule — STALENESS NEVER SATISFIES", () => {
  test("a FRESH independent CLEAR discharges the high-risk atom (no ceiling regression)", () => {
    const { state, projection } = statesOf([
      atomEvent("req-1", 100),
      writeEvent("a.ts", 200),
      // Receipt AFTER the last mutation -> file_digests fresh -> satisfied.
      independentPassEvent({ timestamp: 300, atomRefs: ["req-1"], targetRef: FILE_REF }),
    ]);
    expect(state("req-1")).toBe("satisfied");
    expect(projection.independenceDebtAtoms).toEqual([]);
  });

  test("a STALE independent CLEAR is dropped whole: the atom falls back and independence debt re-lights", () => {
    const { state, projection } = statesOf([
      atomEvent("req-1", 100),
      // CLEAR at t=200 attests the tree as of t=200...
      independentPassEvent({ timestamp: 200, atomRefs: ["req-1"], targetRef: FILE_REF }),
      // ...then the model rewrites the attested code at t=300 -> the CLEAR no
      // longer describes what ships. Without the mirror rule this atom would
      // stay `satisfied` forever (the false green the grade ceiling used to mask).
      writeEvent("a.ts", 300),
    ]);
    expect(state("req-1")).toBe("unverified");
    expect(projection.independenceDebtAtoms).toEqual(["req-1"]);
  });

  test("P1-A: each receipt is judged against ITS OWN timestamp — the post-mutation CLEAR survives, the pre-mutation one drops", () => {
    const { projection } = statesOf([
      atomEvent("req-1", 100),
      atomEvent("req-2", 100),
      independentPassEvent({
        timestamp: 200, // pre-mutation -> stale
        atomRefs: ["req-1"],
        targetRef: FILE_REF,
        contextId: "review-early",
      }),
      writeEvent("a.ts", 300),
      independentPassEvent({
        timestamp: 400, // post-mutation -> fresh
        atomRefs: ["req-2"],
        targetRef: FILE_REF,
        contextId: "review-late",
      }),
    ]);
    const byId = Object.fromEntries(projection.atoms.map((entry) => [entry.atomId, entry.state]));
    expect(byId).toEqual({ "req-1": "unverified", "req-2": "satisfied" });
  });

  test("patch_sets: the CLEAR stays live while the applied set matches and drops when it drifts", () => {
    const ref: ReviewTargetRef = { kind: "patch_sets", patchSetRefs: ["ps-1"] };
    const live = statesOf([
      atomEvent("req-1", 100),
      patchAppliedEvent("ps-1", 150),
      independentPassEvent({ timestamp: 200, atomRefs: ["req-1"], targetRef: ref }),
    ]);
    expect(live.state("req-1")).toBe("satisfied");

    const drifted = statesOf([
      atomEvent("req-1", 100),
      patchAppliedEvent("ps-1", 150),
      independentPassEvent({ timestamp: 200, atomRefs: ["req-1"], targetRef: ref }),
      // A second patch changes the applied set -> the recorded ref no longer
      // describes the tree the reviewer saw.
      patchAppliedEvent("ps-2", 300),
    ]);
    expect(drifted.state("req-1")).toBe("unverified");
  });

  test("a receipt with NO targetRef cannot demonstrate freshness and is dropped (conservative)", () => {
    const { state } = statesOf([
      atomEvent("req-1", 100),
      independentPassEvent({ timestamp: 200, atomRefs: ["req-1"], targetRef: null }),
    ]);
    expect(state("req-1")).toBe("unverified");
  });

  test("deterministic evidence items are untouched by the mirror rule (their freshness contract is the producer's)", () => {
    // A receipt that is STALE as an independent outcome still contributes its
    // recorded deterministic items — the gate scopes to the affirmative
    // independent channel only.
    const receipt = makeEvent(
      VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
      {
        sessionId: SESSION,
        outcome: "pass",
        level: "requirements",
        perspective: "independent",
        independenceBasis: ["fresh_context"],
        reviewerContext: { model: null, contextId: "review-run-1", lenses: [] },
        targetRef: FILE_REF,
        atomRefs: ["req-1"],
        evidenceItems: [
          {
            id: "gate:build:req-2",
            atomRefs: ["req-2"],
            verdict: "pass",
            anchors: [],
            statement: "build gate passed",
          },
        ],
      },
      { timestamp: 200, id: "indep-with-items" },
    );
    const { projection } = statesOf([
      atomEvent("req-1", 100),
      atomEvent("req-2", 100),
      receipt,
      writeEvent("a.ts", 300), // stales the independent outcome, not the items
    ]);
    const byId = Object.fromEntries(projection.atoms.map((entry) => [entry.atomId, entry.state]));
    expect(byId).toEqual({ "req-1": "unverified", "req-2": "satisfied" });
  });
});
