import type { BrewvaToolContext as ExtensionContext } from "@brewva/brewva-substrate";

export function getSessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}
