export {
  DEFAULT_TOC_SEARCH_LIMIT,
  MAX_TOC_FILE_BYTES,
  MAX_TOC_SEARCH_CANDIDATE_FILES,
  MAX_TOC_SEARCH_INDEXED_BYTES,
  MAX_TOC_SEARCH_LIMIT,
} from "./toc-search-core/constants.js";
export { createTocSearchSessionCacheStore, lookupTocDocument } from "./toc-search-core/cache.js";
export { normalizeRelativePath, supportsToc } from "./toc-search-core/document.js";
export { runTocSearchCore } from "./toc-search-core/runner.js";
export { formatLineSpan } from "./toc-search-core/search.js";
export type {
  TocDocument,
  TocLookupResult,
  TocSearchCoreAdvisor,
  TocSearchCoreResult,
  TocSearchMatch,
  TocSearchSessionCacheStore,
  TocSearchSummary,
} from "./toc-search-core/types.js";
