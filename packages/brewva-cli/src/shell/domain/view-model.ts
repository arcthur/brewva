import { cloneCliShellPromptParts } from "./prompt-parts.js";
import type { CliShellCompletionState, CliShellViewState } from "./state.js";

export type ShellViewModel = CliShellViewState;
export type { CliShellNotification } from "./state.js";

function projectCompletion(
  completion: CliShellCompletionState | undefined,
): CliShellCompletionState | undefined {
  if (!completion) {
    return undefined;
  }
  return {
    ...completion,
    items: [...completion.items],
  };
}

export function projectShellViewModel(state: CliShellViewState): ShellViewModel {
  return {
    ...state,
    focus: {
      active: state.focus.active,
      returnStack: [...state.focus.returnStack],
    },
    overlay: {
      active: state.overlay.active,
      queue: [...state.overlay.queue],
    },
    transcript: {
      ...state.transcript,
      messages: [...state.transcript.messages],
      navigationRequest: state.transcript.navigationRequest
        ? { ...state.transcript.navigationRequest }
        : undefined,
    },
    composer: {
      ...state.composer,
      parts: cloneCliShellPromptParts(state.composer.parts),
      completion: projectCompletion(state.composer.completion),
    },
    pager: state.pager ? { title: state.pager.title, lines: [...state.pager.lines] } : undefined,
    notifications: [...state.notifications],
    queue: [...state.queue],
    operator: {
      taskRuns: [...state.operator.taskRuns],
    },
    subagentFooter: {
      mode: state.subagentFooter.mode,
      selectedRunId: state.subagentFooter.selectedRunId,
      scrollOffset: state.subagentFooter.scrollOffset,
    },
    status: {
      ...state.status,
      entries: { ...state.status.entries },
    },
    diff: { ...state.diff },
    view: { ...state.view },
  };
}
