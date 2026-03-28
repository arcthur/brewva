import type {
  BrewvaConfig,
  ContextBudgetUsage,
  TaskAcceptanceRecordResult,
  TaskAcceptanceState,
  TaskHealth,
  TaskBlockerRecordResult,
  TaskBlockerResolveResult,
  TaskItemAddResult,
  TaskItemStatus,
  TaskItemUpdateResult,
  TaskPhase,
  TaskSpec,
  TaskState,
  TaskStatus,
  TruthState,
  VerificationLevel,
  VerificationReport,
} from "../contracts/index.js";
import {
  buildAcceptanceSetEvent,
  TASK_EVENT_TYPE,
  buildBlockerRecordedEvent,
  buildBlockerResolvedEvent,
  buildItemAddedEvent,
  buildItemUpdatedEvent,
  buildStatusSetEvent,
} from "../task/ledger.js";
import { normalizeTaskSpec } from "../task/spec.js";
import { resolveContextUsageRatio } from "../utils/token.js";
import {
  GOVERNANCE_BLOCKER_ID,
  VERIFIER_BLOCKER_PREFIX,
} from "../verification/verifier-blockers.js";
import type { RuntimeCallback } from "./callback.js";

export interface TaskStatusAlignmentInput {
  sessionId: string;
  promptText: string;
  truthState: TruthState;
  usage?: ContextBudgetUsage;
}

export interface TaskServiceOptions {
  config: BrewvaConfig;
  isContextBudgetEnabled: RuntimeCallback<[], boolean>;
  resolveContextBudgetThresholds: RuntimeCallback<
    [sessionId: string, usage?: ContextBudgetUsage],
    {
      compactionThresholdPercent: number;
      hardLimitPercent: number;
    }
  >;
  getTaskState: RuntimeCallback<[sessionId: string], TaskState>;
  getTruthState: RuntimeCallback<[sessionId: string], TruthState>;
  evaluateCompletion: RuntimeCallback<
    [sessionId: string, level?: VerificationLevel],
    VerificationReport
  >;
  recordEvent: RuntimeCallback<
    [
      input: {
        sessionId: string;
        type: string;
        turn?: number;
        payload?: Record<string, unknown>;
        timestamp?: number;
        skipTapeCheckpoint?: boolean;
      },
    ],
    unknown
  >;
}

export class TaskService {
  private readonly config: BrewvaConfig;
  private readonly isContextBudgetEnabled: () => boolean;
  private readonly resolveContextBudgetThresholds: (
    sessionId: string,
    usage?: ContextBudgetUsage,
  ) => {
    compactionThresholdPercent: number;
    hardLimitPercent: number;
  };
  private readonly getTaskState: (sessionId: string) => TaskState;
  private readonly getTruthState: (sessionId: string) => TruthState;
  private readonly evaluateCompletion: (
    sessionId: string,
    level?: VerificationLevel,
  ) => VerificationReport;
  private readonly recordEvent: TaskServiceOptions["recordEvent"];

  constructor(options: TaskServiceOptions) {
    this.config = options.config;
    this.isContextBudgetEnabled = options.isContextBudgetEnabled;
    this.resolveContextBudgetThresholds = (sessionId, usage) =>
      options.resolveContextBudgetThresholds(sessionId, usage);
    this.getTaskState = options.getTaskState;
    this.getTruthState = options.getTruthState;
    this.evaluateCompletion = options.evaluateCompletion;
    this.recordEvent = options.recordEvent;
  }

  private alignTaskStatusAfterMutation(sessionId: string): void {
    this.maybeAlignTaskStatus({
      sessionId,
      promptText: "",
      truthState: this.getTruthState(sessionId),
    });
  }

  private isSameTaskStatus(left: TaskStatus | undefined, right: TaskStatus): boolean {
    if (!left) return false;
    if (left.phase !== right.phase) return false;
    if (left.health !== right.health) return false;
    if ((left.reason ?? "") !== (right.reason ?? "")) return false;

    const leftTruth = left.truthFactIds ?? [];
    const rightTruth = right.truthFactIds ?? [];
    if (leftTruth.length !== rightTruth.length) return false;
    for (let i = 0; i < leftTruth.length; i += 1) {
      if (leftTruth[i] !== rightTruth[i]) return false;
    }
    return true;
  }

