import { normalizeToolName } from "@brewva/brewva-runtime/core";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import type { TSchema } from "@sinclair/typebox";
import type {
  CapabilityScopedBrewvaToolRuntime,
  BrewvaManagedToolDefinition,
  BrewvaToolMetadata,
  BrewvaToolRuntime,
} from "../contracts/index.js";
import { createCapabilityScopedToolRuntime } from "./capability-scope.js";
import type {
  DeclaredBrewvaToolRequiredCapabilities,
  ManagedBrewvaToolName,
} from "./required-capabilities.js";
import { defineBrewvaTool } from "./tool.js";

type ManagedToolAuthoringDefinition<TParams extends TSchema, TOutput, TError> = Omit<
  ToolDefinition<TParams, TOutput, TError>,
  "outputSchema" | "errorSchema" | "outcomeVersion"
> &
  Partial<
    Pick<
      ToolDefinition<TParams, TOutput, TError>,
      "outputSchema" | "errorSchema" | "outcomeVersion"
    >
  >;

export interface ManagedBrewvaToolFactory {
  define: <TParams extends TSchema, TOutput = unknown, TError = unknown>(
    tool: ManagedToolAuthoringDefinition<TParams, TOutput, TError>,
    metadata?: Partial<BrewvaToolMetadata>,
  ) => BrewvaManagedToolDefinition;
}

export interface RuntimeBoundBrewvaToolFactory<TRuntime extends BrewvaToolRuntime | undefined> {
  runtime: TRuntime;
  define: <TParams extends TSchema, TOutput = unknown, TError = unknown>(
    tool: ManagedToolAuthoringDefinition<TParams, TOutput, TError>,
    metadata?: Partial<BrewvaToolMetadata>,
  ) => BrewvaManagedToolDefinition;
}

export function createManagedBrewvaToolFactory(toolName: string): ManagedBrewvaToolFactory {
  const normalizedToolName = normalizeToolName(toolName);

  return {
    define: <TParams extends TSchema, TOutput = unknown, TError = unknown>(
      tool: ManagedToolAuthoringDefinition<TParams, TOutput, TError>,
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
