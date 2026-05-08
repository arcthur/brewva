import type { BrewvaBundledToolRuntime } from "../../../contracts/index.js";
import {
  resolveScopedPath,
  resolveToolTargetScope,
  type ToolTargetScope,
} from "../../../runtime-port/target-scope.js";

export function resolveBaseDir(ctx: unknown, runtime?: BrewvaBundledToolRuntime): ToolTargetScope {
  return resolveToolTargetScope(runtime, ctx);
}

export function resolveAbsolutePath(scope: ToolTargetScope, target: string): string | null {
  return resolveScopedPath(target, scope);
}
