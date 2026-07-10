import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  buildHarnessCandidateId,
  buildHarnessEvaluationId,
  HARNESS_CANDIDATE_LIFECYCLE_SCHEMA,
  isHarnessCandidateId,
  type HarnessCandidateEvaluationReceipt,
  type HarnessComparisonReport,
} from "@brewva/brewva-vocabulary/harness";
import {
  appendHarnessEvaluationReceipt,
  HARNESS_EXIT_PARTIAL_RECEIPT_FAILURE,
  runHarnessCandidateVerb,
} from "../../../packages/brewva-cli/src/operator/harness.js";
import { compareHarnessCandidate } from "../../../packages/brewva-gateway/src/harness/api.js";
import {
  appendHarnessCandidateLifecycleRecord,
  readHarnessCandidateLifecycleRecords,
  resolveHarnessCandidateLedgerPath,
} from "../../../packages/brewva-gateway/src/harness/internal/candidate-ledger.js";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

const MODEL_DELTA_CANDIDATE_ID = buildHarnessCandidateId({
  delta: [{ field: "provider.model", to: "sonnet-next" }],
});

function evaluationReceipt(
  candidateId: string,
  overrides: Partial<HarnessCandidateEvaluationReceipt> = {},
): HarnessCandidateEvaluationReceipt {
  return {
    schema: HARNESS_CANDIDATE_LIFECYCLE_SCHEMA,
    candidateId,
    action: "evaluated",
    at: "2026-07-10T00:00:00.000Z",
    actor: "cli_invocation",
    evaluationId: buildHarnessEvaluationId({
      candidateId,
      sourceSessionId: "source-session",
      divergeAt: "event-1",
      targetSessionId: "target-session",
      mode: "real",
    }),
    baseManifestId: "manifest-base",
    candidateManifestId: "manifest-candidate",
    sourceSessionId: "source-session",
    divergeAt: "event-1",
    targetSessionId: "target-session",
    mode: "real",
    executedManifestId: "manifest-executed",
    recommendation: "review_required",
    regressionCount: 0,
    ...overrides,
  };
}

