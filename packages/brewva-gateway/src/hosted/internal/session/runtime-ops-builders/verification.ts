import { readStringList } from "@brewva/brewva-std/text";
import {
  readVerificationOutcomeRecordedEventPayload,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  type VerificationOutcomeRecordedEventPayload,
} from "@brewva/brewva-vocabulary/iteration";
import {
  readReviewFindingRecordedEventPayload,
  REVIEW_FINDING_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/review";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

function normalizeOutcome(value: unknown): VerificationOutcomeRecordedEventPayload["outcome"] {
  return value === "pass" || value === "fail" || value === "skipped" ? value : null;
}

export function buildVerificationRuntimeOps(
  ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["verification"] {
  return {
    checks: {
      // Read side: project the latest committed outcome. Callers get the same
      // answer the stall adjudicator, hygiene finding, and observability
      // snapshot derive from the tape.
      evaluate(sessionId) {
        const latest = ctx.listEvents(sessionId, {
          type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
          last: 1,
        })[0];
        if (!latest) {
          return { ok: true, reason: "no_verification_recorded" };
        }
        const outcome = readVerificationOutcomeRecordedEventPayload(latest).outcome;
        return outcome === "fail" ? { ok: false, reason: "verification_failed" } : { ok: true };
      },
      // Write side: commit the caller-computed verification outcome as the
      // canonical `verification.outcome.recorded` receipt. This builder was a
      // stub that emitted nothing, which kept verification hygiene, reasoning
      // checkpoints, stall adjudication, and the observability snapshot
      // silently blind (contract-liveness audit, 2026-07-02).
      verify(sessionId, input) {
        const record = ctx.readObjectPayload(input);
        const outcome = normalizeOutcome(record.outcome);
        // Defensive coercion of the evidence + fitness-annotation fields reuses
        // the exact reader a receipt is parsed back through
        // (readVerificationOutcomeRecordedEventPayload), so a non-tool caller
        // that omits or malforms them lands on the same defaults a consumer
        // would derive on read — it can not silently produce a receipt that
        // reads back as independent, nor drop the fitness discrepancies/
        // unverified-must atoms (a malformed discrepancy is dropped, not
        // persisted as garbage).
        const {
          perspective,
          independenceBasis,
          reviewerContext,
          targetRef,
          discrepancies,
          unverifiedMustAtoms,
          atomRefs,
          evidenceItems,
        } = readVerificationOutcomeRecordedEventPayload({ payload: record });
        const payload: VerificationOutcomeRecordedEventPayload = {
          outcome,
          evidenceFreshness:
            typeof record.evidenceFreshness === "string" ? record.evidenceFreshness : null,
          level: typeof record.level === "string" ? record.level : null,
          checks: readStringList(record.checks),
          missingChecks: readStringList(record.missingChecks),
          missingEvidence: readStringList(record.missingEvidence),
          failedChecks: readStringList(record.failedChecks),
          reason: typeof record.reason === "string" ? record.reason : null,
          perspective,
          independenceBasis,
          reviewerContext,
          targetRef,
          discrepancies,
          unverifiedMustAtoms,
          atomRefs,
          evidenceItems,
        };
        ctx.emit(sessionId, VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE, payload);
        return outcome === "fail" ? { ok: false, reason: "verification_failed" } : { ok: true };
      },
    },
    findings: {
      // Write side for `review.finding.recorded`. Mirrors the verify seam: the
      // whole payload is normalized through the exact reader a consumer parses
      // it back with, so a malformed or target-ref-less finding lands on the
      // same authored defaults (or is rejected) instead of persisting a receipt
      // that reads back differently. A finding whose targetRef will not parse is
      // dropped (reader returns null) rather than recorded as evidence with no
      // provable tree state.
      record(sessionId, input) {
        const record = ctx.readObjectPayload(input);
        const payload = readReviewFindingRecordedEventPayload({ payload: record });
        if (!payload) {
          return undefined;
        }
        return ctx.emit(sessionId, REVIEW_FINDING_RECORDED_EVENT_TYPE, payload);
      },
    },
  };
}
