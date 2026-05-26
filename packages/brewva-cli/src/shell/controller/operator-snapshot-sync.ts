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

export class ShellOperatorSnapshotSync {
  readonly #seenApprovals = new Set<string>();
  readonly #seenQuestions = new Set<string>();

  constructor(private readonly context: ShellOperatorSnapshotSyncContext) {}

  resetSeen(): void {
    this.#seenApprovals.clear();
    this.#seenQuestions.clear();
  }

  syncOverlay(snapshot: OperatorSurfaceSnapshot): void {
    this.context.overlayHandler.syncSnapshotOverlay(snapshot);
  }

  async refresh(sessionGeneration = this.context.getSessionGeneration()): Promise<void> {
    const snapshot = await this.context.getSnapshot();
    if (this.context.isDisposed() || sessionGeneration !== this.context.getSessionGeneration()) {
      return;
    }
    this.context.setSnapshot(snapshot);
    this.syncOverlay(snapshot);
    this.commitStatus(snapshot);
    this.openNewApproval(snapshot);
    this.openNewQuestion(snapshot);
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
    const newApproval = snapshot.approvals.find((item) => !this.#seenApprovals.has(item.requestId));
    if (!newApproval) {
      return;
    }
    for (const item of snapshot.approvals) {
      this.#seenApprovals.add(item.requestId);
    }
    this.context.overlayHandler.openOverlay(
      {
        kind: "approval",
        selectedIndex: snapshot.approvals.findIndex(
          (item) => item.requestId === newApproval.requestId,
        ),
        snapshot,
      },
      "queued",
    );
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
