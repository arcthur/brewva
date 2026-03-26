export {
  createDetachedSubagentBackgroundController,
  type HostedSubagentBackgroundController,
} from "./background-controller.js";
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
  buildSyntheticHostedDelegationTarget,
  deriveDefaultAgentSpecNameForResultMode,
  deriveDefaultAgentSpecNameForSkillName,
  deriveFallbackResultModeForSkillName,
  loadHostedDelegationCatalog,
  resolveHostedExecutionEnvelope,
  type HostedAgentSpec,
  type HostedDelegationCatalog,
  type HostedExecutionEnvelope,
} from "./catalog.js";
export { buildDelegationPrompt } from "./prompt.js";
export {
  createIsolatedWorkspace,
  capturePatchSetFromIsolatedWorkspace,
  type IsolatedWorkspaceHandle,
} from "./workspace.js";
