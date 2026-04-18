import { normalizeToolName } from "@brewva/brewva-runtime";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate";
import type { TSchema } from "@sinclair/typebox";
import type {
  DeclaredBrewvaToolRequiredCapabilities,
  ManagedBrewvaToolName,
} from "../required-capabilities.js";
import { createCapabilityScopedToolRuntime } from "../runtime-capability-scope.js";
import type {
  CapabilityScopedBrewvaToolRuntime,
  BrewvaManagedToolDefinition,
  BrewvaToolMetadata,
  BrewvaToolRuntime,
} from "../types.js";
import { defineBrewvaTool } from "./tool.js";

export interface ManagedBrewvaToolFactory {
  define: <TParams extends TSchema, TDetails = unknown>(
    tool: ToolDefinition<TParams, TDetails>,
    metadata?: Partial<BrewvaToolMetadata>,
  ) => BrewvaManagedToolDefinition;
}

export interface RuntimeBoundBrewvaToolFactory<TRuntime extends BrewvaToolRuntime | undefined> {
  runtime: TRuntime;
  define: <TParams extends TSchema, TDetails = unknown>(
    tool: ToolDefinition<TParams, TDetails>,
    metadata?: Partial<BrewvaToolMetadata>,
  ) => BrewvaManagedToolDefinition;
}

export function createManagedBrewvaToolFactory(toolName: string): ManagedBrewvaToolFactory {
  const normalizedToolName = normalizeToolName(toolName);

  return {
    define: <TParams extends TSchema, TDetails = unknown>(
      tool: ToolDefinition<TParams, TDetails>,
      metadata: Partial<BrewvaToolMetadata> = {},
    ): BrewvaManagedToolDefinition => {
      const normalizedDefinitionName = normalizeToolName(tool.name);
      if (normalizedDefinitionName !== normalizedToolName) {
        throw new Error(
          `managed Brewva tool definition mismatch: expected '${normalizedToolName}', received '${normalizedDefinitionName}'.`,
        );
      }
      return defineBrewvaTool(tool, metadata);
    },
  };
}

export function createRuntimeBoundBrewvaToolFactory<
  TToolName extends ManagedBrewvaToolName,
  TRuntime extends BrewvaToolRuntime | undefined,
>(
  runtime: TRuntime,
  toolName: TToolName,
): RuntimeBoundBrewvaToolFactory<
  CapabilityScopedBrewvaToolRuntime<TRuntime, DeclaredBrewvaToolRequiredCapabilities<TToolName>>
> {
  const factory = createManagedBrewvaToolFactory(toolName);
  const normalizedToolName = normalizeToolName(toolName);
  const scopedRuntime = (runtime
    ? createCapabilityScopedToolRuntime(runtime, normalizedToolName)
    : runtime) as unknown as CapabilityScopedBrewvaToolRuntime<
    TRuntime,
    DeclaredBrewvaToolRequiredCapabilities<TToolName>
  >;

  return {
    runtime: scopedRuntime,
    define: factory.define,
  };
}
