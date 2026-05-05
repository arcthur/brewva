import type { BrewvaToolContext as ExtensionContext } from "@brewva/brewva-substrate/tools";

export function getSessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}
