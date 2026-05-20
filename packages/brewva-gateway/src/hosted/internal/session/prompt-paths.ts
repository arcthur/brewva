const PROMPT_PATH_CANDIDATE_PATTERN =
  /(?:^|[\s`'"])((?:\/|\.{1,2}\/)[^\s`'",;:!?]+|[A-Za-z0-9_.@()-]+\/[A-Za-z0-9_./@()+-]+)(?=$|[\s`'",;:!?])/gu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizePathForGlob(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
}

function globToRegExp(glob: string): RegExp {
  const normalized = normalizePathForGlob(glob);
  let pattern = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    const afterNext = normalized[index + 2];
    if (char === "*" && next === "*" && afterNext === "/") {
      pattern += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (char === "*" && next === "*") {
      pattern += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      pattern += "[^/]*";
      continue;
    }
    pattern += escapeRegExp(char ?? "");
  }
  return new RegExp(`^${pattern}$`, "u");
}

export function extractPromptTargetPaths(promptText: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const match of promptText.matchAll(PROMPT_PATH_CANDIDATE_PATTERN)) {
    const candidate = match[1]
      ?.replace(/[)\].,;:!?]+$/u, "")
      .replace(/^[([<{]+/u, "")
      .trim();
    if (!candidate || candidate.includes("://") || candidate.startsWith("#")) {
      continue;
    }
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    paths.push(candidate);
  }
  return paths;
}

export function pathGlobMatches(pathGlob: string, promptPaths: readonly string[]): boolean {
  const normalizedGlob = normalizePathForGlob(pathGlob);
  if (!normalizedGlob) {
    return false;
  }
  const hasWildcard = normalizedGlob.includes("*");
  const directoryPrefix = normalizedGlob.endsWith("/**")
    ? normalizedGlob.slice(0, -3)
    : normalizedGlob;
  const regexp = hasWildcard ? globToRegExp(normalizedGlob) : null;
  return promptPaths.some((path) => {
    const normalized = normalizePathForGlob(path).replace(/^\.\.\//u, "");
    if (!hasWildcard) {
      return normalized === normalizedGlob || normalized.startsWith(`${normalizedGlob}/`);
    }
    if (normalizedGlob.endsWith("/**")) {
      return normalized === directoryPrefix || normalized.startsWith(`${directoryPrefix}/`);
    }
    return regexp?.test(normalized) ?? false;
  });
}
