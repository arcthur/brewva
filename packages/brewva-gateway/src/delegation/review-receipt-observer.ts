import {
  commitReviewReceipts,
  resolveRoutedModel,
  type ReviewReceiptSource,
} from "@brewva/brewva-tools/delegation";
import { readDelegationReviewDispatch } from "@brewva/brewva-vocabulary/delegation";
import type { HostedRuntimeAdapterPort } from "../hosted/api.js";
import type { DelegationFinalizationReceipt } from "./run-finalization.js";

/**
 * The parallel-review completion observer (RFC: "independence is the only
 * verification that parallelizes"). When a delegation run tagged with a
 * `reviewDispatch` anchor reaches a terminal status, commit its review
 * receipts through the SAME shared commit path review_request's completion
 * mode uses — anchored to the pre-dispatch snapshot the anchor carries, never
 * to the tree as it looks now. Untagged runs are not review runs: no-op.
 *
 * Terminal mapping: a completed run's reviewer outcome is parsed and mapped
 * normally; a failed/cancelled run commits ONLY an independent `skipped`
 * outcome carrying the failure reason (axiom 7) — findings are never
 * fabricated for a run that produced no verdict.
 *
 * Exactly-once: the shared commit path derives idempotency from tape state
 * (an existing independent outcome whose reviewerContext.contextId matches
 * this runId), so observer re-entry or a tool/observer double-commit
 * collapses to one receipt set. Never blocks or warns the author.
 */
export function commitReviewReceiptsForFinalizedRun(input: {
  runtime: Pick<HostedRuntimeAdapterPort, "ops">;
  receipt: DelegationFinalizationReceipt;
}): void {
  const record = input.receipt.record;
  const dispatch = readDelegationReviewDispatch(record.reviewDispatch);
  if (!dispatch) {
    return;
  }
  const routedModel = resolveRoutedModel(record.modelRoute);
  const outcome = input.receipt.outcome;
  const source: ReviewReceiptSource =
    record.status === "completed"
      ? {
          kind: "reviewer_outcome",
          ok: outcome.ok,
          data: outcome.ok ? outcome.data : undefined,
        }
      : {
          kind: "run_terminal_failure",
          reason:
            record.error ??
            (outcome.ok ? undefined : outcome.error) ??
            `review run ended with status ${record.status}`,
        };
  commitReviewReceipts({
    runtime: { capabilities: input.runtime.ops },
    sessionId: input.receipt.parentSessionId,
    runId: record.runId,
    routedModel,
    dispatch,
    source,
  });
}
