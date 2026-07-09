import { describe, expect, test } from "bun:test";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import type { ReviewTargetRef } from "@brewva/brewva-vocabulary/review";
import type { RequirementAtom } from "@brewva/brewva-vocabulary/task";
import {
  describeTargetForObjective,
  resolveFoldedDebtAtoms,
  type ReviewTarget,
} from "../../../packages/brewva-tools/src/families/delegation/review-request-packet.js";
import { freshTouchedCoverageForTargetRef } from "../../../packages/brewva-tools/src/runtime-port/session-touched-files.js";
import { committedToolEvent } from "../../helpers/tool-events.js";

// The review→atom attribution close-edge (rfc-review-atom-close-connection): a
// files/session_diff review that COVERS the whole fresh-touched universe folds
// the outstanding high-risk independence-debt atoms in, so a FAIL finding can name
// the atom it violates. Honest scoping keys on coverage, NOT target kind — game_7's
// review was a `files` review listing every touched file.

const WORKSPACE_ROOT = "/workspace/app";

// Write events carry ABSOLUTE paths (the real hosted tape shape); the universe
// relativizes them against the workspace root.
function writeRecord(relPath: string, ts: number): BrewvaEventRecord {
  return committedToolEvent({
    toolName: "write",
    args: { path: `${WORKSPACE_ROOT}/${relPath}` },
    timestamp: ts,
  }) as unknown as BrewvaEventRecord;
}

/** A write whose args carry no parseable path — the universe cannot be fully known. */
function unnameableWriteRecord(ts: number): BrewvaEventRecord {
  return committedToolEvent({
    toolName: "write",
    args: {},
    timestamp: ts,
  }) as unknown as BrewvaEventRecord;
}

function requirementRecord(id: string, riskClass?: string): BrewvaEventRecord {
  return {
    id: `e-req-${id}`,
    sessionId: "s",
    turnId: "t",
    type: "task.requirement.recorded",
    timestamp: 1,
    payload: {
      atom: {
        id,
        statement: `${id} statement`,
        modality: "must",
        provenance: "trap",
        ...(riskClass ? { riskClass } : {}),
      },
    },
  } as BrewvaEventRecord;
}

function fileDigestsRef(paths: readonly string[]): ReviewTargetRef {
  return {
    kind: "file_digests",
    digests: Object.fromEntries(paths.map((path) => [path, `hash-${path}`])),
  };
}

function runtimeWithEvents(events: readonly BrewvaEventRecord[]) {
  return { capabilities: { events: { records: { query: () => events } } } } as never;
}

const RUNTIME_ATOM: RequirementAtom = {
  id: "req-runtime",
  statement: "event tap must re-arm on disable",
  modality: "must",
  provenance: "trap",
  riskClass: "runtime",
};

describe("freshTouchedCoverageForTargetRef.covered — the honest-scoping gate", () => {
  const sessionEvents = [
    writeRecord("Sources/Tap.swift", 1),
    writeRecord("Sources/Injector.swift", 2),
  ];

  test("a file_digests ref listing every touched file COVERS the universe (game_7's case)", () => {
    expect(
      freshTouchedCoverageForTargetRef(
        sessionEvents,
        WORKSPACE_ROOT,
        fileDigestsRef(["Sources/Tap.swift", "Sources/Injector.swift"]),
      ).covered,
    ).toBe(true);
  });

  test("a narrow file_digests ref missing a touched file does NOT cover (stays atom-free)", () => {
    expect(
      freshTouchedCoverageForTargetRef(
        sessionEvents,
        WORKSPACE_ROOT,
        fileDigestsRef(["Sources/Tap.swift"]),
      ).covered,
    ).toBe(false);
  });

  test("an unnameable write makes the universe not fully known — fail closed", () => {
    expect(
      freshTouchedCoverageForTargetRef(
        [writeRecord("Sources/Tap.swift", 1), unnameableWriteRecord(2)],
        WORKSPACE_ROOT,
        fileDigestsRef(["Sources/Tap.swift"]),
      ).covered,
    ).toBe(false);
  });
});

describe("resolveFoldedDebtAtoms — coverage-gated high-risk debt", () => {
  test("a covering review folds the high-risk debt atom, and only it (not presence-floor atoms)", () => {
    const runtime = runtimeWithEvents([
      writeRecord("Sources/Tap.swift", 1),
      requirementRecord("req-runtime", "runtime"),
      requirementRecord("req-ux", "ux"),
    ]);
    const folded = resolveFoldedDebtAtoms(
      runtime,
      "s",
      WORKSPACE_ROOT,
      fileDigestsRef(["Sources/Tap.swift"]),
    );
    // req-ux is presence-floor -> NOT independence debt; req-runtime is high-risk unmet.
    expect(folded.map((atom) => atom.id)).toEqual(["req-runtime"]);
  });

  test("a NON-covering (narrow) review folds nothing — honest scoping", () => {
    const runtime = runtimeWithEvents([
      writeRecord("Sources/Tap.swift", 1),
      requirementRecord("req-runtime", "runtime"),
    ]);
    const folded = resolveFoldedDebtAtoms(
      runtime,
      "s",
      WORKSPACE_ROOT,
      fileDigestsRef(["Sources/Other.swift"]),
    );
    expect(folded).toEqual([]);
  });

  test("a covering review with no high-risk debt folds nothing", () => {
    const runtime = runtimeWithEvents([
      writeRecord("Sources/Tap.swift", 1),
      requirementRecord("req-ux", "ux"),
    ]);
    const folded = resolveFoldedDebtAtoms(
      runtime,
      "s",
      WORKSPACE_ROOT,
      fileDigestsRef(["Sources/Tap.swift"]),
    );
    expect(folded).toEqual([]);
  });
});

