import { describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import {
  buildHarnessCandidateId,
  HARNESS_CANDIDATE_LIFECYCLE_SCHEMA,
} from "@brewva/brewva-vocabulary/harness";
import { runHarnessCandidateVerb } from "../../../packages/brewva-cli/src/operator/harness.js";
import { compareHarnessCandidate } from "../../../packages/brewva-gateway/src/harness/api.js";
import {
  appendHarnessCandidateLifecycleRecord,
  readHarnessCandidateLifecycleRecords,
  resolveHarnessCandidateLedgerPath,
} from "../../../packages/brewva-gateway/src/harness/internal/candidate-ledger.js";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

describe("harness candidate lifecycle", () => {
  test("the candidate id is stable for a manifest pair and distinct across pairs", () => {
    const first = buildHarnessCandidateId({
      baseManifestId: "manifest-base",
      candidateManifestId: "manifest-candidate",
    });
    const again = buildHarnessCandidateId({
      baseManifestId: "manifest-base",
      candidateManifestId: "manifest-candidate",
    });
    const other = buildHarnessCandidateId({
      baseManifestId: "manifest-base",
      candidateManifestId: "manifest-other",
    });

    expect(again).toBe(first);
    expect(other).not.toBe(first);
  });

  test("comparison reports mint the shared candidate id", () => {
    const report = compareHarnessCandidate({
      sourceSessionId: "source-session",
      divergeAt: "event-1",
      baseManifestId: "manifest-base",
      candidateManifestId: "manifest-candidate",
    });

    expect(report.candidateId).toBe(
      buildHarnessCandidateId({
        baseManifestId: "manifest-base",
        candidateManifestId: "manifest-candidate",
      }),
    );
  });

  test("the ledger round-trips records and skips a torn trailing line", () => {
    const workspace = createTestWorkspace("harness-candidate-ledger");
    try {
      appendHarnessCandidateLifecycleRecord(workspace, {
        schema: HARNESS_CANDIDATE_LIFECYCLE_SCHEMA,
        candidateId: "cand-1",
        action: "evaluated",
        at: "2026-07-10T00:00:00.000Z",
        actor: "operator_cli",
        baseManifestId: "manifest-base",
        candidateManifestId: "manifest-candidate",
        mode: "real",
        recommendation: "review_required",
        regressionCount: 0,
      });
      appendFileSync(resolveHarnessCandidateLedgerPath(workspace), '{"torn', "utf8");

      const records = readHarnessCandidateLifecycleRecords(workspace);
      expect(records).toEqual([
        {
          schema: HARNESS_CANDIDATE_LIFECYCLE_SCHEMA,
          candidateId: "cand-1",
          action: "evaluated",
          at: "2026-07-10T00:00:00.000Z",
          actor: "operator_cli",
          baseManifestId: "manifest-base",
          candidateManifestId: "manifest-candidate",
          mode: "real",
          recommendation: "review_required",
          regressionCount: 0,
        },
      ]);
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });

  test("lifecycle verbs append accountable receipts; unknown ids warn but still record", () => {
    const workspace = createTestWorkspace("harness-candidate-verbs");
    try {
      const missingReason = runHarnessCandidateVerb(workspace, {
        candidateAction: "accepted",
        candidateId: "cand-1",
        json: false,
      });
      expect(missingReason).toBe(1);
      expect(readHarnessCandidateLifecycleRecords(workspace)).toEqual([]);

      // Candidates span checkouts: an id the local ledger has never seen is
      // warned about, but the accountable decision is recorded regardless.
      const crossCheckout = runHarnessCandidateVerb(workspace, {
        candidateAction: "rejected",
        candidateId: "cand-elsewhere",
        reason: "evaluated in the primary checkout; regressions on held-out",
        json: false,
      });
      expect(crossCheckout).toBe(0);
      expect(
        readHarnessCandidateLifecycleRecords(workspace).map((record) => record.action),
      ).toEqual(["rejected"]);

      appendHarnessCandidateLifecycleRecord(workspace, {
        schema: HARNESS_CANDIDATE_LIFECYCLE_SCHEMA,
        candidateId: "cand-1",
        action: "evaluated",
        at: "2026-07-10T00:00:00.000Z",
        actor: "operator_cli",
      });
      const accepted = runHarnessCandidateVerb(workspace, {
        candidateAction: "accepted",
        candidateId: "cand-1",
        reason: "model delta holds on held-out scenarios",
        json: false,
      });
      expect(accepted).toBe(0);

      const actions = readHarnessCandidateLifecycleRecords(workspace).map(
        (record) => record.action,
      );
      expect(actions).toEqual(["rejected", "evaluated", "accepted"]);
      const receipt = readHarnessCandidateLifecycleRecords(workspace).at(-1);
      expect(receipt?.reason).toBe("model delta holds on held-out scenarios");
      expect(receipt?.actor).toBe("operator_cli");
      expect(readFileSync(resolveHarnessCandidateLedgerPath(workspace), "utf8")).toContain(
        '"action":"accepted"',
      );
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });
});
