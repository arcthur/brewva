import type {
  BrewvaHostedRuntimePort,
  BrewvaRuntimeInstance,
  BrewvaToolRuntimePort,
} from "@brewva/brewva-runtime";

export type HostedRuntimeInput = BrewvaRuntimeInstance | BrewvaHostedRuntimePort;

export function toHostedRuntimePort(runtime: HostedRuntimeInput): BrewvaHostedRuntimePort {
  return "hosted" in runtime ? runtime.hosted : runtime;
}

export function toToolRuntimePort(runtime: HostedRuntimeInput): BrewvaToolRuntimePort {
  if ("tool" in runtime) {
    return runtime.tool;
  }
  return Object.freeze({
    identity: runtime.identity,
    config: runtime.config,
    authority: runtime.authority,
    inspect: runtime.inspect,
    extensions: Object.freeze({
      tools: runtime.extensions.tools,
    }),
  });
}
