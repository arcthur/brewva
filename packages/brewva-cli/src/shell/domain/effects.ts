import type { DecideEffectCommitmentInput } from "@brewva/brewva-runtime/protocol";
import type { BrewvaPromptContentPart } from "@brewva/brewva-substrate/prompt";
import type {
  BrewvaPromptOptions,
  BrewvaPromptSessionEvent,
} from "@brewva/brewva-substrate/session";
import type { CliShellInput } from "./input.js";

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
  | { type: "overlay.openShortcutOverlay" }
  | { type: "overlay.openInbox" }
  | { type: "overlay.openSessions" }
  | { type: "overlay.openLineage" }
  | { type: "overlay.openQueue" }
  | { type: "overlay.openInspect" }
  | { type: "overlay.openNotifications" }
  | { type: "overlay.openContext" }
  | { type: "overlay.openAuthority" }
  | { type: "overlay.openSkills" }
  | { type: "pager.externalActive" }
  | { type: "transcript.externalPager" }
  | { type: "transcript.copyLatestAnswer" }
  | { type: "transcript.navigate"; kind: "pageUp" | "pageDown" | "top" | "bottom" }
  | { type: "subagentFooter.toggle" }
  | { type: "subagentFooter.close" }
  | { type: "subagentFooter.select"; runId: string }
  | { type: "subagentFooter.selectRelative"; delta: -1 | 1 }
  | { type: "subagentFooter.scroll"; delta: number }
  | { type: "subagentFooter.openSelectedSession" }
  | { type: "subagentFooter.cancelSelected" }
  | { type: "context.requestCompaction" }
  | { type: "session.projectEvent"; event: BrewvaPromptSessionEvent }
  | { type: "session.abort"; notification?: string }
  | { type: "session.create" }
  | { type: "session.diffExternalPager" }
  | { type: "session.exportBundle" }
  | { type: "session.exportInspectBundle" }
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
  | { type: "diff.exportPatchEvidence" }
  | { type: "project.initGuidance" }
  | { type: "url.open"; url: string };
