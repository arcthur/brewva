import type { DecideEffectCommitmentInput } from "@brewva/brewva-runtime/protocol";
import type { ShellEffect } from "../domain/effects.js";
import type { CliShellInput } from "../domain/input.js";
import { buildTextTranscriptMessage } from "../domain/transcript.js";

export interface ShellEffectDispatcherContext {
  handleInputNow(input: CliShellInput): Promise<boolean>;
  resolveExit(): void;
  notify(message: string, level?: "info" | "warning" | "error"): void;
  invokeCommand(
    commandId: string,
    source: "keybinding" | "palette" | "slash" | "internal",
  ): Promise<void>;
  submitComposer(): Promise<void>;
  insertComposerNewline(): void;
  navigatePromptHistory(direction: -1 | 1): void;
  stashCurrentPrompt(): void;
  restoreLatestStash(): void;
  selectStashedPrompt(): Promise<void>;
  acceptCompletion(): void;
  submitCompletion(): Promise<void>;
  moveCompletion(delta: -1 | 1): void;
  dismissCompletion(): void;
  refreshCompletion(): void;
  handleDialogInput(input: CliShellInput): void;
  handleQuestionInput(input: CliShellInput): Promise<void>;
  handlePickerInput(input: CliShellInput): Promise<void>;
  handleOverlayInput(input: CliShellInput): Promise<void>;
  closeActiveOverlay(cancelled: boolean): void;
  activatePrimaryOverlayAction(): Promise<void>;
  moveOverlaySelection(delta: -1 | 1): void;
  scrollOverlayPage(direction: -1 | 1): void;
  toggleOverlayFullscreen(): void;
  openCommandPalette(query?: string): void;
  openHelpHub(): void;
  openInbox(): void;
  openSessions(): void;
  openLineage(): void;
  openQueue(): void;
  openInspect(): Promise<void>;
  openNotifications(): void;
  openContext(): void;
  openAuthority(): void;
  openSkills(): void;
  openActivePagerExternally(): Promise<void>;
  openExternalTranscriptPager(): Promise<boolean>;
  copyLatestAssistantAnswer(): Promise<void>;
  requestTranscriptNavigation(kind: "pageUp" | "pageDown" | "top" | "bottom"): void;
  requestContextCompaction(): void;
  projectSessionEvent(effect: Extract<ShellEffect, { type: "session.projectEvent" }>): void;
  abortSession(notification?: string): Promise<void>;
  createSession(): Promise<void>;
  openSessionDiffExternalPager(): Promise<void>;
  exportSessionBundle(): Promise<void>;
  exportInspectBundle(): Promise<void>;
  steerSession(effect: Extract<ShellEffect, { type: "session.steer" }>): Promise<void>;
  undoSession(): Promise<void>;
  rewindSession(argument?: string): Promise<void>;
  redoSession(): Promise<void>;
  openModel(query?: string): Promise<void>;
  cycleRecentModel(): Promise<void>;
  cycleNextModelPreset(): Promise<void>;
  openProviderConnect(query?: string): Promise<void>;
  openThinking(): Promise<void>;
  toggleThinkingVisibility(): void;
  toggleToolDetails(): void;
  toggleDiffWrap(): void;
  toggleDiffStyle(): void;
  listThemes(): void;
  setTheme(selection: string): void;
  refreshOperator(sessionGeneration: number): Promise<void>;
  decideApproval(requestId: string, input: DecideEffectCommitmentInput): Promise<void>;
  answerQuestion(questionId: string, answerText: string): Promise<void>;
  answerQuestionRequest(requestId: string, answers: readonly (readonly string[])[]): Promise<void>;
  stopTask(runId: string): Promise<void>;
  scheduleStatusFlush(delayMs: number): void;
  promptSession(
    sessionGeneration: number,
    parts: Extract<ShellEffect, { type: "session.prompt" }>["parts"],
    options: Extract<ShellEffect, { type: "session.prompt" }>["options"],
  ): Promise<void>;
  openExternalEditorEffect(title: string, prefill?: string): Promise<void>;
  openExternalPagerEffect(title: string, lines: readonly string[]): Promise<void>;
  connectProviderApiKey(
    providerId: string,
    apiKey: string,
    inputs: Record<string, string> | undefined,
  ): Promise<void>;
  completeProviderOAuth(
    providerId: string,
    methodId: string,
    code: string | undefined,
  ): Promise<void>;
  disconnectProvider(providerId: string): Promise<void>;
  copyToClipboard(text: string): Promise<void>;
  exportPatchEvidence(): Promise<void>;
  previewProjectGuidanceInit(): Promise<void>;
  openUrl(url: string): Promise<void>;
}

