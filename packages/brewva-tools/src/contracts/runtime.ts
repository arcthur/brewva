import type { BoxPlane } from "@brewva/brewva-box";
import type { BrewvaToolRuntimePort as RuntimeToolRuntimePort } from "@brewva/brewva-runtime";
import type { BrewvaToolDelegationQuery, BrewvaToolOrchestration } from "./delegation.js";
import type { BrewvaToolRuntimeExtensions, BrewvaToolRuntimeToolsExtension } from "./metadata.js";

type BrewvaToolRuntimeBase = Pick<
  RuntimeToolRuntimePort,
  "cwd" | "workspaceRoot" | "agentId" | "config" | "authority" | "inspect"
> & {
  readonly maintain?: RuntimeToolRuntimePort["maintain"];
};

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
  TPrefix extends "authority" | "inspect" | "maintain",
  TGroupName extends string,
  TCapabilities extends string,
> = {
  [TMethodName in keyof TPort]: CapabilityScopedMethod<
    TPort[TMethodName],
    `${TPrefix}.${TGroupName}.${Extract<TMethodName, string>}`,
    TCapabilities
  >;
};

type CapabilityScopedRuntimeGroup<
  TGroupMap extends object,
  TPrefix extends "authority" | "inspect" | "maintain",
  TCapabilities extends string,
> = {
  [TGroupName in keyof TGroupMap]: TGroupMap[TGroupName] extends object
    ? CapabilityScopedRuntimePort<
        TGroupMap[TGroupName],
        TPrefix,
        Extract<TGroupName, string>,
        TCapabilities
      >
    : TGroupMap[TGroupName];
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
  : Omit<TRuntime, "authority" | "inspect" | "maintain" | "extensions"> & {
      authority: CapabilityScopedRuntimeGroup<
        RuntimeToolRuntimePort["authority"],
        "authority",
        TCapabilities
      >;
      inspect: CapabilityScopedRuntimeGroup<
        RuntimeToolRuntimePort["inspect"],
        "inspect",
        TCapabilities
      >;
      maintain?: CapabilityScopedRuntimeGroup<
        RuntimeToolRuntimePort["maintain"],
        "maintain",
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
