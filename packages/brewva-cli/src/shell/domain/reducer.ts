import type { ShellAction, ShellRuntimeResult } from "./actions.js";
import type { SessionHandoffDraft, ShellEffect } from "./effects.js";
import type { ShellIntent } from "./intent.js";
import type { OperatorSurfaceSnapshot } from "./operator-snapshot.js";
import type { CliShellViewState } from "./state.js";

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

function parseSessionHandoffDraft(args: string): SessionHandoffDraft | undefined {
  const trimmed = args.trim();
  if (!trimmed) {
    return undefined;
  }
  const parts = trimmed
    .split(/\s*::\s*/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length >= 3) {
    return {
      name: parts[0],
      summary: parts[1],
      nextSteps: parts.slice(2).join(" :: "),
    };
  }
  if (parts.length === 2) {
    return {
      name: parts[0],
      summary: parts[1],
    };
  }
  return { summary: trimmed };
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
    case "session.context":
      return intent.args.trim() === "compact"
        ? handled({
            effects: [
              {
                type: "notification.show",
                message:
                  "Use /context, then Request compaction; /context compact is not a canonical command.",
                level: "warning",
              },
              { type: "overlay.openContext" },
            ],
          })
        : handled({ effects: [{ type: "overlay.openContext" }] });
    case "session.transcript":
      return handled({ effects: [{ type: "transcript.externalPager" }] });
    case "session.diff":
      return handled({ effects: [{ type: "session.diffExternalPager" }] });
    case "transcript.copy":
      return handled({ effects: [{ type: "transcript.copyLatestAnswer" }] });
    case "session.export":
      return handled({ effects: [{ type: "session.exportBundle" }] });
    case "session.handoff":
      return handled({
        effects: [{ type: "session.handoff", handoff: parseSessionHandoffDraft(intent.args) }],
      });
    case "session.lineage":
      return handled({ effects: [{ type: "overlay.openLineage" }] });
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
    case "operator.authority":
      return handled({ effects: [{ type: "overlay.openAuthority" }] });
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
    case "skills.catalog":
      return handled({ effects: [{ type: "overlay.openSkills" }] });
    case "project.init":
      return handled({ effects: [{ type: "project.initGuidance" }] });
    case "context.requestCompaction":
      return handled({ effects: [{ type: "context.requestCompaction" }] });
    case "transcript.copyLatestAnswer":
      return handled({ effects: [{ type: "transcript.copyLatestAnswer" }] });
    case "session.exportInspectBundle":
      return handled({ effects: [{ type: "session.exportInspectBundle" }] });
    case "diff.exportPatchEvidence":
      return handled({ effects: [{ type: "diff.exportPatchEvidence" }] });
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
    case "prompt.submit":
      return handled({
        effects: [
          ...(intent.warnings ?? []).map((message) => ({
            type: "notification.show" as const,
            message,
            level: "warning" as const,
          })),
          {
            type: "session.prompt",
            sessionGeneration: context.sessionGeneration,
            parts: [{ type: "text", text: intent.text }],
            options: { source: intent.source },
          },
        ],
      });
    case "effect.dispatch":
      return handled({ effects: [intent.effect] });
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