export async function dispatchShellEffect(
  context: ShellEffectDispatcherContext,
  effect: ShellEffect,
): Promise<void> {
  switch (effect.type) {
    case "input.handle":
      await context.handleInputNow(effect.input);
      return;
    case "runtime.exit":
      context.resolveExit();
      return;
    case "notification.show":
      context.notify(effect.message, effect.level);
      return;
    case "command.invokeById":
      await context.invokeCommand(effect.commandId, effect.source);
      return;
    case "composer.submit":
      await context.submitComposer();
      return;
    case "composer.insertNewline":
      context.insertComposerNewline();
      return;
    case "promptHistory.navigate":
      context.navigatePromptHistory(effect.direction);
      return;
    case "promptMemory.stashCurrent":
      context.stashCurrentPrompt();
      return;
    case "promptMemory.restoreLatest":
      context.restoreLatestStash();
      return;
    case "promptMemory.selectStashed":
      await context.selectStashedPrompt();
      return;
    case "completion.accept":
      context.acceptCompletion();
      return;
    case "completion.submit":
      await context.submitCompletion();
      return;
    case "completion.move":
      context.moveCompletion(effect.delta);
      return;
    case "completion.dismiss":
      context.dismissCompletion();
      return;
    case "completion.refresh":
      context.refreshCompletion();
      return;
    case "dialog.input":
      context.handleDialogInput(effect.input);
      return;
    case "question.input":
      await context.handleQuestionInput(effect.input);
      return;
    case "picker.input":
      await context.handlePickerInput(effect.input);
      return;
    case "overlay.input":
      await context.handleOverlayInput(effect.input);
      return;
    case "overlay.closeActive":
      context.closeActiveOverlay(effect.cancelled);
      return;
    case "overlay.primary":
      await context.activatePrimaryOverlayAction();
      return;
    case "overlay.moveSelection":
      context.moveOverlaySelection(effect.delta);
      return;
    case "overlay.scrollPage":
      context.scrollOverlayPage(effect.direction);
      return;
    case "overlay.toggleFullscreen":
      context.toggleOverlayFullscreen();
      return;
    case "overlay.openCommandPalette":
      context.openCommandPalette(effect.query);
      return;
    case "overlay.openHelpHub":
      context.openHelpHub();
      return;
    case "overlay.openInbox":
      context.openInbox();
      return;
    case "overlay.openSessions":
      context.openSessions();
      return;
    case "overlay.openLineage":
      context.openLineage();
      return;
    case "overlay.openQueue":
      context.openQueue();
      return;
    case "overlay.openInspect":
      await context.openInspect();
      return;
    case "overlay.openNotifications":
      context.openNotifications();
      return;
    case "overlay.openContext":
      context.openContext();
      return;
    case "overlay.openAuthority":
      context.openAuthority();
      return;
    case "overlay.openSkills":
      context.openSkills();
      return;
    case "pager.externalActive":
      await context.openActivePagerExternally();
      return;
    case "transcript.externalPager": {
      const opened = await context.openExternalTranscriptPager();
      if (!opened) {
        context.notify("No external pager is available for the current shell.", "warning");
      }
      return;
    }
    case "transcript.copyLatestAnswer":
      await context.copyLatestAssistantAnswer();
      return;
    case "transcript.navigate":
      context.requestTranscriptNavigation(effect.kind);
      return;
    case "context.requestCompaction":
      context.requestContextCompaction();
      return;
    case "session.projectEvent":
      context.projectSessionEvent(effect);
      return;
    case "session.abort":
      await context.abortSession(effect.notification);
      return;
    case "session.create":
      await context.createSession();
      return;
    case "session.diffExternalPager":
      await context.openSessionDiffExternalPager();
      return;
    case "session.exportBundle":
      await context.exportSessionBundle();
      return;
    case "session.exportInspectBundle":
      await context.exportInspectBundle();
      return;
    case "session.steer":
      await context.steerSession(effect);
      return;
    case "session.undo":
      await context.undoSession();
      return;
    case "session.rewind":
      await context.rewindSession(effect.argument);
      return;
    case "session.redo":
      await context.redoSession();
      return;
    case "model.open":
      await context.openModel(effect.query);
      return;
    case "model.cycleRecent":
      await context.cycleRecentModel();
      return;
    case "modelPreset.cycleNext":
      await context.cycleNextModelPreset();
      return;
    case "provider.openConnect":
      await context.openProviderConnect(effect.query);
      return;
    case "thinking.open":
      await context.openThinking();
      return;
    case "view.toggleThinking":
      context.toggleThinkingVisibility();
      return;
    case "view.toggleToolDetails":
      context.toggleToolDetails();
      return;
    case "view.toggleDiffWrap":
      context.toggleDiffWrap();
      return;
    case "view.toggleDiffStyle":
      context.toggleDiffStyle();
      return;
    case "theme.list":
      context.listThemes();
      return;
    case "theme.set":
      context.setTheme(effect.selection);
      return;
    case "operator.refresh":
      await context.refreshOperator(effect.sessionGeneration);
      return;
    case "operator.decideApproval":
      await context.decideApproval(effect.requestId, effect.input);
      return;
    case "operator.answerQuestion":
      await context.answerQuestion(effect.questionId, effect.answerText);
      return;
    case "operator.answerQuestionRequest":
      await context.answerQuestionRequest(effect.requestId, effect.answers);
      return;
    case "operator.stopTask":
      await context.stopTask(effect.runId);
      return;
    case "status.flush":
      context.scheduleStatusFlush(effect.delayMs);
      return;
    case "session.prompt":
      await context.promptSession(effect.sessionGeneration, effect.parts, effect.options);
      return;
    case "external.editor":
      await context.openExternalEditorEffect(effect.title, effect.prefill);
      return;
    case "external.pager":
      await context.openExternalPagerEffect(effect.title, effect.lines);
      return;
    case "provider.connectApiKey":
      await context.connectProviderApiKey(effect.providerId, effect.apiKey, effect.inputs);
      return;
    case "provider.completeOAuth":
      await context.completeProviderOAuth(effect.providerId, effect.methodId, effect.code);
      return;
    case "provider.disconnect":
      await context.disconnectProvider(effect.providerId);
      return;
    case "clipboard.copy":
      await context.copyToClipboard(effect.text);
      return;
    case "diff.exportPatchEvidence":
      await context.exportPatchEvidence();
      return;
    case "project.initGuidance":
      await context.previewProjectGuidanceInit();
      return;
    case "url.open":
      await context.openUrl(effect.url);
      return;
    default:
      effect satisfies never;
  }
}

export function appendSessionProjectionError(input: {
  appendMessage(message: ReturnType<typeof buildTextTranscriptMessage>): void;
  eventType: string;
  message: string;
}): void {
  input.appendMessage(
    buildTextTranscriptMessage({
      id: `system:event:${Date.now()}`,
      role: "system",
      text: `TUI render error while handling ${input.eventType}: ${input.message}`,
    }),
  );
}
