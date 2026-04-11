import { parse as parseYaml } from "yaml";

export interface ParsedMarkdownFrontmatter {
  data: Record<string, unknown>;
  body: string;
  rawMatter: string;
  hasFrontmatter: boolean;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function stripUtf8Bom(value: string): string {
  return value.startsWith("\uFEFF") ? value.slice(1) : value;
}

function hasFrontmatterOpeningDelimiter(value: string): boolean {
  const firstLineEnd = value.indexOf("\n");
  const firstLine = firstLineEnd === -1 ? value : value.slice(0, firstLineEnd);
  return /^---[ \t]*$/.test(firstLine);
}

function isEffectivelyEmptyFrontmatter(rawMatter: string): boolean {
  return (
    rawMatter
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n")
      .trim().length === 0
  );
}

export function parseMarkdownFrontmatter(input: string): ParsedMarkdownFrontmatter {
  const normalized = normalizeLineEndings(stripUtf8Bom(input));
  if (!hasFrontmatterOpeningDelimiter(normalized)) {
    return {
      data: {},
      body: normalized,
      rawMatter: "",
      hasFrontmatter: false,
    };
  }

  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n([\s\S]*))?$/.exec(normalized);
  if (!match) {
    throw new Error("invalid frontmatter: missing closing delimiter");
  }

  const rawMatter = match[1] ?? "";
  const body = match[2] ?? "";
  if (isEffectivelyEmptyFrontmatter(rawMatter)) {
    return {
      data: {},
      body,
      rawMatter,
      hasFrontmatter: true,
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(rawMatter);
  } catch (error) {
    throw new Error(
      `invalid frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid frontmatter: frontmatter must parse to an object");
  }

  return {
    data: parsed as Record<string, unknown>,
    body,
    rawMatter,
    hasFrontmatter: true,
  };
}
