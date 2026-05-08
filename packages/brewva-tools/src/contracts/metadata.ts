import type {
  BrewvaToolRuntimeExtensionMethods,
  BrewvaToolRuntimePort as RuntimeToolRuntimePort,
  ToolActionClass,
} from "@brewva/brewva-runtime";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import type {
  ToolDescriptor as CanonicalToolDescriptor,
  ToolExecutionTraitResolverInput as CanonicalToolExecutionTraitResolverInput,
  ToolExecutionTraits as CanonicalToolExecutionTraits,
} from "@brewva/brewva-tool-protocol";
import type { TSchema } from "@sinclair/typebox";
import type { BrewvaToolSurface } from "./surface.js";

export type BrewvaToolInterruptBehavior = "cancel" | "block" | "allow_completion";

type RuntimeMethodCapabilityPath<
  TGroupMap extends object,
  TPrefix extends "authority" | "inspect" | "maintain",
> = {
  [TGroupName in keyof TGroupMap & string]: TGroupMap[TGroupName] extends object
    ? {
        [TMethodName in keyof TGroupMap[TGroupName] &
          string]: TGroupMap[TGroupName][TMethodName] extends (...args: never[]) => unknown
          ? `${TPrefix}.${TGroupName}.${TMethodName}`
          : never;
      }[keyof TGroupMap[TGroupName] & string]
    : never;
}[keyof TGroupMap & string];

type StringKeyOf<T> = Extract<keyof T, string>;

type ToolExtensionCapabilityPath = {
  [TMethodName in StringKeyOf<BrewvaToolRuntimeExtensionMethods>]: BrewvaToolRuntimeExtensionMethods[TMethodName] extends (
    ...args: never[]
  ) => unknown
    ? `extensions.tools.${TMethodName}`
    : never;
}[StringKeyOf<BrewvaToolRuntimeExtensionMethods>];

export type BrewvaToolRequiredCapability =
  | RuntimeMethodCapabilityPath<RuntimeToolRuntimePort["authority"], "authority">
  | RuntimeMethodCapabilityPath<RuntimeToolRuntimePort["inspect"], "inspect">
  | RuntimeMethodCapabilityPath<RuntimeToolRuntimePort["maintain"], "maintain">
  | ToolExtensionCapabilityPath;

export interface BrewvaToolExecutionTraits extends CanonicalToolExecutionTraits {
  concurrencySafe: boolean;
  interruptBehavior: BrewvaToolInterruptBehavior;
  streamingEligible: boolean;
  contextModifying: boolean;
}

export interface BrewvaToolExecutionTraitResolverInput extends Omit<
  CanonicalToolExecutionTraitResolverInput,
  "cwd"
> {
  toolName: string;
  args: unknown;
  cwd?: string | null;
}

export type BrewvaToolExecutionTraitsResolver = (
  input: BrewvaToolExecutionTraitResolverInput,
) => BrewvaToolExecutionTraits | Partial<BrewvaToolExecutionTraits> | undefined;

export type BrewvaToolExecutionTraitsDefinition =
  | BrewvaToolExecutionTraits
  | BrewvaToolExecutionTraitsResolver;

export type BrewvaToolDescriptor<TParameters extends TSchema = TSchema> = Omit<
  CanonicalToolDescriptor<TParameters>,
  "surface" | "actionClass" | "executionTraits" | "requiredCapabilities"
> & {
  surface?: BrewvaToolSurface;
  actionClass?: ToolActionClass;
  executionTraits?: BrewvaToolExecutionTraits;
  requiredCapabilities?: readonly BrewvaToolRequiredCapability[];
};

export interface BrewvaToolMetadata {
  surface: BrewvaToolSurface;
  actionClass: ToolActionClass;
  executionTraits?: BrewvaToolExecutionTraitsDefinition;
  requiredCapabilities?: readonly BrewvaToolRequiredCapability[];
}

export type BrewvaToolRuntimeToolsExtension = Partial<Readonly<BrewvaToolRuntimeExtensionMethods>>;

export interface BrewvaToolRuntimeExtensions {
  readonly tools?: BrewvaToolRuntimeToolsExtension;
}

export interface BrewvaToolMetadataCarrier {
  name: string;
  parameters?: TSchema;
  brewva?: BrewvaToolMetadata;
  brewvaExecutionTraits?: BrewvaToolExecutionTraitsDefinition;
  brewvaAgentParameters?: TSchema;
  brewvaDescriptor?: BrewvaToolDescriptor;
}

export type BrewvaManagedToolDefinition = ToolDefinition & {
  brewva?: BrewvaToolMetadata;
  brewvaExecutionTraits?: BrewvaToolExecutionTraitsDefinition;
  brewvaAgentParameters?: TSchema;
  brewvaDescriptor?: BrewvaToolDescriptor;
};
