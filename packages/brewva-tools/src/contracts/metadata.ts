import type { ToolActionClass } from "@brewva/brewva-runtime/protocol";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import type {
  ToolDescriptor as CanonicalToolDescriptor,
  ToolExecutionTraitResolverInput as CanonicalToolExecutionTraitResolverInput,
  ToolExecutionTraits as CanonicalToolExecutionTraits,
} from "@brewva/brewva-substrate/tools";
import type { TSchema } from "@sinclair/typebox";
import type { BrewvaToolRequiredCapability } from "./runtime-capabilities.js";
import type { BrewvaToolSurface } from "./surface.js";

export type BrewvaToolInterruptBehavior = "cancel" | "block" | "allow_completion";

export interface BrewvaToolRuntimeExtensionMethods {
  onClearState(listener: (sessionId: string) => void): void;
  resolveCredentialBindings(sessionId: string, toolName: string): Record<string, string>;
}

type StringKeyOf<T> = Extract<keyof T, string>;

type ToolExtensionCapabilityPath = {
  [TMethodName in StringKeyOf<BrewvaToolRuntimeExtensionMethods>]: BrewvaToolRuntimeExtensionMethods[TMethodName] extends (
    ...args: never[]
  ) => unknown
    ? `extensions.tools.${TMethodName}`
    : never;
}[StringKeyOf<BrewvaToolRuntimeExtensionMethods>];

type MissingExtensionCapabilityPath = Exclude<
  ToolExtensionCapabilityPath,
  BrewvaToolRequiredCapability
>;

type AssertNoMissingCapability<T extends never> = T;
type _ToolExtensionCapabilityInventoryCheck =
  AssertNoMissingCapability<MissingExtensionCapabilityPath>;

export type { BrewvaToolRequiredCapability };

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