describe("describeTargetForObjective — merged attestation appendix", () => {
  const filesTarget: ReviewTarget = { kind: "files", paths: ["Sources/Tap.swift"] };
  const ref = fileDigestsRef(["Sources/Tap.swift"]);

  test("a covering files review with folded atoms appends the SAME atomRef-naming ask", () => {
    const objective = describeTargetForObjective(filesTarget, ref, [RUNTIME_ATOM]);
    expect(objective).toContain("Review these files (read them yourself)");
    expect(objective).toContain("Additionally, confirm the implementation REALIZES");
    expect(objective).toContain("name the atom's id in that finding's atomRefs");
    expect(objective).toContain("[req-runtime]");
  });

  test("a files review with no folded atoms keeps its base objective (no attestation)", () => {
    const objective = describeTargetForObjective(filesTarget, ref, []);
    expect(objective).toContain("Review these files (read them yourself)");
    expect(objective).not.toContain("Additionally");
    expect(objective).not.toContain("atomRefs");
  });

  test("a session_diff review folds the appendix onto the diff objective", () => {
    const objective = describeTargetForObjective(
      { kind: "session_diff" },
      { kind: "patch_sets", patchSetRefs: ["ps-1"] },
      [RUNTIME_ATOM],
    );
    expect(objective).toContain("Review the change described by the session's applied patch sets");
    expect(objective).toContain("ps-1");
    expect(objective).toContain("Additionally, confirm the implementation REALIZES");
  });

  test("an atoms target is a standalone attestation, not an appendix", () => {
    const objective = describeTargetForObjective(
      { kind: "atoms" },
      { kind: "patch_sets", patchSetRefs: ["ps-1"] },
      [RUNTIME_ATOM],
    );
    expect(objective).toContain("Verify that the implementation actually REALIZES");
    expect(objective).not.toContain("Additionally");
    // The shared instruction is present in both shapes.
    expect(objective).toContain("name the atom's id in that finding's atomRefs");
  });
});

describe("ghost files — a deleted write target must not dead-lock coverage (game_9_2)", () => {
  // The universe is a whole-session union of write targets; a file written early
  // and DELETED later (a refactor rename's ghost) stays in it forever while a
  // review snapshot (digests of the CURRENT tree) can never include it. game_9_2:
  // a deleted main.swift kept reviewedAtomIds empty across two otherwise-covering
  // reviews, shipping twelve findings unattributed.
  const sessionEvents = [
    writeRecord("Sources/App.swift", 1),
    writeRecord("Sources/main.swift", 2), // later deleted from the tree
    requirementRecord("req-runtime", "runtime"),
  ];
  const coveringExistingOnly = fileDigestsRef(["Sources/App.swift"]);
  const existsOnDisk = (path: string) => path !== "Sources/main.swift";

  test("with the existence probe, coverage demands only living files -> covered", () => {
    const coverage = freshTouchedCoverageForTargetRef(
      sessionEvents,
      WORKSPACE_ROOT,
      coveringExistingOnly,
      existsOnDisk,
    );
    expect(coverage.covered).toBe(true);
    // The ghost is out of the returned universe too, so the fold's non-empty
    // guard reads the LIVING set.
    expect([...coverage.universe.files]).toEqual(["Sources/App.swift"]);
  });

  test("without the probe the old conservative demand stands (pure tape-only reads)", () => {
    expect(
      freshTouchedCoverageForTargetRef(sessionEvents, WORKSPACE_ROOT, coveringExistingOnly).covered,
    ).toBe(false);
  });

  test("the fold fires despite the ghost: debt atoms are attested by a review covering all living files", () => {
    const folded = resolveFoldedDebtAtoms(
      runtimeWithEvents(sessionEvents),
      "s",
      WORKSPACE_ROOT,
      coveringExistingOnly,
      existsOnDisk,
    );
    expect(folded.map((atom) => atom.id)).toEqual(["req-runtime"]);
  });

  test("when EVERY fresh file was deleted the fold stays idle (nothing living to attest)", () => {
    const folded = resolveFoldedDebtAtoms(
      runtimeWithEvents(sessionEvents),
      "s",
      WORKSPACE_ROOT,
      coveringExistingOnly,
      () => false,
    );
    expect(folded).toEqual([]);
  });
});
