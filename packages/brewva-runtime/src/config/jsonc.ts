import { parse, printParseErrorCode } from "jsonc-parser";

interface JsoncParseIssue {
  error: number;
  offset: number;
  length: number;
}

const JSONC_PARSE_OPTIONS = {
  allowEmptyContent: false,
  allowTrailingComma: true,
} as const;

function resolveLineColumn(text: string, offset: number): { line: number; column: number } {
  const boundedOffset = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let column = 1;

  for (let index = 0; index < boundedOffset; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      column = 1;
      continue;
    }
    column += 1;
  }

  return { line, column };
}

function formatJsoncParseError(
  text: string,
  issue: JsoncParseIssue,
  additionalCount: number,
): string {
  const location = resolveLineColumn(text, issue.offset);
  const extra =
    additionalCount > 0
      ? ` (+${additionalCount} more parse error${additionalCount === 1 ? "" : "s"})`
      : "";
  return `${printParseErrorCode(issue.error)} at ${location.line}:${location.column}${extra}`;
}

export function parseJsonc(text: string): unknown {
  const errors: JsoncParseIssue[] = [];
  const parsed = parse(text, errors, JSONC_PARSE_OPTIONS) as unknown;
  if (errors.length === 0) {
    return parsed;
  }

  const [firstError, ...remainingErrors] = errors;
  if (!firstError) {
    throw new Error("Unknown JSONC parse failure");
  }
  throw new Error(formatJsoncParseError(text, firstError, remainingErrors.length));
}
