import { normalizeSearchText } from "../normalization.js";
import { collectAsciiTokens } from "./ascii.js";
import { collectCjkTokens } from "./cjk.js";
import type { InternalSearchTokenizationOptions, SearchTokenizationOptions } from "./options.js";

export function tokenizeSearchQuery(
  value: string,
  options: SearchTokenizationOptions = {},
): string[] {
  return tokenizeSearchTextInternal(value, {
    ...options,
    includeCompoundSubtokens: false,
  });
}

export function tokenizeSearchContent(
  value: string,
  options: SearchTokenizationOptions = {},
): string[] {
  return tokenizeSearchTextInternal(value, {
    ...options,
    includeCompoundSubtokens: true,
  });
}

export function tokenizeSearchTextInternal(
  value: string,
  options: InternalSearchTokenizationOptions,
): string[] {
  const normalized = normalizeSearchText(value);
  const includeCjkNgrams = options.includeCjkNgrams ?? true;
  const tokens: string[] = [];
  const seen = new Set<string>();

  const addToken = (token: string, minimumLength: number): void => {
    const normalizedToken = token.trim();
    if (normalizedToken.length < minimumLength || seen.has(normalizedToken)) {
      return;
    }
    seen.add(normalizedToken);
    tokens.push(normalizedToken);
  };

  collectAsciiTokens({
    normalized,
    minLength: options.minLength,
    includeCompoundSubtokens: options.includeCompoundSubtokens,
    addToken,
  });
  collectCjkTokens({
    normalized,
    includeCjkNgrams,
    addToken,
  });

  return tokens;
}
