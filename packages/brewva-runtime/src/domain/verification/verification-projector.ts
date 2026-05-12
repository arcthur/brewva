import {
  readToolResultRecordedEventPayload,
  readVerificationOutcomeRecordedEventPayload,
  readVerificationWriteMarkedEventPayload,
} from "../../events/descriptors.js";
import {
  GOVERNANCE_VERIFY_SPEC_FAILED_EVENT_TYPE,
  GOVERNANCE_VERIFY_SPEC_PASSED_EVENT_TYPE,
  TOOL_RESULT_RECORDED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_STATE_RESET_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
} from "../../events/registry.js";
import type { BrewvaStructuredEvent } from "../../events/types.js";
import type { RuntimeKernelContext } from "../../runtime/runtime-kernel.js";
import type { ClaimService } from "../claim/api.js";
import type {
  ClaimResolveResult,
  ClaimSeverity,
  ClaimStatus,
  ClaimUpsertResult,
} from "../claim/api.js";
import type { EventPipelineService } from "../sessions/api.js";
import type { TaskService } from "../task/api.js";
import type { TaskBlockerRecordResult, TaskBlockerResolveResult } from "../task/api.js";
import { readVerificationToolResultProjectionPayload } from "./projector-payloads.js";
import type { VerificationCheckRun, VerificationOutcomeRecordedEventPayload } from "./types.js";
import {
  buildVerifierBlockerMessage,
  GOVERNANCE_BLOCKER_ID,
  GOVERNANCE_CLAIM_ID,
  normalizeVerifierCheckForId,
  VERIFICATION_CHECK_FAILED_CLAIM_KIND,
  VERIFICATION_CHECK_MISSING_CLAIM_KIND,
  VERIFIER_BLOCKER_PREFIX,
} from "./verifier-blockers.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFreshRun(
  provenance: VerificationOutcomeRecordedEventPayload["checkProvenance"][number] | undefined,
): VerificationCheckRun | undefined {
  if (!provenance?.hasRun || !provenance.freshSinceWrite || provenance.runTimestamp === null) {
    return undefined;
  }
  return {
    timestamp: provenance.runTimestamp,
    ok: provenance.status === "pass",
    command: provenance.command ?? "",
    exitCode: null,
    durationMs: 0,
    ledgerId: provenance.ledgerId ?? undefined,
  };
}

export interface VerificationProjectorServiceOptions {
  getTaskState: RuntimeKernelContext["getTaskState"];
  getClaimState: RuntimeKernelContext["getClaimState"];
  verificationStateStore: RuntimeKernelContext["verificationGate"]["stateStore"];
  eventPipeline: Pick<EventPipelineService, "subscribeEvents">;
  taskService: Pick<TaskService, "recordTaskBlocker" | "resolveTaskBlocker">;
  claimService: Pick<ClaimService, "upsert" | "resolve">;
}

export class VerificationProjectorService {
  private readonly getTaskState: RuntimeKernelContext["getTaskState"];
  private readonly getClaimState: RuntimeKernelContext["getClaimState"];
  private readonly stateStore: RuntimeKernelContext["verificationGate"]["stateStore"];
  private readonly recordTaskBlocker: (
    sessionId: string,
    input: { id?: string; message: string; source?: string; claimId?: string },
  ) => TaskBlockerRecordResult;
  private readonly resolveTaskBlocker: (
    sessionId: string,
    blockerId: string,
  ) => TaskBlockerResolveResult;
  private readonly upsert: (
    sessionId: string,
    input: {
      id: string;
      kind: string;
      severity: ClaimSeverity;
      summary: string;
      details?: Record<string, unknown>;
      evidenceIds?: string[];
      status?: ClaimStatus;
    },
  ) => ClaimUpsertResult;
  private readonly resolve: (sessionId: string, claimId: string) => ClaimResolveResult;

  constructor(options: VerificationProjectorServiceOptions) {
    this.getTaskState = (sessionId) => options.getTaskState(sessionId);
    this.getClaimState = (sessionId) => options.getClaimState(sessionId);
    this.stateStore = options.verificationStateStore;
    this.recordTaskBlocker = (sessionId, input) =>
      options.taskService.recordTaskBlocker(sessionId, input);
    this.resolveTaskBlocker = (sessionId, blockerId) =>
      options.taskService.resolveTaskBlocker(sessionId, blockerId);
    this.upsert = (sessionId, input) => options.claimService.upsert(sessionId, input);
    this.resolve = (sessionId, claimId) => options.claimService.resolve(sessionId, claimId);
    options.eventPipeline.subscribeEvents((event) => {
      this.handleEvent(event);
    });
  }

  private handleEvent(event: BrewvaStructuredEvent): void {
    if (event.type === VERIFICATION_WRITE_MARKED_EVENT_TYPE) {
      if (!readVerificationWriteMarkedEventPayload(event)) return;
      this.stateStore.markWriteAt(event.sessionId, event.timestamp);
      this.clearVerificationIssues(event.sessionId);
      return;
    }

    if (event.type === TOOL_RESULT_RECORDED_EVENT_TYPE) {
      const toolResult = readToolResultRecordedEventPayload(event);
      const projection = readVerificationToolResultProjectionPayload(
        toolResult?.verificationProjection,
      );
      if (!projection) return;
      if (projection.checkRun) {
        this.stateStore.setCheckRun(
          event.sessionId,
          projection.checkRun.checkName,
          projection.checkRun.run,
        );
      }
      return;
    }

    if (event.type === VERIFICATION_STATE_RESET_EVENT_TYPE) {
      this.stateStore.clear(event.sessionId);
      return;
    }

    if (event.type === VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE) {
      const payload = readVerificationOutcomeRecordedEventPayload(event);
      if (!payload) return;
      this.syncVerificationOutcome(event.sessionId, payload);
      return;
    }

    if (event.type === GOVERNANCE_VERIFY_SPEC_FAILED_EVENT_TYPE) {
      this.applyGovernanceFailure(event.sessionId, event.payload);
      return;
    }

    if (event.type === GOVERNANCE_VERIFY_SPEC_PASSED_EVENT_TYPE) {
      this.applyGovernancePass(event.sessionId);
    }
  }

