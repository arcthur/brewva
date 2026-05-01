import type { RuntimeServiceRegistrarOptions } from "../../runtime/service-registrar-types.js";
import { CONTEXT_CRITICAL_ALLOWED_TOOLS } from "../../security/control-plane-tools.js";
import type { LedgerService } from "../ledger/api.js";
import type { SkillLifecycleService } from "../skills/api.js";
import type { TaskService } from "../task/api.js";
import { registerBuiltInContextSourceProviders } from "./builtins.js";
import { ContextService } from "./context.js";
import { ContextSourceProviderRegistry } from "./provider.js";
import { contextSurfaceContribution } from "./runtime-surface.js";

export interface RuntimeContextDomainRegistration {
  services: {
    contextService: ContextService;
  };
  surfaceContribution: typeof contextSurfaceContribution;
}

export function registerContextDomain(
  options: RuntimeServiceRegistrarOptions,
  support: {
    skillLifecycleService: SkillLifecycleService;
    taskService: TaskService;
    ledgerService: LedgerService;
  },
): RuntimeContextDomainRegistration {
  const contextSourceProviders = new ContextSourceProviderRegistry();
  registerBuiltInContextSourceProviders(contextSourceProviders, {
    workspaceRoot: options.workspaceRoot,
    agentId: options.agentId,
    kernel: options.kernel,
    skillLifecycleService: support.skillLifecycleService,
    skillRegistry: options.coreDependencies.skillRegistry,
  });

  return {
    services: {
      contextService: new ContextService({
        config: options.config,
        contextBudget: options.coreDependencies.contextBudget,
        contextInjection: options.coreDependencies.contextInjection,
        sessionState: options.sessionState,
        getTruthState: (sessionId) => options.kernel.getTruthState(sessionId),
        getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
        sanitizeInput: (text) => options.kernel.sanitizeInput(text),
        recordEvent: (input) => options.kernel.recordEvent(input),
        alwaysAllowedTools: CONTEXT_CRITICAL_ALLOWED_TOOLS,
        contextSourceProviders,
        ledgerService: support.ledgerService,
        skillLifecycleService: support.skillLifecycleService,
        taskService: support.taskService,
        governancePort: options.governancePort,
      }),
    },
    surfaceContribution: contextSurfaceContribution,
  };
}
