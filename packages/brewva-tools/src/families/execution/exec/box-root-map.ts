import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, posix, relative, resolve } from "node:path";
import { sha256Hex } from "@brewva/brewva-std/hash";

export interface BoxRootMapping {
  hostPath: string;
  guestPath: string;
  readonly: boolean;
  primary: boolean;
}

export interface BoxCommandPathRewrite {
  command: string;
  unmappedPaths: string[];
  referencedMappings: BoxRootMapping[];
}

const HOST_PATH_PREFIX_PATTERN =
  /\/(?:Users|home|tmp|private\/tmp|private\/var\/folders|var\/folders|Volumes|mnt)(?:\/|$)/u;
const SHELL_TOKEN_DELIMITERS = new Set(["|", ";", "&", "<", ">", "(", ")"]);

interface ShellToken {
  value: string;
  start: number;
  end: number;
  sourceIndices: number[];
}

interface HostPathMention {
  path: string;
  start: number;
  end: number;
}

interface HostPathTokenMatch {
  path: string;
  valueStart: number;
  valueEnd: number;
}

function isPathInsideRoot(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function resolveThroughExistingAncestor(path: string): string {
  const resolvedPath = resolve(path);
  let current = resolvedPath;
  const missingSegments: string[] = [];

  while (true) {
    try {
      if (existsSync(current)) {
        const canonicalAncestor = realpathSync(current);
        return missingSegments.length === 0
          ? canonicalAncestor
          : resolve(canonicalAncestor, ...missingSegments.toReversed());
      }
    } catch {
      return resolvedPath;
    }

    const parent = dirname(current);
    if (parent === current) {
      return resolvedPath;
    }
    missingSegments.push(basename(current));
    current = parent;
  }
}

function findBestMappingForHostPath(
  hostPath: string,
  mappings: readonly BoxRootMapping[],
): { mapping: BoxRootMapping; matchedHostPath: string } | undefined {
  const resolvedPath = resolve(hostPath);
  const canonicalPath = resolveThroughExistingAncestor(hostPath);
  return [...mappings]
    .flatMap((mapping) => {
      const directMatch = isPathInsideRoot(resolvedPath, mapping.hostPath);
      const canonicalMatch = isPathInsideRoot(canonicalPath, mapping.hostPath);
      if (!directMatch && !canonicalMatch) {
        return [];
      }
      return [
        {
          mapping,
          matchedHostPath: canonicalMatch ? canonicalPath : resolvedPath,
        },
      ];
    })
    .toSorted((left, right) => right.mapping.hostPath.length - left.mapping.hostPath.length)[0];
}

function normalizeGuestPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    return `/${trimmed}`;
  }
  return trimmed.replace(/\/+$/u, "") || "/";
}

function stableGuestRootForHostPath(hostPath: string): string {
  const digest = sha256Hex(resolve(hostPath)).slice(0, 10);
  const segment = basename(hostPath)
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return `/workspace-roots/${digest}-${segment || "root"}`;
}

function uniqueRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.map((root) => resolve(root)))].toSorted((left, right) =>
    left.localeCompare(right),
  );
}

export function buildBoxRootMappings(input: {
  workspaceRoot: string;
  allowedRoots: readonly string[];
  workspaceGuestPath: string;
}): BoxRootMapping[] {
  const workspaceRoot = resolve(input.workspaceRoot);
  const workspaceGuestPath = normalizeGuestPath(input.workspaceGuestPath);
  const allRoots = uniqueRoots([workspaceRoot, ...input.allowedRoots]);
  const mappings: BoxRootMapping[] = [
    {
      hostPath: workspaceRoot,
      guestPath: workspaceGuestPath,
      readonly: false,
      primary: true,
    },
  ];

  for (const root of allRoots) {
    if (isPathInsideRoot(root, workspaceRoot)) {
      continue;
    }
    mappings.push({
      hostPath: root,
      guestPath: stableGuestRootForHostPath(root),
      readonly: true,
      primary: false,
    });
  }

  return mappings.toSorted((left, right) => Number(right.primary) - Number(left.primary));
}

export function mapHostPathToGuest(input: {
  hostPath: string;
  mappings: readonly BoxRootMapping[];
}): string | undefined {
  const match = findBestMappingForHostPath(input.hostPath, input.mappings);
  if (!match) {
    return undefined;
  }
  const rel = relative(match.mapping.hostPath, match.matchedHostPath);
  if (!rel) {
    return match.mapping.guestPath;
  }
  return posix.join(match.mapping.guestPath, ...rel.split(/[\\/]+/u));
}

function normalizeCandidatePath(value: string): string {
  return value.replace(/[.,:]+$/u, "");
}

