import type {
  BrewvaHostedRuntimePort,
  BrewvaOperatorRuntimePort,
  BrewvaRuntimeRoot,
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
  BrewvaOperatorRuntimePort,
  BrewvaRuntimeIdentity,
  BrewvaRuntimeOptions,
  BrewvaRuntimeRoot,
  BrewvaToolRuntimePort,
  RuntimeOperatorPort,
  VerifyCompletionOptions,
} from "./runtime-api.js";

export class BrewvaRuntime implements BrewvaRuntimeRoot {
  readonly identity: RuntimeFacadeState["identity"];
  readonly config: RuntimeFacadeState["config"];
  readonly authority: RuntimeFacadeState["authority"];
  readonly inspect: RuntimeFacadeState["inspect"];

  constructor(options: BrewvaRuntimeOptions = {}) {
    const state = createRuntimeFacadeState(options);
    this.identity = state.identity;
    this.config = state.config;
    this.authority = state.authority;
    this.inspect = state.inspect;
    Object.defineProperty(this, BREWVA_RUNTIME_INTERNAL_STATE_SYMBOL, {
      value: state[BREWVA_RUNTIME_INTERNAL_STATE_SYMBOL],
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
}

function getRuntimeFacadeState(
  runtime: BrewvaRuntime,
): Pick<RuntimeFacadeState, "operator" | "extensions"> {
  const state = (
    runtime as BrewvaRuntime & {
      readonly [BREWVA_RUNTIME_INTERNAL_STATE_SYMBOL]?: Pick<
        RuntimeFacadeState,
        "operator" | "extensions"
      >;
    }
  )[BREWVA_RUNTIME_INTERNAL_STATE_SYMBOL];
  if (!state) {
    throw new Error("invalid_brewva_runtime");
  }
  return state;
}

function isHostedRuntimePort(
  runtime: BrewvaRuntime | BrewvaHostedRuntimePort,
): runtime is BrewvaHostedRuntimePort {
  return "extensions" in runtime && "operator" in runtime;
}

export function createHostedRuntimePort(
  runtime: BrewvaRuntime | BrewvaHostedRuntimePort,
): BrewvaHostedRuntimePort {
  if (isHostedRuntimePort(runtime)) {
    return runtime;
  }
  const state = getRuntimeFacadeState(runtime);
  return {
    identity: runtime.identity,
    config: runtime.config,
    authority: runtime.authority,
    inspect: runtime.inspect,
    operator: state.operator,
    extensions: state.extensions,
  };
}

export function createToolRuntimePort(
  runtime: BrewvaRuntime | BrewvaHostedRuntimePort,
): BrewvaToolRuntimePort {
  if (isHostedRuntimePort(runtime)) {
    return {
      identity: runtime.identity,
      config: runtime.config,
      authority: runtime.authority,
      inspect: runtime.inspect,
      extensions: {
        tools: runtime.extensions.tools,
      },
    };
  }
  const state = getRuntimeFacadeState(runtime);
  return {
    identity: runtime.identity,
    config: runtime.config,
    authority: runtime.authority,
    inspect: runtime.inspect,
    extensions: {
      tools: state.extensions.tools,
    },
  };
}

export function createOperatorRuntimePort(
  runtime: BrewvaRuntime | BrewvaHostedRuntimePort,
): BrewvaOperatorRuntimePort {
  const operator = isHostedRuntimePort(runtime)
    ? runtime.operator
    : getRuntimeFacadeState(runtime).operator;
  return {
    identity: runtime.identity,
    config: runtime.config,
    inspect: runtime.inspect,
    operator,
  };
}
