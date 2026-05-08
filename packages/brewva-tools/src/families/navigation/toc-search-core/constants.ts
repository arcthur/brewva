export const JS_TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
export const MAX_CACHE_SESSIONS = 64;
export const MAX_CACHE_ENTRIES_PER_SESSION = 512;

export const DEFAULT_TOC_SEARCH_LIMIT = 8;
export const MAX_TOC_SEARCH_LIMIT = 50;
export const MAX_TOC_FILE_BYTES = 1_000_000;
export const MAX_TOC_SEARCH_CANDIDATE_FILES = 2_000;
export const MAX_TOC_SEARCH_INDEXED_BYTES = 8_000_000;

export const BROAD_QUERY_MIN_FILE_COUNT = 3;
export const BROAD_QUERY_SINGLE_TOKEN_RATIO = 0.35;
export const BROAD_QUERY_MULTI_TOKEN_RATIO = 0.6;
export const BROAD_QUERY_FACTOR = 4;
export const BROAD_QUERY_ABSOLUTE_CANDIDATES = 12;