describe("harness candidate lifecycle", () => {
  test("the candidate id hashes the normalized delta, not the manifest pair", () => {
    const first = buildHarnessCandidateId({
      delta: [{ field: "provider.model", to: "sonnet-next" }],
    });
    const again = buildHarnessCandidateId({
      delta: [{ field: "provider.model", to: "sonnet-next" }],
    });
    const otherValue = buildHarnessCandidateId({
      delta: [{ field: "provider.model", to: "opus-next" }],
    });

    // Same edit → same candidate, regardless of which session pair it was
    // authored against; different target value → different candidate.
    expect(again).toBe(first);
    expect(otherValue).not.toBe(first);
    expect(isHarnessCandidateId(first)).toBe(true);
  });

  test("the candidate id is order-insensitive and removal-marking", () => {
    const sorted = buildHarnessCandidateId({
      delta: [
        { field: "provider.model", to: "sonnet-next" },
        { field: "skillSelection.mode", to: "manual" },
      ],
    });
    const shuffled = buildHarnessCandidateId({
      delta: [
        { field: "skillSelection.mode", to: "manual" },
        { field: "provider.model", to: "sonnet-next" },
      ],
    });
    const removal = buildHarnessCandidateId({
      delta: [{ field: "provider.model", to: null }],
    });

    expect(shuffled).toBe(sorted);
    expect(removal).not.toBe(sorted);
  });

  test("comparison reports carry the caller-minted delta candidate id", () => {
    const report = compareHarnessCandidate({
      candidateId: MODEL_DELTA_CANDIDATE_ID,
      sourceSessionId: "source-session",
      divergeAt: "event-1",
      baseManifestId: "manifest-base",
      candidateManifestId: "manifest-candidate",
    });

    expect(report.candidateId).toBe(MODEL_DELTA_CANDIDATE_ID);
  });

  test("the ledger round-trips both receipt entities and skips a torn trailing line", () => {
    const workspace = createTestWorkspace("harness-candidate-ledger");
    try {
      const receipt = evaluationReceipt(MODEL_DELTA_CANDIDATE_ID);
      appendHarnessCandidateLifecycleRecord(workspace, receipt);
      appendFileSync(resolveHarnessCandidateLedgerPath(workspace), '{"torn', "utf8");

      const records = readHarnessCandidateLifecycleRecords(workspace);
      expect(records).toEqual([receipt]);
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });

  test("a torn tail is repaired before the next append instead of eating it", () => {
    const workspace = createTestWorkspace("harness-candidate-ledger-torn");
    try {
      const first = evaluationReceipt(MODEL_DELTA_CANDIDATE_ID);
      appendHarnessCandidateLifecycleRecord(workspace, first);
      // Simulate a crashed writer: a torn fragment with no newline.
      appendFileSync(resolveHarnessCandidateLedgerPath(workspace), '{"torn', "utf8");

      const decision = runHarnessCandidateVerb(workspace, {
        candidateAction: "accepted",
        candidateId: MODEL_DELTA_CANDIDATE_ID,
        reason: "model delta holds on held-out scenarios",
        json: false,
      });
      expect(decision).toBe(0);

      // Without writer-side repair the new JSON would glue onto the torn
      // fragment and readers would skip BOTH lines forever.
      const records = readHarnessCandidateLifecycleRecords(workspace);
      expect(records.map((record) => record.action)).toEqual(["evaluated", "accepted"]);
      expect(readFileSync(resolveHarnessCandidateLedgerPath(workspace), "utf8")).not.toContain(
        '{"torn',
      );
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });

  test("a symlinked ledger parent refuses instead of writing outside the workspace", () => {
    const workspace = createTestWorkspace("harness-candidate-ledger-symlink");
    const outside = createTestWorkspace("harness-candidate-ledger-outside");
    try {
      const ledgerPath = resolveHarnessCandidateLedgerPath(workspace);
      mkdirSync(join(outside, "exfil"), { recursive: true });
      mkdirSync(dirname(dirname(ledgerPath)), { recursive: true });
      symlinkSync(join(outside, "exfil"), dirname(ledgerPath));

      expect(() =>
        appendHarnessCandidateLifecycleRecord(workspace, evaluationReceipt("harness_candidate:x")),
      ).toThrow(/harness_candidate_ledger_symlink_rejected/);
      expect(readHarnessCandidateLifecycleRecords(outside)).toEqual([]);
    } finally {
      rmSync(join(workspace, ".brewva", "harness"), { recursive: true, force: true });
      cleanupTestWorkspace(workspace);
      cleanupTestWorkspace(outside);
    }
  });

  test("a held writer lock makes the decision verb fail closed instead of corrupting", () => {
    const workspace = createTestWorkspace("harness-candidate-ledger-lock");
    try {
      const ledgerPath = resolveHarnessCandidateLedgerPath(workspace);
      mkdirSync(dirname(ledgerPath), { recursive: true });
      // A fresh (non-stale) lock held by a concurrent writer.
      writeFileSync(`${ledgerPath}.lock`, "424242\n", "utf8");

      const exitCode = runHarnessCandidateVerb(workspace, {
        candidateAction: "accepted",
        candidateId: MODEL_DELTA_CANDIDATE_ID,
        reason: "model delta holds on held-out scenarios",
        json: false,
      });

      expect(exitCode).toBe(1);
      expect(readHarnessCandidateLifecycleRecords(workspace)).toEqual([]);
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });

  test("a compare whose receipt append fails exits with the partial-failure code", () => {
    const workspace = createTestWorkspace("harness-candidate-ledger-partial");
    try {
      const ledgerPath = resolveHarnessCandidateLedgerPath(workspace);
      mkdirSync(dirname(ledgerPath), { recursive: true });
      writeFileSync(`${ledgerPath}.lock`, "424242\n", "utf8");
      const report: HarnessComparisonReport = {
        schema: "brewva.harness.eval_report.v1",
        mode: "real",
        candidateId: MODEL_DELTA_CANDIDATE_ID,
        sourceSessionId: "source-session",
        targetSessionId: "target-session",
        divergeAt: "event-1",
        baseManifestId: "manifest-base",
        candidateManifestId: "manifest-candidate",
        changedFields: ["provider.model"],
        sideEffectPolicy: "explicit_real_target_session_only",
        metrics: { changedFieldCount: 1, regressions: [] },
        promotion: {
          recommendation: "review_required",
          reason: "manifest_comparison_requires_explicit_governance",
        },
      };

      expect(appendHarnessEvaluationReceipt(workspace, report)).toBe(
        HARNESS_EXIT_PARTIAL_RECEIPT_FAILURE,
      );
      // Manifest-only diffing never appends and never fails partially.
      expect(appendHarnessEvaluationReceipt(workspace, { ...report, mode: "manifest" })).toBe(0);
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });

  test("lifecycle verbs record decisions; pattern ids and unknown shapes refuse", () => {
    const workspace = createTestWorkspace("harness-candidate-verbs");
    try {
      const missingReason = runHarnessCandidateVerb(workspace, {
        candidateAction: "accepted",
        candidateId: MODEL_DELTA_CANDIDATE_ID,
        json: false,
      });
      expect(missingReason).toBe(1);
      expect(readHarnessCandidateLifecycleRecords(workspace)).toEqual([]);

      // A patrol pattern id is a report artifact, never a decidable candidate.
      const patternRefused = runHarnessCandidateVerb(workspace, {
        candidateAction: "accepted",
        candidateId: "harness_pattern:abcdef",
        reason: "looks promising",
        json: false,
      });
      expect(patternRefused).toBe(1);
      expect(readHarnessCandidateLifecycleRecords(workspace)).toEqual([]);

      // Candidates span checkouts: a well-formed id the local ledger has never
      // seen is warned about, but the accountable decision is recorded.
      const crossCheckout = runHarnessCandidateVerb(workspace, {
        candidateAction: "rejected",
        candidateId: buildHarnessCandidateId({
          delta: [{ field: "provider.model", to: "elsewhere" }],
        }),
        reason: "evaluated in the primary checkout; regressions on held-out",
        json: false,
      });
      expect(crossCheckout).toBe(0);
      expect(
        readHarnessCandidateLifecycleRecords(workspace).map((record) => record.action),
      ).toEqual(["rejected"]);

      appendHarnessCandidateLifecycleRecord(workspace, evaluationReceipt(MODEL_DELTA_CANDIDATE_ID));
      const accepted = runHarnessCandidateVerb(workspace, {
        candidateAction: "accepted",
        candidateId: MODEL_DELTA_CANDIDATE_ID,
        reason: "model delta holds on held-out scenarios",
        json: false,
      });
      expect(accepted).toBe(0);

      const records = readHarnessCandidateLifecycleRecords(workspace);
      expect(records.map((record) => record.action)).toEqual(["rejected", "evaluated", "accepted"]);
      const receipt = records.at(-1);
      expect(receipt && "reason" in receipt ? receipt.reason : undefined).toBe(
        "model delta holds on held-out scenarios",
      );
      expect(receipt?.actor).toBe("cli_invocation");
      expect(readFileSync(resolveHarnessCandidateLedgerPath(workspace), "utf8")).toContain(
        '"action":"accepted"',
      );
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });
});
