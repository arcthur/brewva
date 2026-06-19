import type { BrewvaPromptContentPart } from "@brewva/brewva-substrate/prompt";
import type { BrewvaSubscribablePromptSession } from "@brewva/brewva-substrate/session";

export type SessionPromptInput = string | readonly BrewvaPromptContentPart[];

export interface CollectSessionPromptOutputSession extends BrewvaSubscribablePromptSession {}
