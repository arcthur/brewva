import { dirname, isAbsolute, relative, resolve } from "node:path";

const MAX_OBSERVED_PATHS = 24;
const LOCATION_PATH_PATTERN = /^([^:\n]+):\d+(?::\d+)?(?:\s|:|$)/u;

export interface ReadPathDiscoveryObservationPayload {
  toolName: string;
  evidenceKind?: string;
  observedPaths: string[];
  observedDirectories: string[];
}

function normalizeWorkspacePath(baseCwd: string, candidate: string): string | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return undefined;
  }

  const absolutePath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(baseCwd, trimmed);
  const relativePath = relative(baseCwd, absolutePath).replaceAll("\\", "/");
  if (relativePath.startsWith("../") || relativePath === "..") {
    return undefined;
  }
  if (relativePath.length === 0) {
    return ".";
  }
  return relativePath.replace(/^\.\/+/u, "");
}

function clampStringList(values: Iterable<string>, maxItems: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
    if (output.length >= maxItems) {
      break;
    }
  }
  return output;
}

export function collectObservedPathsFromLocationLines(input: {
  baseCwd: string;
  lines: Iterable<string>;
}): string[] {
  const observedPaths: string[] = [];
  for (const line of input.lines) {
    const match = LOCATION_PATH_PATTERN.exec(line.trim());
    if (!match?.[1]) {
      continue;
    }
    const normalized = normalizeWorkspacePath(input.baseCwd, match[1]);
    if (normalized) {
      observedPaths.push(normalized);
    }
  }
  return clampStringList(observedPaths, MAX_OBSERVED_PATHS);
}

export function buildReadPathDiscoveryObservationPayload(input: {
  baseCwd: string;
  toolName: string;
  evidenceKind?: string;
  observedPaths?: Iterable<string>;
  observedDirectories?: Iterable<string>;
}): ReadPathDiscoveryObservationPayload | null {
  const observedPaths = clampStringList(
    [...(input.observedPaths ?? [])]
      .map((candidate) => normalizeWorkspacePath(input.baseCwd, candidate))
      .filter((candidate): candidate is string => Boolean(candidate)),
    MAX_OBSERVED_PATHS,
  );
  const observedDirectories = clampStringList(
    [
      ...(input.observedDirectories ?? []),
      ...observedPaths.map((path) => {
        const parentDirectory = dirname(path).replaceAll("\\", "/");
        return parentDirectory === "" ? "." : parentDirectory;
      }),
    ]
      .map((candidate) => normalizeWorkspacePath(input.baseCwd, candidate))
      .filter((candidate): candidate is string => Boolean(candidate)),
    MAX_OBSERVED_PATHS,
  );

  if (observedPaths.length === 0 && observedDirectories.length === 0) {
    return null;
  }

  return {
    toolName: input.toolName,
    ...(input.evidenceKind ? { evidenceKind: input.evidenceKind } : {}),
    observedPaths,
    observedDirectories,
  };
}