  private clearVerificationIssues(sessionId: string): void {
    const taskState = this.getTaskState(sessionId);
    for (const blocker of taskState.blockers) {
      if (!blocker.id.startsWith(VERIFIER_BLOCKER_PREFIX)) {
        continue;
      }
      this.resolveTaskBlocker(sessionId, blocker.id);
      if (blocker.claimId) {
        this.resolve(sessionId, blocker.claimId);
      }
    }
  }

  private syncVerificationOutcome(
    sessionId: string,
    payload: VerificationOutcomeRecordedEventPayload,
  ): void {
    const referenceWriteAt = payload.referenceWriteAt;
    if (!referenceWriteAt) {
      return;
    }

    const provenanceByCheck = new Map(payload.checkProvenance.map((entry) => [entry.check, entry]));
    const checkResults = payload.checkResults;

    const taskState = this.getTaskState(sessionId);
    const existingById = new Map(taskState.blockers.map((blocker) => [blocker.id, blocker]));
    const openIssueIds = new Set<string>();

    for (const result of checkResults) {
      if (result.status !== "fail" && result.status !== "missing") continue;
      const blockerId = `${VERIFIER_BLOCKER_PREFIX}${normalizeVerifierCheckForId(result.name)}`;
      const claimId = `claim:verifier:${normalizeVerifierCheckForId(result.name)}`;
      const provenance = provenanceByCheck.get(result.name);
      const freshRun = toFreshRun(provenance);
      const issueKind = result.status;
      const message = buildVerifierBlockerMessage({
        checkName: result.name,
        claimId,
        issueKind,
        run: freshRun,
      });
      const source = "verification_gate";
      openIssueIds.add(blockerId);

      const existing = existingById.get(blockerId);
      if (
        existing &&
        existing.message === message &&
        (existing.source ?? "") === source &&
        (existing.claimId ?? "") === claimId
      ) {
        continue;
      }

      const evidenceIds = freshRun?.ledgerId ? [freshRun.ledgerId] : [];
      this.upsert(sessionId, {
        id: claimId,
        kind:
          issueKind === "fail"
            ? VERIFICATION_CHECK_FAILED_CLAIM_KIND
            : VERIFICATION_CHECK_MISSING_CLAIM_KIND,
        severity: issueKind === "fail" ? "error" : "warn",
        summary:
          issueKind === "fail"
            ? `verification failed: ${result.name}`
            : `verification missing fresh evidence: ${result.name}`,
        evidenceIds,
        details: {
          issueKind,
          check: result.name,
          command: freshRun?.command ?? provenance?.command ?? null,
          exitCode: freshRun?.exitCode ?? null,
          ledgerId: freshRun?.ledgerId ?? provenance?.ledgerId ?? null,
          hasRun: provenance?.hasRun ?? false,
          freshSinceWrite: provenance?.freshSinceWrite ?? false,
          evidence: result.evidence,
        },
      });
      this.recordTaskBlocker(sessionId, {
        id: blockerId,
        message,
        source,
        claimId,
      });
    }

    const claimState = this.getClaimState(sessionId);
    for (const blocker of taskState.blockers) {
      if (!blocker.id.startsWith(VERIFIER_BLOCKER_PREFIX)) continue;
      if (openIssueIds.has(blocker.id)) continue;
      this.resolveTaskBlocker(sessionId, blocker.id);
      const claimId =
        blocker.claimId ?? `claim:verifier:${blocker.id.slice(VERIFIER_BLOCKER_PREFIX.length)}`;
      const active = claimState.claims.find(
        (fact) => fact.id === claimId && fact.status === "active",
      );
      if (active) {
        this.resolve(sessionId, claimId);
      }
    }
  }

  private applyGovernanceFailure(sessionId: string, payload: unknown): void {
    if (!isRecord(payload)) return;
    const level = typeof payload.level === "string" ? payload.level : null;
    const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
    if (!reason) return;

    this.upsert(sessionId, {
      id: GOVERNANCE_CLAIM_ID,
      kind: "governance_verify_spec_failed",
      severity: "error",
      summary: `governance verification failed: ${reason}`,
      details: {
        level,
        reason,
      },
    });
    this.recordTaskBlocker(sessionId, {
      id: GOVERNANCE_BLOCKER_ID,
      message: `governance verification failed: ${reason}`,
      source: "governance_verify_spec",
      claimId: GOVERNANCE_CLAIM_ID,
    });
  }

  private applyGovernancePass(sessionId: string): void {
    const claimState = this.getClaimState(sessionId);
    const active = claimState.claims.find(
      (fact) => fact.id === GOVERNANCE_CLAIM_ID && fact.status === "active",
    );
    if (active) {
      this.resolve(sessionId, GOVERNANCE_CLAIM_ID);
    }

    const taskState = this.getTaskState(sessionId);
    if (taskState.blockers.some((blocker) => blocker.id === GOVERNANCE_BLOCKER_ID)) {
      this.resolveTaskBlocker(sessionId, GOVERNANCE_BLOCKER_ID);
    }
  }
}
