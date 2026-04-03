import {
  getExactToolGovernanceDescriptor,
  type ToolGovernanceDescriptor,
  normalizeToolName,
} from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import { getBrewvaToolSurface } from "../surface.js";
import type {
  BrewvaManagedToolDefinition,
  BrewvaToolExecutionTraitResolverInput,
  BrewvaToolExecutionTraits,
  BrewvaToolExecutionTraitsDefinition,
  BrewvaToolMetadata,
} from "../types.js";
import { lowerStringEnumContractParameters } from "./input-alias.js";

const DEFAULT_BREWVA_TOOL_EXECUTION_TRAITS: BrewvaToolExecutionTraits = {
  concurrencySafe: false,
  interruptBehavior: "block",
  streamingEligible: false,
  contextModifying: false,
};

export function defineTool<TParams extends TSchema, TDetails = unknown>(
  tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
  return tool;
}

function cloneGovernanceDescriptor(input: ToolGovernanceDescriptor): ToolGovernanceDescriptor {
  return {
    effects: [...new Set(input.effects)],
    defaultRisk: input.defaultRisk,
    boundary: input.boundary,
    rollbackable: input.rollbackable,
  };
}

function cloneExecutionTraits(input: BrewvaToolExecutionTraits): BrewvaToolExecutionTraits {
  return {
    concurrencySafe: input.concurrencySafe,
    interruptBehavior: input.interruptBehavior,
    streamingEligible: input.streamingEligible,
    contextModifying: input.contextModifying,
  };
}

function cloneExecutionTraitsDefinition(
  input: BrewvaToolExecutionTraitsDefinition | undefined,
): BrewvaToolExecutionTraitsDefinition | undefined {
  if (!input) {
    return undefined;
  }
  if (typeof input === "function") {
    return input;
  }
  return cloneExecutionTraits(input);
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

function defineExecutionTraitsProperty<T extends object>(
  target: T,
  definition: BrewvaToolExecutionTraitsDefinition | undefined,
): void {
  if (!definition) {
    return;
  }
  Object.defineProperty(target, "brewvaExecutionTraits", {
    enumerable: false,
    configurable: false,
    get() {
      return cloneExecutionTraitsDefinition(definition);
    },
  });
}

function copyToolMetadataProperties<TSource extends object, TTarget extends object>(
  source: TSource,
  target: TTarget,
): void {
  for (const propertyName of [
    "brewva",
    "brewvaExecutionTraits",
    "brewvaAgentParameters",
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(source, propertyName);
    if (descriptor) {
      Object.defineProperty(target, propertyName, descriptor);
    }
  }
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

  const execute: ToolDefinition<TParams, TDetails>["execute"] = async (
    toolCallId,
    params,
    signal,
    onUpdate,
    ctx,
  ) => {
    const loweredParams = lowerStringEnumContractParameters(tool.parameters, params);
    return await tool.execute(toolCallId, loweredParams, signal, onUpdate, ctx);
  };
  const managed = {
    ...tool,
    parameters: tool.parameters,
    execute,
  } as BrewvaManagedToolDefinition;
  Object.defineProperty(managed, "brewva", {
    enumerable: true,
    configurable: false,
    get() {
      return {
        ...(resolveCanonicalBrewvaToolMetadata(normalizedName, metadata) ?? canonicalMetadata),
        executionTraits: cloneExecutionTraitsDefinition(metadata.executionTraits),
      };
    },
  });
  defineExecutionTraitsProperty(managed, metadata.executionTraits);
  Object.defineProperty(managed, "brewvaAgentParameters", {
    enumerable: false,
    configurable: false,
    writable: false,
    value: tool.parameters,
  });
  return managed;
}

export function attachBrewvaToolExecutionTraits<T extends ToolDefinition>(
  tool: T,
  definition: BrewvaToolExecutionTraitsDefinition,
): T {
  const attached = {
    ...tool,
  } satisfies T;
  copyToolMetadataProperties(tool, attached);
  defineExecutionTraitsProperty(attached, definition);
  return attached;
}

export function getBrewvaToolMetadata(
  tool: ToolDefinition | BrewvaManagedToolDefinition | undefined,
): BrewvaToolMetadata | undefined {
  const managedTool = tool as BrewvaManagedToolDefinition | undefined;
  const metadata = managedTool?.brewva;
  const attachedExecutionTraits = cloneExecutionTraitsDefinition(
    managedTool?.brewvaExecutionTraits,
  );
  if (metadata) {
    return {
      surface: metadata.surface,
      governance: cloneGovernanceDescriptor(metadata.governance),
      executionTraits:
        attachedExecutionTraits ?? cloneExecutionTraitsDefinition(metadata.executionTraits),
    };
  }
  const canonicalMetadata = resolveCanonicalBrewvaToolMetadata(tool?.name ?? "");
  if (!canonicalMetadata) {
    return undefined;
  }
  return {
    ...canonicalMetadata,
    executionTraits: attachedExecutionTraits,
  };
}

function resolveExecutionTraitsFromDefinition(
  definition: BrewvaToolExecutionTraitsDefinition | undefined,
  input: BrewvaToolExecutionTraitResolverInput,
): BrewvaToolExecutionTraits {
  if (!definition) {
    return { ...DEFAULT_BREWVA_TOOL_EXECUTION_TRAITS };
  }
  if (typeof definition === "function") {
    const resolved = definition(input);
    return {
      ...DEFAULT_BREWVA_TOOL_EXECUTION_TRAITS,
      ...resolved,
    };
  }
  return {
    ...DEFAULT_BREWVA_TOOL_EXECUTION_TRAITS,
    ...definition,
  };
}

export function resolveBrewvaToolExecutionTraits(
  tool: ToolDefinition | BrewvaManagedToolDefinition | undefined,
  input: Partial<Omit<BrewvaToolExecutionTraitResolverInput, "toolName">> & {
    toolName?: string;
  } = {},
): BrewvaToolExecutionTraits {
  const managedTool = tool as BrewvaManagedToolDefinition | undefined;
  const metadata = getBrewvaToolMetadata(tool);
  const toolName = normalizeToolName(input.toolName ?? tool?.name ?? "");
  return resolveExecutionTraitsFromDefinition(
    managedTool?.brewvaExecutionTraits ?? metadata?.executionTraits,
    {
      toolName,
      args: input.args,
      cwd: input.cwd,
    },
  );
}

export function getBrewvaAgentParameters(
  tool: ToolDefinition | BrewvaManagedToolDefinition | undefined,
): TSchema | undefined {
  const parameters = (tool as BrewvaManagedToolDefinition | undefined)?.brewvaAgentParameters;
  return parameters ?? tool?.parameters;
}
