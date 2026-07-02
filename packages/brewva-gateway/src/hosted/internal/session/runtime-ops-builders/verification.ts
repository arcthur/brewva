import {
  readVerificationOutcomeRecordedEventPayload,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  type VerificationOutcomeRecordedEventPayload,
} from "@brewva/brewva-vocabulary/iteration";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

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
        const payload: VerificationOutcomeRecordedEventPayload = {
          outcome,
          evidenceFreshness:
            typeof record.evidenceFreshness === "string" ? record.evidenceFreshness : null,
          level: typeof record.level === "string" ? record.level : null,
          missingChecks: readStringList(record.missingChecks),
          missingEvidence: readStringList(record.missingEvidence),
          failedChecks: readStringList(record.failedChecks),
          reason: typeof record.reason === "string" ? record.reason : null,
        };
        ctx.emit(sessionId, VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE, payload);
        return outcome === "fail" ? { ok: false, reason: "verification_failed" } : { ok: true };
      },
    },
  };
}
