import type { BoxPlane } from "@brewva/brewva-box";
import type { BrewvaToolRuntimePort as RuntimeToolRuntimePort } from "@brewva/brewva-runtime";
import type { BrewvaToolDelegationQuery, BrewvaToolOrchestration } from "./delegation.js";
import type { BrewvaToolRuntimeExtensions, BrewvaToolRuntimeToolsExtension } from "./metadata.js";

type BrewvaToolRuntimeBase = Pick<
  RuntimeToolRuntimePort,
  "identity" | "config" | "authority" | "inspect"
>;

export type BrewvaToolRuntime = BrewvaToolRuntimeBase & {
  extensions?: BrewvaToolRuntimeExtensions;
  orchestration?: BrewvaToolOrchestration;
  delegation?: BrewvaToolDelegationQuery;
};

type CapabilityScopedMethod<
  TMethod,
  TCapability extends string,
  TCapabilities extends string,
> = TMethod extends (...args: infer TArgs) => infer TResult
  ? TCapability extends TCapabilities
    ? (...args: TArgs) => TResult
    : never
  : TMethod;

type CapabilityScopedRuntimePort<
  TPort extends object,
  TPrefix extends string,
  TCapabilities extends string,
> = {
  [TMemberName in keyof TPort]: TPort[TMemberName] extends (...args: never[]) => unknown
    ? CapabilityScopedMethod<
        TPort[TMemberName],
        `${TPrefix}.${Extract<TMemberName, string>}`,
        TCapabilities
      >
    : TPort[TMemberName] extends object
      ? CapabilityScopedRuntimePort<
          TPort[TMemberName],
          `${TPrefix}.${Extract<TMemberName, string>}`,
          TCapabilities
        >
      : TPort[TMemberName];
};

type CapabilityScopedToolRuntimeExtensions<TCapabilities extends string> = {
  [TMethodName in keyof BrewvaToolRuntimeToolsExtension]: CapabilityScopedMethod<
    BrewvaToolRuntimeToolsExtension[TMethodName],
    `extensions.tools.${Extract<TMethodName, string>}`,
    TCapabilities
  >;
};

export type CapabilityScopedBrewvaToolRuntime<
  TRuntime extends BrewvaToolRuntime | undefined,
  TCapabilities extends string,
> = TRuntime extends undefined
  ? undefined
  : Omit<TRuntime, "authority" | "inspect" | "extensions"> & {
      authority: CapabilityScopedRuntimePort<
        RuntimeToolRuntimePort["authority"],
        "authority",
        TCapabilities
      >;
      inspect: CapabilityScopedRuntimePort<
        RuntimeToolRuntimePort["inspect"],
        "inspect",
        TCapabilities
      >;
      extensions?: {
        tools?: CapabilityScopedToolRuntimeExtensions<TCapabilities>;
      };
    };

export type BrewvaBundledToolRuntime = BrewvaToolRuntime & {
  boxPlane?: BoxPlane;
};

export interface BrewvaToolOptions<TRuntime extends BrewvaToolRuntime = BrewvaToolRuntime> {
  runtime: TRuntime;
  verification?: {
    executeCommands?: boolean;
    timeoutMs?: number;
  };
}

export interface BrewvaBundledToolOptions extends BrewvaToolOptions {
  runtime: BrewvaBundledToolRuntime;
}
