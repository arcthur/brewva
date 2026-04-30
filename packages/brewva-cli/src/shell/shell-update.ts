import type { ShellRuntimeResult, ShellEffect, ShellIntent } from "./shell-actions.js";
import type { ShellAction, ShellKeybindingAction } from "./shell-actions.js";
import type { CliShellViewState } from "./state/index.js";
import type { OperatorSurfaceSnapshot } from "./types.js";

interface PagerTarget {
  title: string;
  lines: readonly string[];
}

export interface ShellUpdateContext {
  view: CliShellViewState;
  sessionGeneration: number;
  isStreaming: boolean;
  operatorSnapshot: OperatorSurfaceSnapshot;
  externalPagerTarget?: PagerTarget;
}

export interface ShellUpdateResult extends ShellRuntimeResult {
  handled: boolean;
}

function handled(
  input: {
    actions?: readonly ShellAction[];
    effects?: readonly ShellEffect[];
  } = {},
): ShellUpdateResult {
  return {
    handled: true,
    actions: input.actions ?? [],
    effects: input.effects ?? [],
  };
}

function unhandled(
  input: {
    actions?: readonly ShellAction[];
    effects?: readonly ShellEffect[];
  } = {},
): ShellUpdateResult {
  return {
    handled: false,
    actions: input.actions ?? [],
    effects: input.effects ?? [],
  };
}

function updateShellKeybindingAction(action: ShellKeybindingAction): ShellUpdateResult {
  switch (action.type) {
    case "command.run":
      return handled({
        effects: [
          {
            type: "command.invokeById",
            commandId: action.commandId,
            source: "keybinding",
          },
        ],
      });
    case "composer.submit":
      return handled({ effects: [{ type: "composer.submit" }] });
    case "composer.newline":
      return handled({ effects: [{ type: "composer.insertNewline" }] });
    case "completion.accept":
      return handled({ effects: [{ type: "completion.accept" }] });
    case "completion.submit":
      return handled({ effects: [{ type: "completion.submit" }] });
    case "completion.next":
      return handled({ effects: [{ type: "completion.move", delta: 1 }] });
    case "completion.previous":
      return handled({ effects: [{ type: "completion.move", delta: -1 }] });
    case "completion.dismiss":
      return handled({ effects: [{ type: "completion.dismiss" }] });
    case "overlay.close":
      return handled({ effects: [{ type: "overlay.closeActive", cancelled: true }] });
    case "overlay.primary":
      return handled({ effects: [{ type: "overlay.primary" }] });
    case "overlay.next":
      return handled({ effects: [{ type: "overlay.moveSelection", delta: 1 }] });
    case "overlay.previous":
      return handled({ effects: [{ type: "overlay.moveSelection", delta: -1 }] });
    case "overlay.pageDown":
      return handled({ effects: [{ type: "overlay.scrollPage", direction: 1 }] });
    case "overlay.pageUp":
      return handled({ effects: [{ type: "overlay.scrollPage", direction: -1 }] });
    case "overlay.fullscreen":
      return handled({ effects: [{ type: "overlay.toggleFullscreen" }] });
    case "pager.external":
      return handled({ effects: [{ type: "pager.externalActive" }] });
    case "transcript.pageUp":
      return handled({ effects: [{ type: "transcript.navigate", kind: "pageUp" }] });
    case "transcript.pageDown":
      return handled({ effects: [{ type: "transcript.navigate", kind: "pageDown" }] });
    case "transcript.top":
      return handled({ effects: [{ type: "transcript.navigate", kind: "top" }] });
    case "transcript.bottom":
      return handled({ effects: [{ type: "transcript.navigate", kind: "bottom" }] });
    case "unknown":
      return handled();
    default:
      action satisfies never;
      return unhandled();
  }
}

