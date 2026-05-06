export interface SearchTokenizationOptions {
  minLength?: number;
  includeCjkNgrams?: boolean;
}

export interface InternalSearchTokenizationOptions extends SearchTokenizationOptions {
  includeCompoundSubtokens: boolean;
}

export const DEFAULT_ASCII_MIN_LENGTH = 2;
export const CJK_MIN_LENGTH = 2;
export const CJK_NGRAM_SIZES = [2, 3] as const;
