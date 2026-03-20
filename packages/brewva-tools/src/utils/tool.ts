import {
  getExactToolGovernanceDescriptor,
  type ToolGovernanceDescriptor,
  normalizeToolName,
} from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import { getBrewvaToolSurface } from "../surface.js";
import type { BrewvaManagedToolDefinition, BrewvaToolMetadata } from "../types.js";
import {
  applyTopLevelCaseAliases,
  lowerStringEnumContractParameters,
  projectCanonicalTopLevelParameters,
} from "./input-alias.js";

export function defineTool<TParams extends TSchema, TDetails = unknown>(
  tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition {
  return tool as unknown as ToolDefinition;
}

function cloneGovernanceDescriptor(input: ToolGovernanceDescriptor): ToolGovernanceDescriptor {
  return {
    effects: [...new Set(input.effects)],
    defaultRisk: input.defaultRisk,
    boundary: input.boundary,
  };
}

function resolveCanonicalBrewvaToolMetadata(
  toolName: string,
  metadata: Partial<BrewvaToolMetadata> = {},
): BrewvaToolMetadata | undefined {
  const normalizedName = normalizeToolName(toolName);
  if (!normalizedName) {
    return undefined;
  }
  const surface = metadata.surface ?? getBrewvaToolSurface(normalizedName);
  if (!surface) {
    return undefined;
  }
  const governance = metadata.governance ?? getExactToolGovernanceDescriptor(normalizedName);
  if (!governance) {
    return undefined;
  }
  return {
    surface,
    governance: cloneGovernanceDescriptor(governance),
  };
}

export function defineBrewvaTool<TParams extends TSchema, TDetails = unknown>(
  tool: ToolDefinition<TParams, TDetails>,
  metadata: Partial<BrewvaToolMetadata> = {},
): BrewvaManagedToolDefinition {
  const normalizedName = normalizeToolName(tool.name);
  const canonicalMetadata = resolveCanonicalBrewvaToolMetadata(normalizedName, metadata);
  if (!canonicalMetadata?.surface) {
    throw new Error(`managed Brewva tool '${normalizedName}' is missing surface metadata`);
  }
  if (!canonicalMetadata.governance) {
    throw new Error(`managed Brewva tool '${normalizedName}' is missing governance metadata`);
  }

  const aliasedParameters = applyTopLevelCaseAliases(tool.parameters);
  const agentParameters = projectCanonicalTopLevelParameters(tool.parameters);
  const execute: ToolDefinition<TParams, TDetails>["execute"] = async (
    toolCallId,
    params,
    signal,
    onUpdate,
    ctx,
  ) => {
    const normalizedParams = aliasedParameters.normalize(params);
    const loweredParams = lowerStringEnumContractParameters(agentParameters, normalizedParams);
    return await tool.execute(
      toolCallId,
      loweredParams as Parameters<typeof tool.execute>[1],
      signal,
      onUpdate,
      ctx,
    );
  };
  const managed = {
    ...(tool as unknown as Record<string, unknown>),
    parameters: agentParameters,
    execute,
  } as unknown as BrewvaManagedToolDefinition;
  Object.defineProperty(managed, "brewva", {
    enumerable: true,
    configurable: false,
    get() {
      return resolveCanonicalBrewvaToolMetadata(normalizedName, metadata) ?? canonicalMetadata;
    },
  });
  Object.defineProperty(managed, "brewvaAgentParameters", {
    enumerable: false,
    configurable: false,
    writable: false,
    value: agentParameters,
  });
  return managed;
}

export function getBrewvaToolMetadata(
  tool: ToolDefinition | BrewvaManagedToolDefinition | undefined,
): BrewvaToolMetadata | undefined {
  const metadata = (tool as BrewvaManagedToolDefinition | undefined)?.brewva;
  if (metadata) {
    return {
      surface: metadata.surface,
      governance: cloneGovernanceDescriptor(metadata.governance),
    };
  }
  return resolveCanonicalBrewvaToolMetadata(tool?.name ?? "");
}

export function getBrewvaAgentParameters(
  tool: ToolDefinition | BrewvaManagedToolDefinition | undefined,
): TSchema | undefined {
  const parameters = (tool as BrewvaManagedToolDefinition | undefined)?.brewvaAgentParameters;
  return parameters ?? tool?.parameters;
}
