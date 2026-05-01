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
import type { EventPipelineService } from "../sessions/api.js";
import type { TaskService } from "../task/api.js";
import type { TaskBlockerRecordResult, TaskBlockerResolveResult } from "../task/api.js";
import type { TruthService } from "../truth/api.js";
import type {
  TruthFactResolveResult,
  TruthFactSeverity,
  TruthFactStatus,
  TruthFactUpsertResult,
} from "../truth/api.js";
import { readVerificationToolResultProjectionPayload } from "./projector-payloads.js";
import type { VerificationCheckRun, VerificationOutcomeRecordedEventPayload } from "./types.js";
import {
  buildVerifierBlockerMessage,
  GOVERNANCE_BLOCKER_ID,
  GOVERNANCE_TRUTH_FACT_ID,
  normalizeVerifierCheckForId,
  VERIFICATION_CHECK_FAILED_TRUTH_KIND,
  VERIFICATION_CHECK_MISSING_TRUTH_KIND,
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
  getTruthState: RuntimeKernelContext["getTruthState"];
  verificationStateStore: RuntimeKernelContext["verificationGate"]["stateStore"];
  eventPipeline: Pick<EventPipelineService, "subscribeEvents">;
  taskService: Pick<TaskService, "recordTaskBlocker" | "resolveTaskBlocker">;
  truthService: Pick<TruthService, "upsertTruthFact" | "resolveTruthFact">;
}

export class VerificationProjectorService {
  private readonly getTaskState: RuntimeKernelContext["getTaskState"];
  private readonly getTruthState: RuntimeKernelContext["getTruthState"];
  private readonly stateStore: RuntimeKernelContext["verificationGate"]["stateStore"];
  private readonly recordTaskBlocker: (
    sessionId: string,
    input: { id?: string; message: string; source?: string; truthFactId?: string },
  ) => TaskBlockerRecordResult;
  private readonly resolveTaskBlocker: (
    sessionId: string,
    blockerId: string,
  ) => TaskBlockerResolveResult;
  private readonly upsertTruthFact: (
    sessionId: string,
    input: {
      id: string;
      kind: string;
      severity: TruthFactSeverity;
      summary: string;
      details?: Record<string, unknown>;
      evidenceIds?: string[];
      status?: TruthFactStatus;
    },
  ) => TruthFactUpsertResult;
  private readonly resolveTruthFact: (
    sessionId: string,
    truthFactId: string,
  ) => TruthFactResolveResult;

  constructor(options: VerificationProjectorServiceOptions) {
    this.getTaskState = (sessionId) => options.getTaskState(sessionId);
    this.getTruthState = (sessionId) => options.getTruthState(sessionId);
    this.stateStore = options.verificationStateStore;
    this.recordTaskBlocker = (sessionId, input) =>
      options.taskService.recordTaskBlocker(sessionId, input);
    this.resolveTaskBlocker = (sessionId, blockerId) =>
      options.taskService.resolveTaskBlocker(sessionId, blockerId);
    this.upsertTruthFact = (sessionId, input) =>
      options.truthService.upsertTruthFact(sessionId, input);
    this.resolveTruthFact = (sessionId, truthFactId) =>
      options.truthService.resolveTruthFact(sessionId, truthFactId);
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
      if (blocker.truthFactId) {
        this.resolveTruthFact(sessionId, blocker.truthFactId);
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
      const truthFactId = `truth:verifier:${normalizeVerifierCheckForId(result.name)}`;
      const provenance = provenanceByCheck.get(result.name);
      const freshRun = toFreshRun(provenance);
      const issueKind = result.status;
      const message = buildVerifierBlockerMessage({
        checkName: result.name,
        truthFactId,
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
        (existing.truthFactId ?? "") === truthFactId
      ) {
        continue;
      }

      const evidenceIds = freshRun?.ledgerId ? [freshRun.ledgerId] : [];
      this.upsertTruthFact(sessionId, {
        id: truthFactId,
        kind:
          issueKind === "fail"
            ? VERIFICATION_CHECK_FAILED_TRUTH_KIND
            : VERIFICATION_CHECK_MISSING_TRUTH_KIND,
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
        truthFactId,
      });
    }

    const truthState = this.getTruthState(sessionId);
    for (const blocker of taskState.blockers) {
      if (!blocker.id.startsWith(VERIFIER_BLOCKER_PREFIX)) continue;
      if (openIssueIds.has(blocker.id)) continue;
      this.resolveTaskBlocker(sessionId, blocker.id);
      const truthFactId =
        blocker.truthFactId ?? `truth:verifier:${blocker.id.slice(VERIFIER_BLOCKER_PREFIX.length)}`;
      const active = truthState.facts.find(
        (fact) => fact.id === truthFactId && fact.status === "active",
      );
      if (active) {
        this.resolveTruthFact(sessionId, truthFactId);
      }
    }
  }

  private applyGovernanceFailure(sessionId: string, payload: unknown): void {
    if (!isRecord(payload)) return;
    const level = typeof payload.level === "string" ? payload.level : null;
    const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
    if (!reason) return;

    this.upsertTruthFact(sessionId, {
      id: GOVERNANCE_TRUTH_FACT_ID,
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
      truthFactId: GOVERNANCE_TRUTH_FACT_ID,
    });
  }

  private applyGovernancePass(sessionId: string): void {
    const truthState = this.getTruthState(sessionId);
    const active = truthState.facts.find(
      (fact) => fact.id === GOVERNANCE_TRUTH_FACT_ID && fact.status === "active",
    );
    if (active) {
      this.resolveTruthFact(sessionId, GOVERNANCE_TRUTH_FACT_ID);
    }

    const taskState = this.getTaskState(sessionId);
    if (taskState.blockers.some((blocker) => blocker.id === GOVERNANCE_BLOCKER_ID)) {
      this.resolveTaskBlocker(sessionId, GOVERNANCE_BLOCKER_ID);
    }
  }
}