  private computeTaskStatus(input: TaskStatusAlignmentInput): TaskStatus {
    const state = this.getTaskState(input.sessionId);
    const hasSpec = Boolean(state.spec);
    const blockers = state.blockers ?? [];
    const items = state.items ?? [];
    const openItems = items.filter((item) => item.status !== "done");
    const verifierBlockers = blockers.filter((blocker) =>
      blocker.id.startsWith(VERIFIER_BLOCKER_PREFIX),
    );
    const hasSoftVerifierBlocker = verifierBlockers.some(
      (blocker) => blocker.id !== GOVERNANCE_BLOCKER_ID,
    );
    const hasHardBlocker = blockers.some(
      (blocker) =>
        !blocker.id.startsWith(VERIFIER_BLOCKER_PREFIX) || blocker.id === GOVERNANCE_BLOCKER_ID,
    );
    const acceptanceRequired = state.spec?.acceptance?.required === true;
    const acceptanceStatus = state.acceptance?.status ?? "pending";

    const activeTruthFacts = input.truthState.facts.filter((fact) => fact.status === "active");
    const severityRank = (severity: string): number => {
      if (severity === "error") return 3;
      if (severity === "warn") return 2;
      return 1;
    };
    const truthFactIds = activeTruthFacts
      .toSorted((left, right) => {
        const severity = severityRank(right.severity) - severityRank(left.severity);
        if (severity !== 0) return severity;
        return right.lastSeenAt - left.lastSeenAt;
      })
      .slice(0, 6)
      .map((fact) => fact.id);

    let phase: TaskPhase = "investigate";
    let health: TaskHealth = "unknown";
    let reason: string | undefined;

    if (!hasSpec && !hasHardBlocker && !hasSoftVerifierBlocker) {
      phase = openItems.length > 0 ? "execute" : "investigate";
      health = "exploring";
      reason =
        openItems.length > 0
          ? `spec_missing_open_items=${openItems.length}`
          : "exploring_without_spec";
    } else if (!hasSpec && hasHardBlocker) {
      phase = "blocked";
      health = "blocked";
      reason = "blockers_present_without_spec";
    } else if (hasHardBlocker) {
      phase = "blocked";
      health = "blocked";
      reason = "blockers_present";
    } else if (openItems.length > 0) {
      phase = "execute";
      health = "ok";
      reason = `open_items=${openItems.length}`;
    } else if (hasSoftVerifierBlocker) {
      phase = "verify";
      health = "verification_failed";
      reason = "verification_blockers_present";
    } else if (items.length === 0) {
      phase = "investigate";
      health = "ok";
      reason = "no_task_items";
    } else {
      const desiredLevel = state.spec?.verification?.level ?? this.config.verification.defaultLevel;
      const report = this.evaluateCompletion(input.sessionId, desiredLevel);
      if (!report.passed) {
        phase = "verify";
        health = "verification_failed";
        reason =
          report.missingEvidence.length > 0
            ? `missing_evidence=${report.missingEvidence.join(",")}`
            : "verification_missing";
      } else if (!acceptanceRequired) {
        phase = "done";
        health = "ok";
        reason = "verification_passed";
      } else if (acceptanceStatus === "accepted") {
        phase = "done";
        health = "ok";
        reason = "acceptance_accepted";
      } else if (acceptanceStatus === "rejected") {
        phase = "execute";
        health = "acceptance_rejected";
        reason = "acceptance_rejected";
      } else {
        phase = "ready_for_acceptance";
        health = "acceptance_pending";
        reason = "acceptance_required";
      }
    }

    if (health === "ok" || health === "exploring") {
      const ratio = resolveContextUsageRatio(input.usage);
      if (ratio !== null && this.isContextBudgetEnabled()) {
        const { compactionThresholdPercent, hardLimitPercent } =
          this.resolveContextBudgetThresholds(input.sessionId, input.usage);
        const threshold = Math.max(0, Math.min(1, compactionThresholdPercent));
        const hardLimit = Math.max(0, Math.min(1, hardLimitPercent));
        if (ratio >= hardLimit || ratio >= threshold) {
          health = "budget_pressure";
          reason = ratio >= hardLimit ? "context_hard_limit_pressure" : "context_usage_pressure";
        }
      }
    }

    return {
      phase,
      health,
      reason,
      updatedAt: Date.now(),
      truthFactIds: truthFactIds.length > 0 ? truthFactIds : undefined,
    };
  }

