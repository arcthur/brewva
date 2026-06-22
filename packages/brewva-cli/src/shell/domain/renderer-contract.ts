import type { BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import type { ShellClock } from "./clock.js";
import type { ShellInput } from "./input.js";
import type { ScrollbackCommit, ScrollbackCommitCursor } from "./scrollback/commit.js";
import type { BrewvaResolvedKeymapBindings, BrewvaTuiConfig } from "./tui.js";
import type { ShellViewModel } from "./view-model.js";

/**
 * A drained slice of the append-only scrollback commit log for the current
 * session, plus the session `epoch`. The writer drains incrementally: it passes
 * the cursor it last acknowledged and receives the commits strictly after it.
 * `epoch` is the session generation — when it changes the log was reset for a
 * new session, so the writer must reset its cursor and replay from the start.
 */
export interface ScrollbackCommitPeek {
  readonly commits: readonly ScrollbackCommit[];
  readonly cursor: ScrollbackCommitCursor;
  readonly epoch: number;
}

export interface ShellRendererNotifier {
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

export interface ShellRendererController {
  readonly ui: ShellRendererNotifier;
  /**
   * Project the current view model. The result is a structurally shared
   * snapshot: it is stable until the next commit, and unchanged branches
   * are reused across calls. Consumers must not mutate it and must not
   * hold it across awaits while the shell keeps running — copy what they
   * need first.
   */
  getViewState(): ShellViewModel;
  /**
   * The shell's time source. Renderer-side debounce/throttle layers must
   * schedule through this clock so replay tests drive them
   * deterministically alongside the runtime's own timers.
   */
  getClock(): ShellClock;
  getSessionWireFrames(sessionId: string): readonly SessionWireFrame[];
  /**
   * Drain the current session's append-only scrollback commit log from
   * `cursor`. A pure read — the log is never mutated by the reader. Returns the
   * commits strictly after `cursor`, the advanced cursor, and the session
   * `epoch` (so the writer can detect a session switch / log reset).
   */
  peekScrollbackCommits(cursor: ScrollbackCommitCursor): ScrollbackCommitPeek;
  getToolDefinitions(): ReadonlyMap<string, BrewvaToolDefinition>;
  getTuiConfig(): BrewvaTuiConfig;
  getKeymapBindings(): BrewvaResolvedKeymapBindings;
  getShortcutLabel(id: string): string | undefined;
  getSessionIdentity(): {
    sessionId: string;
    assistantLabel: string;
    lineageLabel: string | null;
    modelLabel: string;
    thinkingLevel: string;
  };
  requestRender(): void;
  submitComposer(): void;
  subscribe(listener: () => void): () => void;
  wantsInput(input: ShellInput): boolean;
  handleInput(input: ShellInput): Promise<boolean>;
}