function tokenizeShellWords(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let value = "";
  let tokenStart: number | undefined;
  let sourceIndices: number[] = [];
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const beginToken = (index: number) => {
    tokenStart ??= index;
  };

  const appendValue = (char: string, sourceIndex: number) => {
    beginToken(sourceIndex);
    value += char;
    sourceIndices.push(sourceIndex);
  };

  const push = (end: number) => {
    if (value.length > 0 && tokenStart !== undefined) {
      tokens.push({ value, start: tokenStart, end, sourceIndices });
      value = "";
      tokenStart = undefined;
      sourceIndices = [];
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;

    if (escaped) {
      appendValue(char, index);
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      beginToken(index);
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        appendValue(char, index);
      }
      continue;
    }

    if (char === '"' || char === "'") {
      beginToken(index);
      quote = char;
      continue;
    }

    if (char === "#" && value.length === 0) {
      break;
    }

    if (/\s/u.test(char) || SHELL_TOKEN_DELIMITERS.has(char)) {
      push(index);
      continue;
    }

    appendValue(char, index);
  }

  push(command.length);
  return tokens;
}

function isAllowedPathStart(token: string, pathStart: number): boolean {
  if (pathStart === 0) {
    return true;
  }
  const previous = token[pathStart - 1];
  return previous === "=" || previous === ":" || previous === ",";
}

function mappedPathStart(token: string, mappings: readonly BoxRootMapping[]): number | undefined {
  return mappings
    .flatMap((mapping) => {
      const root = resolve(mapping.hostPath);
      const starts: number[] = [];
      let cursor = token.indexOf(root);
      while (cursor >= 0) {
        if (isAllowedPathStart(token, cursor)) {
          starts.push(cursor);
        }
        cursor = token.indexOf(root, cursor + root.length);
      }
      return starts;
    })
    .toSorted((left, right) => left - right)[0];
}

function extractHostPathFromToken(
  token: string,
  mappings: readonly BoxRootMapping[],
): HostPathTokenMatch | undefined {
  const mappedStart = mappedPathStart(token, mappings);
  const genericStart = token.search(HOST_PATH_PREFIX_PATTERN);
  const pathStart =
    mappedStart === undefined
      ? genericStart
      : genericStart < 0
        ? mappedStart
        : Math.min(mappedStart, genericStart);
  if (pathStart < 0) {
    return undefined;
  }

  if (!isAllowedPathStart(token, pathStart)) {
    return undefined;
  }

  const path = normalizeCandidatePath(token.slice(pathStart));
  if (!path) {
    return undefined;
  }
  return {
    path,
    valueStart: pathStart,
    valueEnd: pathStart + path.length,
  };
}

function sourceSpanForTokenMatch(
  token: ShellToken,
  match: HostPathTokenMatch,
): { start: number; end: number } | undefined {
  const start = token.sourceIndices[match.valueStart];
  const last = token.sourceIndices[match.valueEnd - 1];
  if (start === undefined || last === undefined) {
    return undefined;
  }
  return { start, end: last + 1 };
}

function extractHostPathMentions(
  command: string,
  mappings: readonly BoxRootMapping[],
): HostPathMention[] {
  const mentions: HostPathMention[] = [];
  for (const token of tokenizeShellWords(command)) {
    const match = extractHostPathFromToken(token.value, mappings);
    if (!match) {
      continue;
    }
    const span = sourceSpanForTokenMatch(token, match);
    if (!span) {
      continue;
    }
    mentions.push({ path: match.path, ...span });
  }
  return mentions;
}

function rewriteMappedHostPaths(input: {
  command: string;
  mappings: readonly BoxRootMapping[];
  mentions: readonly HostPathMention[];
}): {
  command: string;
  referencedMappings: BoxRootMapping[];
} {
  let command = input.command;
  const referenced = new Map<string, BoxRootMapping>();
  const replacements: Array<{ start: number; end: number; value: string }> = [];

  for (const mention of input.mentions) {
    const guestPath = mapHostPathToGuest({ hostPath: mention.path, mappings: input.mappings });
    if (!guestPath) {
      continue;
    }
    const match = findBestMappingForHostPath(mention.path, input.mappings);
    if (match) {
      referenced.set(match.mapping.hostPath, match.mapping);
    }
    replacements.push({ start: mention.start, end: mention.end, value: guestPath });
  }

  for (const replacement of replacements.toSorted((left, right) => right.start - left.start)) {
    command =
      command.slice(0, replacement.start) + replacement.value + command.slice(replacement.end);
  }

  return {
    command,
    referencedMappings: [...referenced.values()],
  };
}

export function rewriteBoxCommandHostPaths(input: {
  command: string;
  mappings: readonly BoxRootMapping[];
}): BoxCommandPathRewrite {
  const hostPathMentions = extractHostPathMentions(input.command, input.mappings);
  const unmappedPaths = [
    ...new Set(
      hostPathMentions
        .filter(
          (mention) => !mapHostPathToGuest({ hostPath: mention.path, mappings: input.mappings }),
        )
        .map((mention) => mention.path),
    ),
  ];
  if (unmappedPaths.length > 0) {
    return {
      command: input.command,
      unmappedPaths,
      referencedMappings: [],
    };
  }
  return {
    unmappedPaths: [],
    ...rewriteMappedHostPaths({ ...input, mentions: hostPathMentions }),
  };
}

export function serializeBoxRootMappings(mappings: readonly BoxRootMapping[]): Array<{
  hostPath: string;
  guestPath: string;
  readonly: boolean;
  primary: boolean;
}> {
  return mappings.map((mapping) => ({
    hostPath: mapping.hostPath,
    guestPath: mapping.guestPath,
    readonly: mapping.readonly,
    primary: mapping.primary,
  }));
}