  maybeAlignTaskStatus(input: TaskStatusAlignmentInput): void {
    const state = this.getTaskState(input.sessionId);
    const next = this.computeTaskStatus(input);
    if (this.isSameTaskStatus(state.status, next)) {
      return;
    }

    this.recordEvent({
      sessionId: input.sessionId,
      type: TASK_EVENT_TYPE,
      payload: buildStatusSetEvent(next) as unknown as Record<string, unknown>,
    });
  }

  setTaskSpec(sessionId: string, spec: TaskSpec): void {
    const normalized = normalizeTaskSpec(spec);
    this.recordEvent({
      sessionId,
      type: TASK_EVENT_TYPE,
      payload: {
        schema: "brewva.task.ledger.v1",
        kind: "spec_set",
        spec: normalized,
      },
    });
    this.alignTaskStatusAfterMutation(sessionId);
  }

  addTaskItem(
    sessionId: string,
    input: { id?: string; text: string; status?: TaskItemStatus },
  ): TaskItemAddResult {
    const text = input.text?.trim();
    if (!text) {
      return { ok: false, error: "missing_text" };
    }

    const payload = buildItemAddedEvent({
      id: input.id?.trim() || undefined,
      text,
      status: input.status,
    });
    this.recordEvent({
      sessionId,
      type: TASK_EVENT_TYPE,
      payload,
    });
    this.alignTaskStatusAfterMutation(sessionId);
    return { ok: true, itemId: payload.item.id };
  }

  updateTaskItem(
    sessionId: string,
    input: { id: string; text?: string; status?: TaskItemStatus },
  ): TaskItemUpdateResult {
    const id = input.id?.trim();
    if (!id) return { ok: false, error: "missing_id" };

    const text = input.text?.trim();
    if (!text && !input.status) {
      return { ok: false, error: "missing_patch" };
    }

    const payload = buildItemUpdatedEvent({
      id,
      text: text || undefined,
      status: input.status,
    });
    this.recordEvent({
      sessionId,
      type: TASK_EVENT_TYPE,
      payload,
    });
    this.alignTaskStatusAfterMutation(sessionId);
    return { ok: true };
  }

  recordTaskBlocker(
    sessionId: string,
    input: {
      id?: string;
      message: string;
      source?: string;
      truthFactId?: string;
    },
  ): TaskBlockerRecordResult {
    const message = input.message?.trim();
    if (!message) {
      return { ok: false, error: "missing_message" };
    }

    const payload = buildBlockerRecordedEvent({
      id: input.id?.trim() || undefined,
      message,
      source: input.source?.trim() || undefined,
      truthFactId: input.truthFactId?.trim() || undefined,
    });
    this.recordEvent({
      sessionId,
      type: TASK_EVENT_TYPE,
      payload,
    });
    this.alignTaskStatusAfterMutation(sessionId);
    return { ok: true, blockerId: payload.blocker.id };
  }

  resolveTaskBlocker(sessionId: string, blockerId: string): TaskBlockerResolveResult {
    const id = blockerId?.trim();
    if (!id) return { ok: false, error: "missing_id" };

    const payload = buildBlockerResolvedEvent(id);
    this.recordEvent({
      sessionId,
      type: TASK_EVENT_TYPE,
      payload,
    });
    this.alignTaskStatusAfterMutation(sessionId);
    return { ok: true };
  }

  recordTaskAcceptance(
    sessionId: string,
    input: {
      status: TaskAcceptanceState["status"];
      decidedBy?: string;
      notes?: string;
    },
  ): TaskAcceptanceRecordResult {
    const status = input.status;
    if (status !== "pending" && status !== "accepted" && status !== "rejected") {
      return { ok: false, error: "invalid_status" };
    }
    const state = this.getTaskState(sessionId);
    if (state.spec?.acceptance?.required !== true) {
      return { ok: false, error: "acceptance_not_enabled" };
    }
    if (state.spec.acceptance.owner && state.spec.acceptance.owner !== "operator") {
      return { ok: false, error: "acceptance_owner_unsupported" };
    }

    const payload = buildAcceptanceSetEvent({
      status,
      updatedAt: Date.now(),
      decidedBy: input.decidedBy?.trim() || undefined,
      notes: input.notes?.trim() || undefined,
    });
    this.recordEvent({
      sessionId,
      type: TASK_EVENT_TYPE,
      payload,
    });
    this.alignTaskStatusAfterMutation(sessionId);
    return { ok: true };
  }
}
