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
  BUILTIN_SUBAGENT_PROFILES,
  loadHostedSubagentProfiles,
  mergeDelegationPacketWithProfileDefaults,
  type HostedSubagentBuiltinToolName,
  type HostedSubagentProfile,
} from "./profiles.js";
export { buildDelegationPrompt } from "./prompt.js";
export {
  createIsolatedWorkspace,
  capturePatchSetFromIsolatedWorkspace,
  type IsolatedWorkspaceHandle,
} from "./workspace.js";
