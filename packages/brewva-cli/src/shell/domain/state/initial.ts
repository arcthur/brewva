import { DEFAULT_TUI_THEME } from "../../../internal/tui/index.js";
import { buildTrustLoopIdleProjection } from "../trust-loop/projection.js";
import type { CliShellViewState } from "./types.js";

export function createCliShellState(): CliShellViewState {
  return {
    theme: DEFAULT_TUI_THEME,
    focus: {
      active: "composer",
      returnStack: [],
    },
    overlay: {
      active: undefined,
      queue: [],
    },
    transcript: {
      messages: [],
      followMode: "live",
      scrollOffset: 0,
      navigationRequest: undefined,
    },
    composer: {
      text: "",
      cursor: 0,
      parts: [],
    },
    notifications: [],
    queue: [],
    operator: {
      taskRuns: [],
    },
    subagentFooter: {
      mode: "collapsed",
      selectedRunId: undefined,
      scrollOffset: 0,
    },
    status: {
      entries: {},
      trust: buildTrustLoopIdleProjection(),
    },
    diff: {
      style: "auto",
      wrapMode: "word",
    },
    view: {
      showThinking: true,
      toolDetails: true,
    },
  };
}
