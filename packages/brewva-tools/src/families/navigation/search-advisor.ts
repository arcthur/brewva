export {
  attachSearchIntentPreviewCandidates,
  buildSearchAdvisorSnapshot,
  registerSearchIntent,
} from "./search-advisor/api.js";
export {
  buildDelimiterInsensitivePattern,
  normalizeSearchAdvisorPath,
  normalizeSearchAdvisorQuery,
} from "./search-advisor/path.js";
export type {
  SearchAdvisorFileScore,
  SearchAdvisorSnapshot,
  SearchToolName,
} from "./search-advisor/types.js";
