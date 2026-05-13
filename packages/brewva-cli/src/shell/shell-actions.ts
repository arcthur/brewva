import type { DecideEffectCommitmentInput } from "@brewva/brewva-runtime/proposals";
import type { BrewvaPromptContentPart } from "@brewva/brewva-substrate/prompt";
import type {
  BrewvaPromptOptions,
  BrewvaPromptSessionEvent,
} from "@brewva/brewva-substrate/session";
import type { OverlayPriority } from "@brewva/brewva-tui";
import type { CliShellAction } from "./state/index.js";
import type { CliShellInput } from "./types.js";
import type { CliShellOverlayPayload } from "./types.js";

export type ShellKeybindingAction =
  | { type: "composer.submit" }
  | { type: "composer.newline" }
  | { type: "completion.accept" }
  | { type: "completion.submit" }
  | { type: "completion.next" }
  | { type: "completion.previous" }
  | { type: "completion.dismiss" }
  | { type: "overlay.close" }
  | { type: "overlay.primary" }
  | { type: "overlay.next" }
  | { type: "overlay.previous" }
  | { type: "overlay.pageDown" }
  | { type: "overlay.pageUp" }
  | { type: "overlay.fullscreen" }
  | { type: "pager.external" }
  | { type: "transcript.pageUp" }
  | { type: "transcript.pageDown" }
  | { type: "transcript.top" }
  | { type: "transcript.bottom" }
  | { type: "command.run"; commandId: string }
  | { type: "unknown"; action: string };

export type ShellIntent =
  | { type: "input.received"; input: CliShellInput }
  | { type: "keybinding.invoke"; action: ShellKeybindingAction }
  | { type: "dialog.input"; input: CliShellInput }
  | { type: "question.input"; input: CliShellInput }
  | { type: "picker.input"; input: CliShellInput }
  | { type: "overlay.input"; input: CliShellInput }
  | { type: "promptHistory.navigate"; direction: -1 | 1 }
  | {
      type: "command.invoke";
      commandId: string;
      args: string;
      source: "keybinding" | "palette" | "slash" | "internal";
    }
  | { type: "session.event"; event: BrewvaPromptSessionEvent }
  | { type: "operator.refresh" };

export type ShellAction =
  | CliShellAction
  | {
      type: "domain.sessionGeneration.increment";
    }
  | {
      type: "domain.sessionGeneration.set";
      sessionGeneration: number;
    }
  | {
      type: "overlay.openData";
      payload: CliShellOverlayPayload;
      priority?: OverlayPriority;
      suspendCurrent?: boolean;
      id?: string;
    }
  | {
      type: "overlay.replaceData";
      payload: CliShellOverlayPayload;
    };

export interface ShellCommitOptions {
  readonly refreshCompletions?: boolean;
  readonly debounceStatus?: boolean;
  readonly emitChange?: boolean;
}

export interface ShellCommitBatch {
  readonly reset?: { readonly sessionGeneration: number };
  readonly actions?: readonly ShellAction[];
}

export type ShellCommitInput = ShellAction | readonly ShellAction[] | ShellCommitBatch;

export type ShellEffect =
  | { type: "input.handle"; input: CliShellInput }
  | { type: "runtime.exit" }
  | { type: "notification.show"; message: string; level: "info" | "warning" | "error" }
  | { type: "command.invokeById"; commandId: string; source: "keybinding" | "palette" }
  | { type: "composer.submit" }
  | { type: "composer.insertNewline" }
  | { type: "promptHistory.navigate"; direction: -1 | 1 }
  | { type: "promptMemory.stashCurrent" }
  | { type: "promptMemory.restoreLatest" }
  | { type: "promptMemory.selectStashed" }
  | { type: "completion.accept" }
  | { type: "completion.submit" }
  | { type: "completion.move"; delta: -1 | 1 }
  | { type: "completion.dismiss" }
  | { type: "dialog.input"; input: CliShellInput }
  | { type: "question.input"; input: CliShellInput }
  | { type: "picker.input"; input: CliShellInput }
  | { type: "overlay.input"; input: CliShellInput }
  | { type: "overlay.closeActive"; cancelled: boolean }
  | { type: "overlay.primary" }
  | { type: "overlay.moveSelection"; delta: -1 | 1 }
  | { type: "overlay.scrollPage"; direction: -1 | 1 }
  | { type: "overlay.toggleFullscreen" }
  | { type: "overlay.openCommandPalette"; query?: string }
  | { type: "overlay.openHelpHub" }
  | { type: "overlay.openInbox" }
  | { type: "overlay.openSessions" }
  | { type: "overlay.openLineage" }
  | { type: "overlay.openQueue" }
  | { type: "overlay.openInspect" }
  | { type: "overlay.openNotifications" }
  | { type: "pager.externalActive" }
  | { type: "transcript.externalPager" }
  | { type: "transcript.navigate"; kind: "pageUp" | "pageDown" | "top" | "bottom" }
  | { type: "session.projectEvent"; event: BrewvaPromptSessionEvent }
  | { type: "session.abort"; notification?: string }
  | { type: "session.create" }
  | { type: "session.steer"; sessionGeneration: number; text: string }
  | { type: "session.undo" }
  | { type: "session.rewind"; argument?: string }
  | { type: "session.redo" }
  | { type: "model.open"; query?: string }
  | { type: "model.cycleRecent" }
  | { type: "modelPreset.cycleNext" }
  | { type: "provider.openConnect"; query?: string }
  | { type: "thinking.open" }
  | { type: "view.toggleThinking" }
  | { type: "view.toggleToolDetails" }
  | { type: "view.toggleDiffWrap" }
  | { type: "view.toggleDiffStyle" }
  | { type: "theme.list" }
  | { type: "theme.set"; selection: string }
  | { type: "completion.refresh" }
  | { type: "operator.refresh"; sessionGeneration: number }
  | {
      type: "operator.decideApproval";
      requestId: string;
      input: DecideEffectCommitmentInput;
    }
  | { type: "operator.answerQuestion"; questionId: string; answerText: string }
  | {
      type: "operator.answerQuestionRequest";
      requestId: string;
      answers: readonly (readonly string[])[];
    }
  | { type: "operator.stopTask"; runId: string }
  | { type: "status.flush"; delayMs: number }
  | {
      type: "session.prompt";
      sessionGeneration: number;
      parts: readonly BrewvaPromptContentPart[];
      options?: BrewvaPromptOptions;
    }
  | { type: "external.editor"; title: string; prefill?: string }
  | { type: "external.pager"; title: string; lines: readonly string[] }
  | {
      type: "provider.connectApiKey";
      providerId: string;
      apiKey: string;
      inputs?: Record<string, string>;
    }
  | { type: "provider.completeOAuth"; providerId: string; methodId: string; code?: string }
  | { type: "provider.disconnect"; providerId: string }
  | { type: "clipboard.copy"; text: string }
  | { type: "url.open"; url: string };

export interface ShellRuntimeResult {
  actions: readonly ShellAction[];
  effects: readonly ShellEffect[];
}
