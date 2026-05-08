import type {
  RuntimeLazyServiceFactories,
  RuntimeLazyServiceRegistrarOptions,
} from "../../runtime/service-registrar-types.js";
import { CONTROL_PLANE_TOOLS } from "../../security/control-plane-tools.js";
import type { ResourceLeaseService } from "../parallel/api.js";
import type { FileChangeService } from "../patching/api.js";
import { TOOLS_EVENT_DESCRIPTORS } from "./event-descriptors.js";
import { toolsSurfaceContribution } from "./runtime-surface.js";
import { ToolAccessPolicyService } from "./tool-access-policy.js";
import { ToolGateService } from "./tool-gate.js";
import { ToolInvocationSpine } from "./tool-invocation-spine.js";
import { ToolStartReadinessService } from "./tool-start-readiness.js";

interface RuntimeToolsDomainRegistrarSupport {
  getFileChangeService(): FileChangeService;
  getResourceLeaseService(): ResourceLeaseService;
}

export interface RuntimeToolsDomainRegistration {
  lazyFactories: Pick<
    RuntimeLazyServiceFactories,
    "createToolGateService" | "createToolInvocationSpine"
  >;
  surfaceContribution: typeof toolsSurfaceContribution;
  eventDescriptors: typeof TOOLS_EVENT_DESCRIPTORS;
}

export function registerToolsDomain(
  options: RuntimeLazyServiceRegistrarOptions,
  support: RuntimeToolsDomainRegistrarSupport,
): RuntimeToolsDomainRegistration {
  let toolAccessPolicyService: ToolAccessPolicyService | undefined;
  const getToolAccessPolicyService = (): ToolAccessPolicyService => {
    toolAccessPolicyService ??= new ToolAccessPolicyService({
      costTracker: options.coreDependencies.costTracker,
      sessionState: options.sessionState,
      getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
      recordEvent: (input) => options.kernel.recordEvent(input),
      alwaysAllowedTools: CONTROL_PLANE_TOOLS,
      resolveToolAuthority: (toolName, args) => options.resolveToolAuthority(toolName, args),
      hasRoutingScope: (scope) => new Set<string>(options.config.skills.routing.scopes).has(scope),
    });
    return toolAccessPolicyService;
  };

  let toolStartReadinessService: ToolStartReadinessService | undefined;
  const getToolStartReadinessService = (): ToolStartReadinessService => {
    toolStartReadinessService ??= new ToolStartReadinessService({
      contextService: options.contextService,
    });
    return toolStartReadinessService;
  };

  let toolGateService: ToolGateService | undefined;
  const getToolGateService = (): ToolGateService => {
    toolGateService ??= new ToolGateService({
      workspaceRoot: options.workspaceRoot,
      securityConfig: options.config.security,
      sessionState: options.sessionState,
      getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
      recordEvent: (input) => options.kernel.recordEvent(input),
      resolveToolAuthority: (toolName, args) => options.resolveToolAuthority(toolName, args),
      toolAccessPolicyService: getToolAccessPolicyService(),
      proposalAdmissionService: {
        submitProposal: (sessionId, proposal) =>
          options.getProposalAdmissionService().submitProposal(sessionId, proposal),
      },
      effectCommitmentDeskService: {
        prepareResume: (input) => options.getEffectCommitmentDeskService().prepareResume(input),
        getRequestIdForProposal: (sessionId, proposalId) =>
          options.getEffectCommitmentDeskService().getRequestIdForProposal(sessionId, proposalId),
      },
    });
    return toolGateService;
  };

  let toolInvocationSpine: ToolInvocationSpine | undefined;
  const getToolInvocationSpine = (): ToolInvocationSpine => {
    toolInvocationSpine ??= new ToolInvocationSpine({
      toolStartReadinessService: getToolStartReadinessService(),
      toolGateService: getToolGateService(),
      fileChangeService: support.getFileChangeService(),
      ledgerService: options.ledgerService,
      reversibleMutationService: options.reversibleMutationService,
    });
    return toolInvocationSpine;
  };

  return {
    lazyFactories: {
      createToolGateService: () => getToolGateService(),
      createToolInvocationSpine: () => getToolInvocationSpine(),
    },
    surfaceContribution: toolsSurfaceContribution,
    eventDescriptors: TOOLS_EVENT_DESCRIPTORS,
  };
}
