import type { BrewvaQueuedPromptView } from "@brewva/brewva-substrate/session";
import type { DelegationRunRecord } from "@brewva/brewva-vocabulary/delegation";
import type { TuiTheme } from "../../../internal/tui/index.js";
import type { OverlayEntry } from "../../../internal/tui/index.js";
import type { CockpitObservationCursor, ShellCockpitProjection } from "../cockpit/index.js";
import type { ShellCompletionCandidate, ShellCompletionRange } from "../completion-provider.js";
import type { OperatorSafetyShellSessionView } from "../operator-safety/shell-view.js";
import type { CliShellOverlayPayload } from "../overlays/payloads.js";
import type { CliShellPromptPart } from "../prompt.js";
import type { CliShellTranscriptMessage } from "../transcript.js";

export type ShellFocusOwner =
  | "composer"
  | "transcript"
  | "completion"
  | "approvalOverlay"
  | "questionOverlay"
  | "inspectOverlay"
  | "taskBrowser"
  | "subagentFooter"
  | "sessionSwitcher"
  | "notificationCenter"
  | "pager"
  | "dialog"
  | (string & {});

export interface CliShellNotification {
  id: string;
  level: "info" | "warning" | "error";
  message: string;
  createdAt: number;
}

export interface CliShellStatusState {
  entries: Record<string, string>;
  safety?: OperatorSafetyShellSessionView;
  workingMessage?: string;
  hiddenThinkingLabel?: string;
}

export interface CliShellOperatorState {
  taskRuns: DelegationRunRecord[];
}

export interface CliShellSubagentFooterState {
  mode: "collapsed" | "inspecting";
  selectedRunId?: string;
  scrollOffset: number;
}

export interface CliShellCockpitState {
  projection?: ShellCockpitProjection;
  observation: CockpitObservationCursor;
}

export type CliShellDiffStyle = "auto" | "stacked";
export type CliShellDiffWrapMode = "word" | "none";

export interface CliShellDiffState {
  style: CliShellDiffStyle;
  wrapMode: CliShellDiffWrapMode;
}

export interface CliShellDisplayState {
  showThinking: boolean;
  toolDetails: boolean;
}

export interface CliShellCompletionState {
  trigger: "/" | "@";
  query: string;
  range: ShellCompletionRange;
  items: ShellCompletionCandidate[];
  selectedIndex: number;
}

export interface CliShellOverlayState {
  active?: OverlayEntry & {
    focusOwner: ShellFocusOwner;
    title?: string;
    lines?: string[];
    payload?: CliShellOverlayPayload;
  };
  queue: Array<
    OverlayEntry & {
      focusOwner: ShellFocusOwner;
      title?: string;
      lines?: string[];
      payload?: CliShellOverlayPayload;
    }
  >;
}

export type CliShellComposerChangeSource = "editor" | "external";

export interface CliShellViewState {
  theme: TuiTheme;
  focus: {
    active: ShellFocusOwner;
    returnStack: ShellFocusOwner[];
  };
  overlay: CliShellOverlayState;
  transcript: {
    messages: CliShellTranscriptMessage[];
  };
  surface: {
    followMode: "live" | "scrolled";
    scrollOffset: number;
  };
  composer: {
    text: string;
    cursor: number;
    parts: CliShellPromptPart[];
    completion?: CliShellCompletionState;
    /**
     * Bumped on every composer change that did not originate from a sync
     * echo of the editing surface itself (`source: "editor"`). Rendering
     * layers treat the editing surface as uncontrolled while the user
     * edits and apply state back only when this revision moves, so a stale
     * sync echo can never clobber newer input (RFC F7).
     */
    revision: number;
  };
  pager?: {
    title: string;
    lines: string[];
  };
  notifications: CliShellNotification[];
  queue: readonly BrewvaQueuedPromptView[];
  cockpit: CliShellCockpitState;
  operator: CliShellOperatorState;
  subagentFooter: CliShellSubagentFooterState;
  status: CliShellStatusState;
  diff: CliShellDiffState;
  view: CliShellDisplayState;
}

export type CliShellAction =
  | {
      type: "theme.set";
      theme: TuiTheme;
    }
  | {
      type: "overlay.open";
      overlay: NonNullable<CliShellOverlayState["active"]>;
    }
  | {
      type: "overlay.replace";
      overlay: NonNullable<CliShellOverlayState["active"]>;
    }
  | {
      type: "overlay.close";
      id: string;
    }
  | {
      type: "transcript.setMessages";
      messages: CliShellTranscriptMessage[];
    }
  | {
      type: "surface.setScrollState";
      followMode: "live" | "scrolled";
      scrollOffset: number;
    }
  | {
      type: "surface.followLive";
    }
  | {
      type: "composer.setText";
      text: string;
      cursor?: number;
      /** "editor" when the editing surface already holds this text (sync echo). */
      source?: CliShellComposerChangeSource;
    }
  | {
      type: "composer.setPromptState";
      text: string;
      cursor: number;
      parts: CliShellPromptPart[];
      /** "editor" when the editing surface already holds this text (sync echo). */
      source?: CliShellComposerChangeSource;
    }
  | {
      type: "completion.set";
      completion: CliShellCompletionState | undefined;
    }
  | {
      type: "notification.add";
      notification: CliShellNotification;
    }
  | {
      type: "notification.dismiss";
      id: string;
    }
  | {
      type: "notification.clear";
    }
  | {
      type: "queue.set";
      items: readonly BrewvaQueuedPromptView[];
    }
  | {
      type: "operator.setTaskRuns";
      taskRuns: DelegationRunRecord[];
    }
  | {
      type: "cockpit.setProjection";
      projection: ShellCockpitProjection | undefined;
    }
  | {
      type: "cockpit.setObservation";
      observation: CockpitObservationCursor;
    }
  | {
      type: "subagentFooter.open";
      runId?: string;
    }
  | {
      type: "subagentFooter.close";
    }
  | {
      type: "subagentFooter.toggle";
      runId?: string;
    }
  | {
      type: "subagentFooter.select";
      runId: string;
    }
  | {
      type: "subagentFooter.selectRelative";
      delta: -1 | 1;
    }
  | {
      type: "subagentFooter.scroll";
      delta: number;
    }
  | {
      type: "status.set";
      key: string;
      text: string | undefined;
    }
  | {
      type: "status.setSafety";
      safety: OperatorSafetyShellSessionView | undefined;
    }
  | {
      type: "status.working";
      text: string | undefined;
    }
  | {
      type: "status.hiddenThinking";
      text: string | undefined;
    }
  | {
      type: "diff.setPreferences";
      preferences: Partial<CliShellDiffState>;
    }
  | {
      type: "view.setPreferences";
      preferences: Partial<CliShellDisplayState>;
    };
