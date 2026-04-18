import {
  getExactToolGovernanceDescriptor,
  type ToolGovernanceDescriptor,
  normalizeToolName,
} from "@brewva/brewva-runtime";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate";
import type { TSchema } from "@sinclair/typebox";
import { getExactBrewvaToolRequiredCapabilities } from "../required-capabilities.js";
import { getBrewvaToolSurface } from "../surface.js";
import type {
  BrewvaManagedToolDefinition,
  BrewvaToolMetadataCarrier,
  BrewvaToolExecutionTraitResolverInput,
  BrewvaToolExecutionTraits,
  BrewvaToolExecutionTraitsDefinition,
  BrewvaToolMetadata,
  BrewvaToolRequiredCapability,
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
    requiredRoutingScopes: input.requiredRoutingScopes
      ? [...new Set(input.requiredRoutingScopes)]
      : undefined,
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

function cloneRequiredCapabilities(
  input: readonly BrewvaToolRequiredCapability[] | undefined,
): BrewvaToolRequiredCapability[] | undefined {
  if (!input || input.length === 0) {
    return undefined;
  }
  return [...new Set(input)].toSorted();
}

function describeRequiredCapabilities(
  input: readonly BrewvaToolRequiredCapability[] | undefined,
): string {
  return input && input.length > 0 ? [...input].join(", ") : "(none)";
}

function sameRequiredCapabilities(
  left: readonly BrewvaToolRequiredCapability[] | undefined,
  right: readonly BrewvaToolRequiredCapability[] | undefined,
): boolean {
  const normalizedLeft = cloneRequiredCapabilities(left) ?? [];
  const normalizedRight = cloneRequiredCapabilities(right) ?? [];
  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
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
    requiredCapabilities: cloneRequiredCapabilities(
      metadata.requiredCapabilities ?? getExactBrewvaToolRequiredCapabilities(normalizedName),
    ),
  };
}

function defineExecutionTraitsProperty(
  target: object,
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

function copyToolMetadataProperties(source: object, target: object): void {
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
  tool: BrewvaToolMetadataCarrier | undefined,
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
      requiredCapabilities: cloneRequiredCapabilities(metadata.requiredCapabilities),
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

export function validateBrewvaToolRequiredCapabilities(
  tool: BrewvaToolMetadataCarrier | undefined,
): void {
  const managedTool = tool as BrewvaManagedToolDefinition | undefined;
  const normalizedName = normalizeToolName(managedTool?.name ?? "");
  if (!normalizedName) {
    return;
  }
  const declared = cloneRequiredCapabilities(managedTool?.brewva?.requiredCapabilities);
  const expected = cloneRequiredCapabilities(
    getExactBrewvaToolRequiredCapabilities(normalizedName),
  );
  if (!expected && !declared) {
    return;
  }
  if (!expected) {
    throw new Error(
      `managed Brewva tool '${normalizedName}' declares required capabilities without a repo-owned registry entry: ${describeRequiredCapabilities(
        declared,
      )}`,
    );
  }
  if (!sameRequiredCapabilities(declared, expected)) {
    throw new Error(
      `managed Brewva tool '${normalizedName}' required capabilities must match the repo-owned registry. Expected ${describeRequiredCapabilities(
        expected,
      )}; received ${describeRequiredCapabilities(declared)}.`,
    );
  }
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
  tool: BrewvaToolMetadataCarrier | undefined,
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
  tool: BrewvaToolMetadataCarrier | undefined,
): TSchema | undefined {
  const parameters = (tool as BrewvaManagedToolDefinition | undefined)?.brewvaAgentParameters;
  return parameters ?? tool?.parameters;
}
