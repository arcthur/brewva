import { resolve, sep } from "node:path";
import type { BrewvaToolRuntime } from "../contracts/index.js";
import { resolveToolRuntimeTaskPort } from "./extensions.js";
import { getToolSessionId } from "./parallel-read.js";

function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  if (resolvedPath === resolvedRoot) {
    return true;
  }
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  return resolvedPath.startsWith(prefix);
}

export interface ToolTargetScope {
  sessionId?: string;
  baseCwd: string;
  primaryRoot: string;
  allowedRoots: string[];
}

interface ToolTargetDescriptor {
  primaryRoot?: string;
  roots?: string[];
}

export function resolveToolTargetScope(
  runtime: BrewvaToolRuntime | undefined,
  ctx: unknown,
): ToolTargetScope {
  const sessionId = getToolSessionId(ctx);
  const taskPort = resolveToolRuntimeTaskPort(runtime);
  const fallbackCwd =
    ctx && typeof ctx === "object" && typeof (ctx as { cwd?: unknown }).cwd === "string"
      ? resolve((ctx as { cwd: string }).cwd)
      : resolve(runtime?.identity.cwd ?? process.cwd());
  const descriptor =
    sessionId && taskPort?.target?.getDescriptor
      ? (taskPort.target.getDescriptor(sessionId) as ToolTargetDescriptor)
      : undefined;
  const primaryRoot = resolve(descriptor?.primaryRoot ?? fallbackCwd);
  const allowedRoots =
    descriptor?.roots && descriptor.roots.length > 0
      ? descriptor.roots.map((root) => resolve(root))
      : [primaryRoot];
  const baseCwd = allowedRoots.some((root) => isPathInsideRoot(fallbackCwd, root))
    ? fallbackCwd
    : primaryRoot;
  return {
    sessionId,
    baseCwd,
    primaryRoot,
    allowedRoots,
  };
}

export function isPathInsideRoots(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => isPathInsideRoot(path, root));
}

export function resolveScopedPath(
  candidate: string,
  scope: ToolTargetScope,
  options: {
    relativeTo?: string;
  } = {},
): string | null {
  const absolute = resolve(options.relativeTo ?? scope.baseCwd, candidate);
  return isPathInsideRoots(absolute, scope.allowedRoots) ? absolute : null;
}
