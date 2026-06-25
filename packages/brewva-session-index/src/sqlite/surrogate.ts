// FTS5 has no pure passthrough tokenizer: its built-in `ascii` and `unicode61`
// tokenizers both re-process input and would re-segment or normalize the jieba
// CJK tokens that `@brewva/brewva-search` already owns — silently violating the
// tokenizer boundary the search-token-policy decision protects.
//
// We therefore surrogate-encode every brewva-search token into an ASCII-safe,
// atomic symbol before it enters an FTS5 column. Index and query terms are encoded
// identically, so any FTS5 tokenizer becomes a true passthrough (each "word" is
// already a single ASCII run) and segmentation stays entirely in brewva-search.

const SURROGATE_PREFIX = "t";

/** Encode a token to an ASCII-safe, FTS5-atomic symbol. Deterministic. */
export function encodeToken(token: string): string {
  return SURROGATE_PREFIX + Buffer.from(token, "utf8").toString("hex");
}

/** Inverse of {@link encodeToken}; restores the original token for display. */
export function decodeToken(encoded: string): string {
  return Buffer.from(encoded.slice(SURROGATE_PREFIX.length), "hex").toString("utf8");
}

/** Encode a list of tokens into a single space-joined FTS5 column value. */
export function encodeTokensToColumn(tokens: readonly string[]): string {
  return tokens.map(encodeToken).join(" ");
}

/** Build an FTS5 MATCH expression that ORs the encoded query tokens. */
export function encodeTokensToMatchExpression(tokens: readonly string[]): string {
  return tokens.map((token) => `"${encodeToken(token)}"`).join(" OR ");
}
