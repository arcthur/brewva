import type { BrewvaPromptContentPart } from "@brewva/brewva-substrate/prompt";
import type { BrewvaSubscribablePromptSession } from "@brewva/brewva-substrate/session";
import type { ToolOutputView } from "@brewva/brewva-vocabulary/wire";

export interface SessionPromptOutput {
  readonly assistantText: string;
  readonly toolOutputs: readonly ToolOutputView[];
  readonly attemptId: string;
}

export type SessionPromptInput = string | readonly BrewvaPromptContentPart[];

export interface CollectSessionPromptOutputSession extends BrewvaSubscribablePromptSession {}