function updateCommandIntent(
  context: ShellUpdateContext,
  intent: Extract<ShellIntent, { type: "command.invoke" }>,
): ShellUpdateResult {
  switch (intent.commandId) {
    case "app.commandPalette":
      return handled({ effects: [{ type: "overlay.openCommandPalette" }] });
    case "app.help":
      return handled({ effects: [{ type: "overlay.openHelpHub" }] });
    case "app.exit":
      return handled({ effects: [{ type: "runtime.exit" }] });
    case "app.abortOrExit":
      return context.isStreaming
        ? handled({
            effects: [{ type: "session.abort", notification: "Aborted the current turn." }],
          })
        : handled({ effects: [{ type: "runtime.exit" }] });
    case "composer.editor":
      return handled({
        effects: [
          context.externalPagerTarget
            ? {
                type: "external.pager",
                title: context.externalPagerTarget.title,
                lines: context.externalPagerTarget.lines,
              }
            : {
                type: "external.editor",
                title: "brewva-composer",
                prefill: context.view.composer.text,
              },
        ],
      });
    case "session.new":
      return handled({ effects: [{ type: "session.create" }] });
    case "session.list":
      return handled({ effects: [{ type: "overlay.openSessions" }] });
    case "session.inspect":
      return handled({ effects: [{ type: "overlay.openInspect" }] });
    case "session.queue":
      return handled({ effects: [{ type: "overlay.openQueue" }] });
    case "session.undo":
      return handled({ effects: [{ type: "session.undo" }] });
    case "session.rewind":
      return handled({
        effects: [{ type: "session.rewind", argument: intent.args.trim() || undefined }],
      });
    case "session.redo":
      return handled({ effects: [{ type: "session.redo" }] });
    case "agent.model":
      return intent.args.trim() === "recent"
        ? handled({ effects: [{ type: "model.cycleRecent" }] })
        : handled({
            effects: [
              {
                type: "model.open",
                query: intent.args.trim() ? intent.args.trim() : undefined,
              },
            ],
          });
    case "agent.preset.next":
      return handled({ effects: [{ type: "modelPreset.cycleNext" }] });
    case "agent.connect":
      return handled({
        effects: [{ type: "provider.openConnect", query: intent.args.trim() || undefined }],
      });
    case "agent.think":
      return handled({ effects: [{ type: "thinking.open" }] });
    case "agent.steer": {
      const text = intent.args.trim();
      if (!text) {
        return handled({
          effects: [
            {
              type: "notification.show",
              message: "Usage: /steer <text>",
              level: "warning",
            },
          ],
        });
      }
      return handled({
        effects: [
          {
            type: "session.steer",
            sessionGeneration: context.sessionGeneration,
            text,
          },
        ],
      });
    }
    case "view.thinking":
      return handled({ effects: [{ type: "view.toggleThinking" }] });
    case "view.toolDetails":
      return handled({ effects: [{ type: "view.toggleToolDetails" }] });
    case "view.diffWrap":
      return handled({ effects: [{ type: "view.toggleDiffWrap" }] });
    case "view.diffStyle":
      return handled({ effects: [{ type: "view.toggleDiffStyle" }] });
    case "operator.approvals":
      return handled({
        actions: [
          {
            type: "overlay.openData",
            payload: { kind: "approval", selectedIndex: 0, snapshot: context.operatorSnapshot },
          },
        ],
      });
    case "operator.inbox":
      return handled({ effects: [{ type: "overlay.openInbox" }] });
    case "operator.questions":
      return handled({
        actions: [
          {
            type: "overlay.openData",
            payload: {
              kind: "question",
              mode: "operator",
              selectedIndex: 0,
              snapshot: context.operatorSnapshot,
            },
          },
        ],
      });
    case "operator.tasks":
      return handled({
        actions: [
          {
            type: "overlay.openData",
            payload: { kind: "tasks", selectedIndex: 0, snapshot: context.operatorSnapshot },
          },
        ],
      });
    case "operator.notifications":
      return handled({ effects: [{ type: "overlay.openNotifications" }] });
    case "operator.answer": {
      const [questionId, ...answerParts] = intent.args.trim().split(/\s+/u);
      const answerText = answerParts.join(" ").trim();
      if (!questionId || !answerText) {
        return handled({
          effects: [
            {
              type: "notification.show",
              message: "Usage: /answer <questionId> <text>",
              level: "warning",
            },
          ],
        });
      }
      return handled({
        effects: [
          { type: "operator.answerQuestion", questionId, answerText },
          { type: "operator.refresh", sessionGeneration: context.sessionGeneration },
        ],
      });
    }
    case "system.theme": {
      const selection = intent.args.trim();
      return handled({
        effects: [
          selection && selection !== "list"
            ? { type: "theme.set", selection }
            : { type: "theme.list" },
        ],
      });
    }
    case "composer.stash":
      if (intent.source === "keybinding") {
        return handled({ effects: [{ type: "promptMemory.stashCurrent" }] });
      }
      if (intent.args.trim() === "pop") {
        return handled({ effects: [{ type: "promptMemory.restoreLatest" }] });
      }
      return handled({ effects: [{ type: "promptMemory.selectStashed" }] });
    case "composer.unstash":
      return handled({ effects: [{ type: "promptMemory.restoreLatest" }] });
    default:
      return unhandled({
        effects: [
          {
            type: "notification.show",
            message: `Unknown command: ${intent.commandId}`,
            level: "warning",
          },
        ],
      });
  }
}

export function updateShellIntent(
  context: ShellUpdateContext,
  intent: ShellIntent,
): ShellUpdateResult {
  switch (intent.type) {
    case "input.received":
      return handled({ effects: [{ type: "input.handle", input: intent.input }] });
    case "keybinding.invoke":
      return updateShellKeybindingAction(intent.action);
    case "dialog.input":
      return handled({ effects: [{ type: "dialog.input", input: intent.input }] });
    case "question.input":
      return handled({ effects: [{ type: "question.input", input: intent.input }] });
    case "picker.input":
      return handled({ effects: [{ type: "picker.input", input: intent.input }] });
    case "overlay.input":
      return context.view.overlay.active?.payload
        ? handled({ effects: [{ type: "overlay.input", input: intent.input }] })
        : unhandled();
    case "promptHistory.navigate":
      return handled({
        effects: [{ type: "promptHistory.navigate", direction: intent.direction }],
      });
    case "command.invoke":
      return updateCommandIntent(context, intent);
    case "session.event":
      return handled({ effects: [{ type: "session.projectEvent", event: intent.event }] });
    case "operator.refresh":
      return handled({
        effects: [{ type: "operator.refresh", sessionGeneration: context.sessionGeneration }],
      });
    default:
      intent satisfies never;
      return unhandled();
  }
}
