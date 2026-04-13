export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIndex = content.indexOf("\r\n");
  const lfIndex = content.indexOf("\n");
  if (lfIndex === -1 || crlfIndex === -1) {
    return "\n";
  }
  return crlfIndex < lfIndex ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

export interface Edit {
  oldText: string;
  newText: string;
}

interface FuzzyMatchResult {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
}

interface MatchedEdit {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

export interface AppliedEditsResult {
  baseContent: string;
  newContent: string;
}

function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
    };
  }

  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
    };
  }

  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
  };
}

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  return fuzzyContent.split(fuzzyOldText).length - 1;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
    );
  }
  return new Error(
    `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
  );
}

function getDuplicateError(
  path: string,
  editIndex: number,
  totalEdits: number,
  occurrences: number,
): Error {
  if (totalEdits === 1) {
    return new Error(
      `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
    );
  }
  return new Error(
    `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
  );
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(`oldText must not be empty in ${path}.`);
  }
  return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
    );
  }
  return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: Edit[],
  path: string,
): AppliedEditsResult {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  for (let index = 0; index < normalizedEdits.length; index += 1) {
    if (normalizedEdits[index]?.oldText.length === 0) {
      throw getEmptyOldTextError(path, index, normalizedEdits.length);
    }
  }

  const initialMatches = normalizedEdits.map((edit) =>
    fuzzyFindText(normalizedContent, edit.oldText),
  );
  const baseContent = initialMatches.some((match) => match.usedFuzzyMatch)
    ? normalizeForFuzzyMatch(normalizedContent)
    : normalizedContent;

  const matchedEdits: MatchedEdit[] = [];
  for (let index = 0; index < normalizedEdits.length; index += 1) {
    const edit = normalizedEdits[index]!;
    const match = fuzzyFindText(baseContent, edit.oldText);
    if (!match.found) {
      throw getNotFoundError(path, index, normalizedEdits.length);
    }

    const occurrences = countOccurrences(baseContent, edit.oldText);
    if (occurrences > 1) {
      throw getDuplicateError(path, index, normalizedEdits.length, occurrences);
    }

    matchedEdits.push({
      editIndex: index,
      matchIndex: match.index,
      matchLength: match.matchLength,
      newText: edit.newText,
    });
  }

  matchedEdits.sort((left, right) => left.matchIndex - right.matchIndex);
  for (let index = 1; index < matchedEdits.length; index += 1) {
    const previous = matchedEdits[index - 1]!;
    const current = matchedEdits[index]!;
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  let newContent = baseContent;
  for (let index = matchedEdits.length - 1; index >= 0; index -= 1) {
    const edit = matchedEdits[index]!;
    newContent =
      newContent.slice(0, edit.matchIndex) +
      edit.newText +
      newContent.slice(edit.matchIndex + edit.matchLength);
  }

  if (baseContent === newContent) {
    throw getNoChangeError(path, normalizedEdits.length);
  }

  return { baseContent, newContent };
}

interface DiffOperation {
  type: "context" | "removed" | "added";
  line: string;
}

function buildDiffOperations(oldLines: string[], newLines: string[]): DiffOperation[] {
  const rows = oldLines.length;
  const cols = newLines.length;
  const dp: number[][] = Array.from({ length: rows + 1 }, () => Array<number>(cols + 1).fill(0));

  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let col = cols - 1; col >= 0; col -= 1) {
      dp[row]![col] =
        oldLines[row] === newLines[col]
          ? (dp[row + 1]![col + 1] ?? 0) + 1
          : Math.max(dp[row + 1]![col] ?? 0, dp[row]![col + 1] ?? 0);
    }
  }

  const operations: DiffOperation[] = [];
  let row = 0;
  let col = 0;
  while (row < rows && col < cols) {
    if (oldLines[row] === newLines[col]) {
      operations.push({ type: "context", line: oldLines[row]! });
      row += 1;
      col += 1;
      continue;
    }
    if ((dp[row + 1]![col] ?? 0) >= (dp[row]![col + 1] ?? 0)) {
      operations.push({ type: "removed", line: oldLines[row]! });
      row += 1;
    } else {
      operations.push({ type: "added", line: newLines[col]! });
      col += 1;
    }
  }
  while (row < rows) {
    operations.push({ type: "removed", line: oldLines[row]! });
    row += 1;
  }
  while (col < cols) {
    operations.push({ type: "added", line: newLines[col]! });
    col += 1;
  }
  return operations;
}

export function generateDiffString(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  if (oldLines.at(-1) === "") {
    oldLines.pop();
  }
  if (newLines.at(-1) === "") {
    newLines.pop();
  }

  const operations = buildDiffOperations(oldLines, newLines);
  const maxLineNum = Math.max(oldLines.length, newLines.length);
  const lineNumWidth = String(maxLineNum || 1).length;

  const output: string[] = [];
  let oldLineNum = 1;
  let newLineNum = 1;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;

  let index = 0;
  while (index < operations.length) {
    const operation = operations[index]!;
    if (operation.type === "removed" || operation.type === "added") {
      if (firstChangedLine === undefined) {
        firstChangedLine = newLineNum;
      }

      if (operation.type === "removed") {
        output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${operation.line}`);
        oldLineNum += 1;
      } else {
        output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${operation.line}`);
        newLineNum += 1;
      }
      lastWasChange = true;
      index += 1;
      continue;
    }

    let runEnd = index;
    while (runEnd < operations.length && operations[runEnd]?.type === "context") {
      runEnd += 1;
    }

    const run = operations.slice(index, runEnd);
    const nextPartIsChange =
      runEnd < operations.length &&
      (operations[runEnd]?.type === "removed" || operations[runEnd]?.type === "added");
    const hasLeadingChange = lastWasChange;
    const hasTrailingChange = nextPartIsChange;

    const emitContextLine = (line: string) => {
      output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
      oldLineNum += 1;
      newLineNum += 1;
    };

    if (hasLeadingChange && hasTrailingChange) {
      if (run.length <= contextLines * 2) {
        for (const entry of run) {
          emitContextLine(entry.line);
        }
      } else {
        const leading = run.slice(0, contextLines);
        const trailing = run.slice(run.length - contextLines);
        const skipped = run.length - leading.length - trailing.length;
        for (const entry of leading) {
          emitContextLine(entry.line);
        }
        output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
        oldLineNum += skipped;
        newLineNum += skipped;
        for (const entry of trailing) {
          emitContextLine(entry.line);
        }
      }
    } else if (hasLeadingChange) {
      const shown = run.slice(0, contextLines);
      const skipped = run.length - shown.length;
      for (const entry of shown) {
        emitContextLine(entry.line);
      }
      if (skipped > 0) {
        output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
        oldLineNum += skipped;
        newLineNum += skipped;
      }
    } else if (hasTrailingChange) {
      const skipped = Math.max(0, run.length - contextLines);
      if (skipped > 0) {
        output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
        oldLineNum += skipped;
        newLineNum += skipped;
      }
      for (const entry of run.slice(skipped)) {
        emitContextLine(entry.line);
      }
    } else {
      oldLineNum += run.length;
      newLineNum += run.length;
    }

    lastWasChange = false;
    index = runEnd;
  }

  return {
    diff: output.join("\n"),
    firstChangedLine,
  };
}
