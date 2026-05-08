import type {
  BrewvaHostedRuntimePort,
  BrewvaOperatorRuntimePort,
  BrewvaRuntimeOptions,
  BrewvaToolRuntimePort,
} from "./runtime-api.js";
import {
  BREWVA_RUNTIME_INTERNAL_STATE_SYMBOL,
  createRuntimeFacadeState,
  type RuntimeFacadeState,
} from "./runtime-facade-state.js";

export type {
  BrewvaAuthorityPort,
  BrewvaHostedRuntimePort,
  BrewvaInspectionPort,
  BrewvaMaintenancePort,
  BrewvaOperatorRuntimePort,
  BrewvaRuntimeIdentity,
  BrewvaRuntimeOptions,
  BrewvaToolRuntimePort,
  VerifyCompletionOptions,
} from "./runtime-api.js";

export class BrewvaRuntime implements BrewvaHostedRuntimePort {
  readonly cwd: RuntimeFacadeState["cwd"];
  readonly workspaceRoot: RuntimeFacadeState["workspaceRoot"];
  readonly agentId: RuntimeFacadeState["agentId"];
  readonly config: RuntimeFacadeState["config"];
  readonly authority: RuntimeFacadeState["authority"];
  readonly inspect: RuntimeFacadeState["inspect"];
  readonly maintain: RuntimeFacadeState["maintain"];
  readonly extensions: RuntimeFacadeState["extensions"];

  constructor(options: BrewvaRuntimeOptions = {}) {
    const state = createRuntimeFacadeState(options);
    this.cwd = state.cwd;
    this.workspaceRoot = state.workspaceRoot;
    this.agentId = state.agentId;
    this.config = state.config;
    this.authority = state.authority;
    this.inspect = state.inspect;
    this.maintain = state.maintain;
    this.extensions = state.extensions;
    Object.defineProperty(this, BREWVA_RUNTIME_INTERNAL_STATE_SYMBOL, {
      value: state[BREWVA_RUNTIME_INTERNAL_STATE_SYMBOL],
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
}

export function createHostedRuntimePort(runtime: BrewvaRuntime): BrewvaHostedRuntimePort {
  return {
    cwd: runtime.cwd,
    workspaceRoot: runtime.workspaceRoot,
    agentId: runtime.agentId,
    config: runtime.config,
    authority: runtime.authority,
    inspect: runtime.inspect,
    maintain: runtime.maintain,
    extensions: runtime.extensions,
  };
}

export function createToolRuntimePort(runtime: BrewvaRuntime): BrewvaToolRuntimePort {
  return {
    cwd: runtime.cwd,
    workspaceRoot: runtime.workspaceRoot,
    agentId: runtime.agentId,
    config: runtime.config,
    authority: runtime.authority,
    inspect: runtime.inspect,
    maintain: {
      workbench: runtime.maintain.workbench,
    },
    extensions: {
      tools: runtime.extensions.tools,
    },
  };
}

export function createOperatorRuntimePort(runtime: BrewvaRuntime): BrewvaOperatorRuntimePort {
  return {
    cwd: runtime.cwd,
    workspaceRoot: runtime.workspaceRoot,
    agentId: runtime.agentId,
    config: runtime.config,
    inspect: runtime.inspect,
    maintain: {
      session: runtime.maintain.session,
      recovery: runtime.maintain.recovery,
    },
  };
}
