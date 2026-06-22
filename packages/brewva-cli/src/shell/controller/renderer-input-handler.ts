import type { ShellAction } from "../domain/actions.js";
import type { ShellCommitOptions } from "../domain/actions.js";
import { shellCockpitComposerPolicyBlocksMutation } from "../domain/cockpit/index.js";
import type { ShellInput } from "../domain/input.js";
import { cloneCliShellPromptParts, promptPartArraysEqual } from "../domain/prompt-parts.js";
import type { CliShellViewState } from "../domain/state.js";
import type { ShellCompletionHandler } from "./handlers/completion-handler.js";

export type ShellRendererInput = Exclude<
  ShellInput,
  | import("../domain/input.js").CliShellInput
  | { readonly type: "keymap.command" }
  | { readonly type: "keymap.effect" }
>;

export interface ShellRendererInputHandlerContext {
  getState(): CliShellViewState;
  setViewportRows(rows: number): void;
  commit(action: ShellAction, options?: ShellCommitOptions): void;
  completionHandler: Pick<ShellCompletionHandler, "select" | "accept">;
  openSessionById(sessionId: string): Promise<void>;
}

export async function handleShellRendererInput(
  context: ShellRendererInputHandlerContext,
  input: ShellRendererInput,
): Promise<boolean> {
  switch (input.type) {
    case "viewport.resize":
      void input.columns;
      context.setViewportRows(Math.max(12, input.rows));
      return true;
    case "composer.editorSync":
      if (
        shellCockpitComposerPolicyBlocksMutation(
          context.getState().cockpit.projection?.composerPolicy ?? "active",
        )
      ) {
        return true;
      }
      if (
        context.getState().composer.text === input.text &&
        context.getState().composer.cursor === input.cursor &&
        promptPartArraysEqual(context.getState().composer.parts, input.parts ?? [])
      ) {
        return true;
      }
      context.commit(
        {
          type: "composer.setPromptState",
          text: input.text,
          cursor: input.cursor,
          parts: cloneCliShellPromptParts(input.parts ?? []),
          source: "editor",
        },
        // Completion resolution rides the commit-level default policy:
        // trigger contexts and open popups refresh, plain typing does not.
        { debounceStatus: false },
      );
      return true;
    case "completion.select":
      context.completionHandler.select(input.index);
      return true;
    case "completion.accept":
      context.completionHandler.accept();
      return true;
    case "surface.scrollSync": {
      // Rounding alone absorbs sub-row layout jitter; the comparison must
      // stay exact so legitimate one-row navigation steps (page step is 1
      // in very short viewports) are never swallowed.
      const nextScrollOffset = Math.max(0, Math.round(input.scrollOffset));
      const surface = context.getState().surface;
      if (surface.followMode === input.followMode && surface.scrollOffset === nextScrollOffset) {
        return true;
      }
      context.commit(
        {
          type: "surface.setScrollState",
          followMode: input.followMode,
          scrollOffset: nextScrollOffset,
        },
        { debounceStatus: false, refreshCompletions: false },
      );
      return true;
    }
    case "session.open":
      await context.openSessionById(input.sessionId);
      return true;
    default:
      input satisfies never;
      return false;
  }
}
