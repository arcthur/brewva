import type { ShellAction } from "../domain/actions.js";
import type { ShellCommitOptions } from "../domain/actions.js";
import type { ShellInput } from "../domain/input.js";
import { cloneCliShellPromptParts, promptPartArraysEqual } from "../domain/prompt-parts.js";
import type { CliShellViewState } from "../domain/state.js";
import type { ShellCompletionHandler } from "./handlers/completion-handler.js";

export type ShellRendererInput = Exclude<ShellInput, import("../domain/input.js").CliShellInput>;

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
        },
        { debounceStatus: false },
      );
      return true;
    case "completion.select":
      context.completionHandler.select(input.index);
      return true;
    case "completion.accept":
      context.completionHandler.accept();
      return true;
    case "transcript.scrollSync":
      if (
        context.getState().transcript.followMode === input.followMode &&
        context.getState().transcript.scrollOffset === Math.max(0, input.scrollOffset)
      ) {
        return true;
      }
      context.commit(
        {
          type: "transcript.setScrollState",
          followMode: input.followMode,
          scrollOffset: input.scrollOffset,
        },
        { debounceStatus: false },
      );
      return true;
    case "transcript.navigationAck":
      if (context.getState().transcript.navigationRequest?.id !== input.requestId) {
        return true;
      }
      context.commit(
        { type: "transcript.clearNavigation", id: input.requestId },
        { debounceStatus: false },
      );
      return true;
    case "session.open":
      await context.openSessionById(input.sessionId);
      return true;
    default:
      input satisfies never;
      return false;
  }
}
