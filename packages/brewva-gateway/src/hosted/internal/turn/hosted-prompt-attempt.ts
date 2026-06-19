import type { BrewvaPromptContentPart } from "@brewva/brewva-substrate/prompt";
import type { BrewvaPromptOptions } from "@brewva/brewva-substrate/session";

export const HOSTED_PROMPT_ATTEMPT_DISPATCH: unique symbol = Symbol(
  "brewva.hostedPromptAttemptDispatch",
);

export interface HostedPromptAttemptDispatchSession {
  [HOSTED_PROMPT_ATTEMPT_DISPATCH](
    parts: readonly BrewvaPromptContentPart[],
    options?: BrewvaPromptOptions,
  ): Promise<void>;
}

export function hasHostedPromptAttemptDispatch(
  session: unknown,
): session is HostedPromptAttemptDispatchSession {
  return (
    typeof session === "object" &&
    session !== null &&
    typeof (session as Partial<HostedPromptAttemptDispatchSession>)[
      HOSTED_PROMPT_ATTEMPT_DISPATCH
    ] === "function"
  );
}

export async function dispatchHostedPromptAttempt(
  session: {
    prompt(parts: readonly BrewvaPromptContentPart[], options?: BrewvaPromptOptions): Promise<void>;
  },
  parts: readonly BrewvaPromptContentPart[],
  options?: BrewvaPromptOptions,
): Promise<void> {
  if (hasHostedPromptAttemptDispatch(session)) {
    await session[HOSTED_PROMPT_ATTEMPT_DISPATCH](parts, options);
    return;
  }
  await session.prompt(parts, options);
}
