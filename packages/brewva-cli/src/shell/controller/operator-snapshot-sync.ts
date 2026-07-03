import type { ShellAction } from "../domain/actions.js";
import {
  buildOperatorSafetyShellIdleView,
  buildOperatorSafetyShellSessionView,
} from "../domain/operator-safety/shell-view.js";
import type { OperatorSurfaceSnapshot } from "../domain/operator-snapshot.js";
import { questionRequestsFromSnapshot } from "../domain/question-utils.js";
import type { CliShellViewState } from "../domain/state.js";
import type { ShellOverlayLifecycleHandler } from "../overlays/lifecycle.js";

export interface ShellOperatorSnapshotSyncContext {
  isDisposed(): boolean;
  getSessionGeneration(): number;
  getState(): CliShellViewState;
  getSnapshot(): Promise<OperatorSurfaceSnapshot>;
  setSnapshot(snapshot: OperatorSurfaceSnapshot): void;
  commit(actions: readonly ShellAction[], options?: { debounceStatus?: boolean }): void;
  overlayHandler: ShellOverlayLifecycleHandler;
}

function signatureValue(value: string | number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function signatureTuple(values: readonly (string | number | null | undefined)[]): string {
  return values.map(signatureValue).join("\u001f");
}

function snapshotSignature(snapshot: OperatorSurfaceSnapshot): string {
  return [
    `approvals:${snapshot.approvals.length}:${snapshot.approvals
      .map((approval) =>
        signatureTuple([
          approval.requestId,
          approval.state,
          approval.toolCallId,
          approval.createdAt,
          approval.proposalId,
        ]),
      )
      .join("\u001e")}`,
    `questions:${snapshot.questions.length}:${snapshot.questions
      .map((question) =>
        signatureTuple([
          question.questionId,
          question.requestId,
          question.sourceEventId,
          question.createdAt,
          question.requestPosition,
          question.requestSize,
        ]),
      )
      .join("\u001e")}`,
    `tasks:${snapshot.taskRuns.length}:${snapshot.taskRuns
      .map((run) =>
        signatureTuple([
          run.runId,
          run.status,
          run.updatedAt,
          run.completedAt,
          run.totalTokens,
          run.costUsd,
        ]),
      )
      .join("\u001e")}`,
    `sessions:${snapshot.sessions.length}:${snapshot.sessions
      .map((session) =>
        signatureTuple([session.sessionId, session.eventCount, session.lastEventAt]),
      )
      .join("\u001e")}`,
  ].join("\u001d");
}

export class ShellOperatorSnapshotSync {
  readonly #seenQuestions = new Set<string>();
  #lastSnapshotSignature: string | undefined;

  constructor(private readonly context: ShellOperatorSnapshotSyncContext) {}

  resetSeen(): void {
    this.#seenQuestions.clear();
    this.#lastSnapshotSignature = undefined;
  }

  syncOverlay(snapshot: OperatorSurfaceSnapshot): void {
    this.context.overlayHandler.syncSnapshotOverlay(snapshot);
  }

  async refresh(sessionGeneration = this.context.getSessionGeneration()): Promise<boolean> {
    const snapshot = await this.context.getSnapshot();
    if (this.context.isDisposed() || sessionGeneration !== this.context.getSessionGeneration()) {
      return false;
    }
    this.context.setSnapshot(snapshot);
    const signature = snapshotSignature(snapshot);
    if (this.#lastSnapshotSignature === signature) {
      return false;
    }
    this.#lastSnapshotSignature = signature;
    this.syncOverlay(snapshot);
    this.commitStatus(snapshot);
    this.openNewApproval(snapshot);
    this.openNewQuestion(snapshot);
    return true;
  }

  private commitStatus(snapshot: OperatorSurfaceSnapshot): void {
    const shouldClearApprovalSafety =
      snapshot.approvals.length === 0 && this.context.getState().status.safety?.source === "ask";
    const safetyActions: ShellAction[] = [];
    if (snapshot.approvals.length > 0) {
      safetyActions.push({
        type: "status.setSafety",
        safety: buildOperatorSafetyShellSessionView({
          pendingAskCount: snapshot.approvals.length,
        }),
      });
    } else if (shouldClearApprovalSafety) {
      safetyActions.push({
        type: "status.setSafety",
        safety: buildOperatorSafetyShellIdleView(),
      });
    }
    this.context.commit(
      [
        {
          type: "status.set",
          key: "approvals",
          text: String(snapshot.approvals.length),
        },
        {
          type: "status.set",
          key: "questions",
          text: String(snapshot.questions.length),
        },
        {
          type: "status.set",
          key: "tasks",
          text: String(snapshot.taskRuns.length),
        },
        {
          type: "operator.setTaskRuns",
          taskRuns: snapshot.taskRuns,
        },
        ...safetyActions,
      ],
      { debounceStatus: false },
    );
  }

  private openNewApproval(snapshot: OperatorSurfaceSnapshot): void {
    if (snapshot.approvals.length === 0) {
      return;
    }
    // Surface the overlay whenever an approval is pending and none is currently
    // being presented. Gating on "is one already on screen?" (not a one-shot
    // "have I ever seen this requestId?") is what makes the overlay RECOVERABLE:
    // if the operator dismisses it with the approval still pending, the next
    // snapshot change re-surfaces it instead of leaving the request reachable
    // only through the (easily missed) leader-a review command. The snapshot
    // signature guard upstream means a plain dismiss does not immediately
    // re-open it, so escape still works.
    if (this.isApprovalOverlayPresented()) {
      return;
    }
    this.context.overlayHandler.openOverlay(
      {
        kind: "approval",
        selectedIndex: 0,
        snapshot,
      },
      "queued",
    );
  }

  private isApprovalOverlayPresented(): boolean {
    const overlay = this.context.getState().overlay;
    if (overlay.active?.payload?.kind === "approval") {
      return true;
    }
    return overlay.queue.some((entry) => entry.payload?.kind === "approval");
  }

  private openNewQuestion(snapshot: OperatorSurfaceSnapshot): void {
    const questionRequests = questionRequestsFromSnapshot(snapshot);
    const newQuestionRequest = questionRequests.find(
      (item) => !this.#seenQuestions.has(item.requestId),
    );
    if (!newQuestionRequest) {
      return;
    }
    for (const item of questionRequests) {
      this.#seenQuestions.add(item.requestId);
    }
    this.context.overlayHandler.openOverlay(
      {
        kind: "question",
        mode: "operator",
        selectedIndex: questionRequests.findIndex(
          (item) => item.requestId === newQuestionRequest.requestId,
        ),
        snapshot,
      },
      "queued",
    );
  }
}
