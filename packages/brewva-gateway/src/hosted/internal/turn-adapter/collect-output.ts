import type { ToolOutputView } from "@brewva/brewva-runtime/protocol";
import type { BrewvaPromptContentPart } from "@brewva/brewva-substrate/prompt";
import type { BrewvaSubscribablePromptSession } from "@brewva/brewva-substrate/session";

export interface SessionPromptOutput {
  readonly assistantText: string;
  readonly toolOutputs: readonly ToolOutputView[];
  readonly attemptId: string;
}

export type SessionPromptInput = string | readonly BrewvaPromptContentPart[];

export interface CollectSessionPromptOutputSession extends BrewvaSubscribablePromptSession {}
