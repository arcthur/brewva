import type {
  DecideEffectCommitmentInput,
  DecideEffectCommitmentResult,
  PendingEffectCommitmentRequest,
} from "@brewva/brewva-vocabulary/iteration";
import type { ShellCommitOptions } from "../../domain/actions.js";
import type { ShellEffect } from "../../domain/effects.js";
import type { CliShellInput } from "../../domain/input.js";
import { normalizeShellInputKey } from "../../domain/keymap.js";
import type { CliShellOverlayPayload } from "../../domain/overlays/payloads.js";
import type { CliShellAction } from "../../domain/state.js";

type PagerTarget = {
  readonly title: string;
  readonly lines: readonly string[];
};

export interface ShellOperatorOverlayHandlerContext {
  notify(message: string, level: "info" | "warning" | "error"): void;
  commit(action: CliShellAction, options?: ShellCommitOptions): void;
  runShellEffects(effects: readonly ShellEffect[]): Promise<void>;
  decideApproval(
    requestId: string,
    input: DecideEffectCommitmentInput,
  ): Promise<DecideEffectCommitmentResult>;
  refreshOperatorSnapshot(): Promise<void>;
  allowApprovalForRun(request: PendingEffectCommitmentRequest): Promise<void>;
  closeActiveOverlay(cancelled: boolean): void;
  openPagerOverlay(target: PagerTarget, options?: { scrollOffset?: number }): void;
  getExternalPagerTarget(): PagerTarget | undefined;
  getCurrentSessionId(): string;
  openSession(sessionId: string): Promise<void>;
  openSubagentFooter(runId: string): void;
  handleQuestionPrimary(
    active: Extract<CliShellOverlayPayload, { kind: "question" }>,
  ): Promise<void>;
}

export class ShellOperatorOverlayHandler {
  constructor(private readonly context: ShellOperatorOverlayHandlerContext) {}

  async handleShortcut(active: CliShellOverlayPayload, input: CliShellInput): Promise<boolean> {
    if (
      input.ctrl ||
      input.meta ||
      normalizeShellInputKey(input.key) !== "character" ||
      !input.text
    ) {
      return false;
    }
    const key = input.text.toLowerCase();

    if (active.kind === "approval") {
      const item = active.snapshot.approvals[active.selectedIndex];
      if (!item) {
        return true;
      }
      if (key === "a") {
        await this.decideApproval(item.requestId, "accept");
        return true;
      }
      if (key === "w") {
        await this.allowApprovalForRun(item);
        return true;
      }
      if (key === "r") {
        await this.decideApproval(item.requestId, "deny");
        return true;
      }
    }

    if (active.kind === "tasks" && key === "c") {
      const item = active.snapshot.taskRuns[active.selectedIndex];
      if (!item) {
        return true;
      }
      await this.context.runShellEffects([{ type: "operator.stopTask", runId: item.runId }]);
      this.context.notify(`Stopped task ${item.runId}.`, "warning");
      this.context.closeActiveOverlay(false);
      await this.context.refreshOperatorSnapshot();
      return true;
    }

    if (active.kind === "notifications") {
      if (key === "d") {
        const item = active.notifications[active.selectedIndex];
        if (!item) {
          return true;
        }
        this.context.commit(
          {
            type: "notification.dismiss",
            id: item.id,
          },
          { debounceStatus: false },
        );
        return true;
      }
      if (key === "x") {
        this.context.commit(
          {
            type: "notification.clear",
          },
          { debounceStatus: false },
        );
        return true;
      }
    }

    if (active.kind === "inbox") {
      const item = active.items[active.selectedIndex];
      if (key === "d" && item?.kind === "notification") {
        this.context.commit(
          {
            type: "notification.dismiss",
            id: item.notificationId,
          },
          { debounceStatus: false },
        );
        return true;
      }
      if (key === "x" && active.notifications.length > 0) {
        this.context.commit(
          {
            type: "notification.clear",
          },
          { debounceStatus: false },
        );
        return true;
      }
    }

    return false;
  }

  async handlePrimary(active: CliShellOverlayPayload): Promise<boolean> {
    switch (active.kind) {
      case "approval": {
        const item = active.snapshot.approvals[active.selectedIndex];
        if (!item) {
          return true;
        }
        await this.decideApproval(item.requestId, "accept");
        return true;
      }
      case "question":
        await this.context.handleQuestionPrimary(active);
        return true;
      case "tasks": {
        const item = active.snapshot.taskRuns[active.selectedIndex];
        if (!item) {
          return true;
        }
        this.context.commit(
          {
            type: "operator.setTaskRuns",
            taskRuns: active.snapshot.taskRuns,
          },
          { debounceStatus: false },
        );
        this.context.closeActiveOverlay(false);
        this.context.openSubagentFooter(item.runId);
        return true;
      }
      case "sessions": {
        const item = active.sessions[active.selectedIndex];
        if (!item) {
          return true;
        }
        if (item.sessionId === this.context.getCurrentSessionId()) {
          this.context.closeActiveOverlay(false);
          return true;
        }
        await this.context.openSession(item.sessionId);
        this.context.closeActiveOverlay(false);
        return true;
      }
      case "notifications": {
        const item = active.notifications[active.selectedIndex];
        if (!item) {
          return true;
        }
        return this.openDetailPager();
      }
      case "inspect": {
        const section = active.sections[active.selectedIndex];
        if (!section) {
          return true;
        }
        return this.openDetailPager(active.scrollOffsets[active.selectedIndex] ?? 0);
      }
      default:
        return false;
    }
  }

  private async decideApproval(
    requestId: string,
    decision: "accept" | "deny" | "cancel",
  ): Promise<void> {
    const result = await this.context.decideApproval(requestId, {
      decision,
      actor: "brewva-cli",
    });
    if (result.applied) {
      this.context.notify(
        `${decision === "accept" ? "Allowed" : "Denied"} ${requestId}.`,
        decision === "accept" ? "info" : "warning",
      );
    } else {
      this.context.notify(
        `Request ${requestId} is already ${result.alreadyDecidedState ?? "decided"}; your ${decision} was recorded as a no-op receipt.`,
        "warning",
      );
    }
    this.context.closeActiveOverlay(false);
    await this.context.refreshOperatorSnapshot();
  }

  private async allowApprovalForRun(request: PendingEffectCommitmentRequest): Promise<void> {
    await this.context.allowApprovalForRun(request);
    this.context.notify(`Always allowing ${request.toolName} for this run.`, "info");
    this.context.closeActiveOverlay(false);
    await this.context.refreshOperatorSnapshot();
  }

  private openDetailPager(scrollOffset = 0): true {
    const detailTarget = this.context.getExternalPagerTarget();
    if (detailTarget) {
      this.context.openPagerOverlay(detailTarget, { scrollOffset });
    }
    return true;
  }
}
