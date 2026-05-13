import { resolve } from "node:path";
import { shortSha256Hex } from "@brewva/brewva-std/hash";
import type { BrewvaBundledToolOptions } from "../../../contracts/index.js";

function hashSessionId(sessionId: string): string {
  return shortSha256Hex(sessionId, 16);
}

export function encodeSessionId(sessionId: string): string {
  return Buffer.from(sessionId, "utf8").toString("base64url");
}

export function resolveBrowserSessionName(sessionId: string): string {
  return `brewva-${hashSessionId(sessionId)}`;
}

export function resolveBaseCwd(options: BrewvaBundledToolOptions, ctx: unknown): string {
  const ctxCwd = (ctx as { cwd?: unknown } | undefined)?.cwd;
  if (typeof ctxCwd === "string" && ctxCwd.trim().length > 0) {
    return resolve(ctxCwd);
  }
  if (
    typeof options.runtime.identity.cwd === "string" &&
    options.runtime.identity.cwd.trim().length > 0
  ) {
    return resolve(options.runtime.identity.cwd);
  }
  return process.cwd();
}

export function resolveWorkspaceRoot(options: BrewvaBundledToolOptions): string {
  if (
    typeof options.runtime.identity.workspaceRoot === "string" &&
    options.runtime.identity.workspaceRoot.trim().length > 0
  ) {
    return resolve(options.runtime.identity.workspaceRoot);
  }
  if (
    typeof options.runtime.identity.cwd === "string" &&
    options.runtime.identity.cwd.trim().length > 0
  ) {
    return resolve(options.runtime.identity.cwd);
  }
  return process.cwd();
}
