import { DEFAULT_ASCII_MIN_LENGTH } from "./options.js";

const ASCII_TOKEN_PATTERN = /[a-z0-9][a-z0-9._/-]*/gu;
const ASCII_PATH_SPLIT_PATTERN = /[/.]+/u;
const ASCII_WORD_SPLIT_PATTERN = /[_-]+/u;

export function collectAsciiTokens(input: {
  normalized: string;
  minLength?: number;
  includeCompoundSubtokens: boolean;
  addToken(token: string, minimumLength: number): void;
}): void {
  const minLength = Math.max(1, Math.floor(input.minLength ?? DEFAULT_ASCII_MIN_LENGTH));
  for (const match of input.normalized.matchAll(ASCII_TOKEN_PATTERN)) {
    const token = match[0];
    input.addToken(token, minLength);
    if (!input.includeCompoundSubtokens) {
      continue;
    }
    for (const pathSegment of token.split(ASCII_PATH_SPLIT_PATTERN)) {
      input.addToken(pathSegment, minLength);
      for (const wordSegment of pathSegment.split(ASCII_WORD_SPLIT_PATTERN)) {
        input.addToken(wordSegment, minLength);
      }
    }
  }
}
