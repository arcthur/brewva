// Curated security contract subpath. Keep root imports focused on BrewvaRuntime.
export {
  getSourceTrustTier,
  sanitizeByTrust,
  sanitizeContextText,
  wrapByTrust,
} from "./security/sanitize.js";
export type { SourceTrustTier } from "./security/sanitize.js";
export {
  sanitizeCompactionSummary,
  validateCompactionSummary,
} from "./security/compaction-integrity.js";
export type { CompactionIntegrityResult } from "./security/compaction-integrity.js";
export {
  analyzeShellCommand,
  collectCommandPolicyNetworkTargets,
  summarizeShellCommandAnalysis,
} from "./security/command-policy.js";
export type {
  CommandPolicyCommand,
  CommandPolicyEffect,
  CommandPolicyNetworkTarget,
  CommandPolicySummary,
  CommandPolicyUnsupportedReason,
  FilesystemIntent,
  ShellCommandAnalysis,
} from "./security/command-policy.js";
export {
  analyzeVirtualReadonlyEligibility,
  summarizeVirtualReadonlyEligibility,
} from "./security/virtual-readonly-policy.js";
export type {
  VirtualReadonlyBlockedReason,
  VirtualReadonlyEligibility,
  VirtualReadonlyPolicySummary,
} from "./security/virtual-readonly-policy.js";
export {
  classifyToolBoundaryRequest,
  collectExplicitUrlTargets,
  evaluateBoundaryClassification,
  resolveBoundaryPolicy,
} from "./security/boundary-policy.js";
export type {
  ResolvedBoundaryPolicy,
  ToolBoundaryClassification,
} from "./security/boundary-policy.js";
export { checkToolAccess } from "./security/tool-policy.js";
export type { ToolPolicyOptions } from "./security/tool-policy.js";
