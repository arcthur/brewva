// Curated config contract subpath. Keep root imports focused on createBrewvaRuntime and explicit port types.
export type {
  BrewvaConfig,
  BrewvaConfigFile,
  BrewvaMcpIntegrationConfig,
  BrewvaMcpServerConfig,
  BrewvaMcpStdioServerConfig,
  BrewvaMcpStreamableHttpServerConfig,
  BrewvaMcpToolPolicyConfig,
  BrewvaMcpToolSurfaceOverride,
  BrewvaScheduleSelfImproveConfig,
  BrewvaSecurityBoundaryNetworkRule,
  BrewvaSecurityBoundaryPolicy,
  BrewvaSecurityCredentialBinding,
  BrewvaSecurityCredentialsConfig,
  BrewvaSecurityExactCallLoopConfig,
} from "./config/types.js";
export { DEFAULT_BREWVA_CONFIG } from "./config/defaults.js";
export { parseJsonc } from "./config/jsonc.js";
export {
  BrewvaConfigLoadError,
  formatBrewvaConfigWarning,
  loadBrewvaConfig,
  loadBrewvaConfigResolution,
  loadBrewvaInspectConfigResolution,
  normalizeExplicitBrewvaConfig,
  normalizeExplicitBrewvaConfigResolution,
} from "./config/loader.js";
export type {
  BrewvaConfigLoadErrorCode,
  BrewvaConfigMetadata,
  BrewvaConfigResolution,
  BrewvaForensicConfigResolution,
  BrewvaForensicConfigWarning,
  BrewvaForensicConfigWarningCode,
  LoadConfigOptions,
  NormalizeExplicitBrewvaConfigOptions,
} from "./config/loader.js";
export {
  collectPathCandidates,
  isIgnoredWorkspacePath,
  normalizeWorkspaceRelativePath,
  resolveWorkspacePath,
  toWorkspaceRelativePath,
} from "./config/workspace-paths.js";
export {
  BREWVA_CONFIG_DIR_RELATIVE,
  BREWVA_CONFIG_FILE_NAME,
  normalizePathInput,
  resolveBrewvaAgentDir,
  resolveBrewvaConfigPathForRoot,
  resolveGlobalBrewvaConfigPath,
  resolveGlobalBrewvaRootDir,
  resolvePathInput,
  resolveProjectBrewvaConfigPath,
  resolveProjectBrewvaRootDir,
  resolveWorkspaceRootDir,
} from "./config/paths.js";
