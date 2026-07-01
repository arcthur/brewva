import { cloneCliShellPromptParts, rebasePromptPartsAfterTextReplace } from "./prompt-parts.js";
import type { CliShellPromptPart } from "./prompt.js";
import type { BrewvaTuiLargePasteThreshold } from "./tui.js";

/** Placeholder token shown in the composer for a folded paste. */
export function summarizePastedText(text: string): string {
  const lineCount = (text.match(/\n/gu)?.length ?? 0) + 1;
  return lineCount >= 2 ? `[Pasted ~${lineCount} lines]` : "[Pasted text]";
}

/**
 * Whether a paste is large enough to fold into a placeholder. Either trigger
 * folds it (line count OR character count); neither alone requires the other.
 */
export function shouldFoldPastedText(
  trimmed: string,
  threshold: BrewvaTuiLargePasteThreshold,
): boolean {
  const lineCount = (trimmed.match(/\n/gu)?.length ?? 0) + 1;
  return lineCount >= threshold.minLines || trimmed.length > threshold.minCharacters;
}

/**
 * Build the folded-paste insertion + prompt parts. The full pasted text is kept
 * in a text part's `source`, while the composer shows only the placeholder
 * token; `insertAt` is the UTF-16 cursor offset the token is inserted at, and
 * `makeId` is injected so the pure result is deterministic under test.
 */
export function buildPastedTextFold(input: {
  trimmed: string;
  insertAt: number;
  parts: readonly CliShellPromptPart[];
  makeId: () => string;
}): { insertion: string; tokenText: string; parts: CliShellPromptPart[] } {
  const tokenText = summarizePastedText(input.trimmed);
  const insertion = `${tokenText} `;
  const parts = rebasePromptPartsAfterTextReplace(
    cloneCliShellPromptParts(input.parts),
    {
      start: input.insertAt,
      end: input.insertAt,
      replacementText: insertion,
    },
    {
      id: input.makeId(),
      type: "text",
      text: input.trimmed,
      source: {
        text: {
          start: input.insertAt,
          end: input.insertAt + tokenText.length,
          value: tokenText,
        },
      },
    },
  );
  return { insertion, tokenText, parts };
}
