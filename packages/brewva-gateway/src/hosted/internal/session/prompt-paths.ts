import { toPosixPath } from "@brewva/brewva-std/text";

const PROMPT_PATH_CANDIDATE_PATTERN =
  /(?:^|[\s`'"])((?:\/|\.{1,2}\/)[^\s`'",;:!?]+|[A-Za-z0-9_.@()-]+\/[A-Za-z0-9_./@()+-]+)(?=$|[\s`'",;:!?])/gu;

// Full-width / CJK punctuation that should delimit file paths, in addition to
// the ASCII delimiters baked into PROMPT_PATH_CANDIDATE_PATTERN. Listed by code
// point so this source stays ASCII-only. Real filesystem paths never contain
// these, so normalizing them to spaces lets prompts that separate multiple
// paths with Chinese punctuation split instead of gluing paths into one token.
const CJK_PATH_DELIMITERS = String.fromCodePoint(
  0xff0c, // fullwidth comma
  0x3001, // ideographic comma
  0xff1b, // fullwidth semicolon
  0xff1a, // fullwidth colon
  0xff01, // fullwidth exclamation mark
  0xff1f, // fullwidth question mark
  0x3002, // ideographic full stop
  0x3000, // ideographic space
);
const CJK_PATH_DELIMITER_PATTERN = new RegExp(`[${CJK_PATH_DELIMITERS}]`, "gu");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizePathForGlob(value: string): string {
  return toPosixPath(value).replace(/^\.\//u, "").replace(/\/+$/u, "");
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
  // Normalize full-width / CJK path delimiters to spaces first, so the
  // ASCII-oriented candidate pattern can split paths that a prompt separates
  // with Chinese punctuation. Real paths never contain these code points.
  const normalizedPrompt = promptText.replace(CJK_PATH_DELIMITER_PATTERN, " ");
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const match of normalizedPrompt.matchAll(PROMPT_PATH_CANDIDATE_PATTERN)) {
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
