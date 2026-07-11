import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { sha256Hex } from "@brewva/brewva-std/hash";
import { toPosixPath as normalizeRelativePath } from "@brewva/brewva-std/text";
import { encodeSessionId } from "./session.js";
import type { BrowserArtifact } from "./types.js";

const DEFAULT_BROWSER_ARTIFACT_DIR = ".orchestrator/browser-artifacts";

function sanitizeFileSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-");
  const compact = normalized.replaceAll(/-+/g, "-").replaceAll(/^-+|-+$/g, "");
  return compact || "unknown";
}

function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  if (resolvedPath === resolvedRoot) return true;
  const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  return resolvedPath.startsWith(rootPrefix);
}

function artifactBytes(absolutePath: string): number | null {
  try {
    return statSync(absolutePath).size;
  } catch {
    return null;
  }
}

export function buildArtifact(
  kind: string,
  artifactRef: string,
  absolutePath: string,
): BrowserArtifact {
  return {
    kind,
    path: artifactRef,
    bytes: artifactBytes(absolutePath),
  };
}

export function buildTextArtifact(
  kind: string,
  artifactRef: string,
  content: string,
): BrowserArtifact {
  return {
    kind,
    path: artifactRef,
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: sha256Hex(content),
  };
}

export type PathResolution =
  | {
      ok: true;
      absolutePath: string;
      artifactRef: string;
      requestedPath: string | null;
    }
  | {
      ok: false;
      reason: "path_outside_workspace";
      message: string;
      requestedPath: string;
    };

export function resolveWritablePath(input: {
  workspaceRoot: string;
  baseCwd: string;
  sessionId: string;
  toolName: string;
  toolCallId: string;
  requestedPath?: string;
  defaultFileName: string;
}): PathResolution {
  const trimmed = input.requestedPath?.trim();
  const absolutePath = trimmed
    ? isAbsolute(trimmed)
      ? resolve(trimmed)
      : resolve(input.baseCwd, trimmed)
    : resolve(
        input.workspaceRoot,
        DEFAULT_BROWSER_ARTIFACT_DIR,
        encodeSessionId(input.sessionId),
        `${sanitizeFileSegment(input.toolName)}-${sanitizeFileSegment(input.toolCallId)}-${input.defaultFileName}`,
      );

  if (!isPathInsideRoot(absolutePath, input.workspaceRoot)) {
    return {
      ok: false,
      reason: "path_outside_workspace",
      message: `browser artifact path escapes workspace root (${trimmed ?? absolutePath}).`,
      requestedPath: trimmed ?? absolutePath,
    };
  }

  mkdirSync(dirname(absolutePath), { recursive: true });
  return {
    ok: true,
    absolutePath,
    artifactRef: normalizeRelativePath(relative(input.workspaceRoot, absolutePath)),
    requestedPath: trimmed ?? null,
  };
}

export type ExistingPathResolution =
  | {
      ok: true;
      absolutePath: string;
      artifactRef: string;
      requestedPath: string;
    }
  | {
      ok: false;
      reason: "missing_path" | "path_outside_workspace";
      message: string;
      requestedPath: string;
    };

export function resolveExistingPath(input: {
  workspaceRoot: string;
  baseCwd: string;
  requestedPath: string;
}): ExistingPathResolution {
  const trimmed = input.requestedPath.trim();
  const absolutePath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(input.baseCwd, trimmed);
  if (!isPathInsideRoot(absolutePath, input.workspaceRoot)) {
    return {
      ok: false,
      reason: "path_outside_workspace",
      message: `browser path escapes workspace root (${trimmed}).`,
      requestedPath: trimmed,
    };
  }
  if (!existsSync(absolutePath)) {
    return {
      ok: false,
      reason: "missing_path",
      message: `browser path does not exist (${trimmed}).`,
      requestedPath: trimmed,
    };
  }
  return {
    ok: true,
    absolutePath,
    artifactRef: normalizeRelativePath(relative(input.workspaceRoot, absolutePath)),
    requestedPath: trimmed,
  };
}

export function writeArtifactText(absolutePath: string, content: string): void {
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
}
