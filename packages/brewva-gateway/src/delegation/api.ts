export {
  createDetachedSubagentBackgroundController,
  type HostedSubagentBackgroundController,
} from "./background/controller.js";
export {
  HostedDelegationStore,
  buildDelegationLifecyclePayload,
  type HostedDelegationStore as HostedDelegationStoreInstance,
} from "./delegation-store.js";
export {
  createHostedSubagentAdapter,
  type HostedSubagentAdapterOptions,
  type HostedSubagentSessionOptions,
} from "./orchestrator.js";
export {
  mergeDelegationPacketWithTargetDefaults,
  type HostedDelegationBuiltinToolName,
  type HostedDelegationTarget,
} from "./targets.js";
export {
  BUILTIN_AGENT_SPECS,
  BUILTIN_EXECUTION_ENVELOPES,
  buildHostedDelegationTargetFromAgentSpec,
  deriveDefaultAgentSpecNameForResultMode,
  deriveDefaultAgentSpecNameForSkillName,
  deriveFallbackResultModeForSkillName,
  loadHostedDelegationCatalog,
  resolveHostedExecutionEnvelope,
  type HostedAgentSpec,
  type HostedDelegationCatalog,
  type HostedExecutionEnvelope,
} from "./catalog/registry.js";
export {
  createDelegationModelRoutingContext,
  createDelegationModelRoutingContextFromAgentDir,
  resolveDelegationModelRoute,
  type DelegationModelRoutingContext,
  type ResolvedDelegationModelRoute,
} from "./model-routing.js";
export {
  asString,
  asStringArray,
  readHostedWorkspaceSubagentConfigFiles,
  type HostedWorkspaceSubagentConfigFile,
} from "./config-files.js";
export { buildDelegationPrompt } from "./prompt.js";
export {
  createIsolatedWorkspace,
  capturePatchSetFromIsolatedWorkspace,
  collectChangedPathsFromIsolatedWorkspace,
  type IsolatedWorkspaceHandle,
} from "./workspace.js";
