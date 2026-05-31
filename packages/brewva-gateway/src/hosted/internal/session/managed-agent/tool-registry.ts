import type { BrewvaAgentProtocolTool } from "@brewva/brewva-substrate/agent-protocol";
import type { BrewvaHostToolInfo } from "@brewva/brewva-substrate/host-api";
import {
  buildBrewvaSystemPromptDocument,
  renderBrewvaSystemPromptText,
} from "@brewva/brewva-substrate/prompt";
import type { BrewvaHostedResourceLoader } from "@brewva/brewva-substrate/resources";
import type { BrewvaToolContext, BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import { outcomeIsError } from "@brewva/brewva-vocabulary/outcome";
import type { ToolSchemaSnapshot, ToolSchemaSnapshotTool } from "../../provider/cache/index.js";

function toAgentTool(
  tool: BrewvaToolDefinition,
  ctxFactory: () => BrewvaToolContext,
  schemaOverride?: ToolSchemaSnapshotTool,
): BrewvaAgentProtocolTool {
  return {
    name: tool.name,
    label: tool.label,
    description: schemaOverride?.description ?? tool.description,
    parameters: (schemaOverride?.parameters ??
      tool.parameters) as BrewvaAgentProtocolTool["parameters"],
    prepareArguments: tool.prepareArguments,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const result = await tool.execute(
        toolCallId,
        params,
        signal,
        onUpdate ? (update) => onUpdate(update as never) : undefined,
        ctxFactory(),
      );
      const details =
        result.outcome.kind === "err"
          ? result.outcome.error
          : result.outcome.kind === "ok"
            ? result.outcome.value
            : result.outcome.value;
      return {
        content: result.content,
        details,
        isError: outcomeIsError(result.outcome),
      };
    },
  };
}

function normalizePromptSnippet(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const normalized = text
    .replace(/[\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
  if (!guidelines || guidelines.length === 0) {
    return [];
  }
  return [...new Set(guidelines.map((line) => line.trim()).filter((line) => line.length > 0))];
}

function stringArraysMatch(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export interface ManagedSessionToolRegistryOptions {
  resolveSchemaSnapshot: (
    tools: readonly BrewvaToolDefinition[],
    invalidationReason: string,
  ) => ToolSchemaSnapshot;
}

export class ManagedSessionToolRegistry {
  readonly #registeredTools: BrewvaToolDefinition[] = [];
  readonly #toolDefinitions = new Map<string, BrewvaToolDefinition>();
  readonly #toolPromptSnippets = new Map<string, string>();
  readonly #toolPromptGuidelines = new Map<string, string[]>();
  readonly #resolveSchemaSnapshot: ManagedSessionToolRegistryOptions["resolveSchemaSnapshot"];

  constructor(options: ManagedSessionToolRegistryOptions) {
    this.#resolveSchemaSnapshot = options.resolveSchemaSnapshot;
  }

  replaceAll(tools: readonly BrewvaToolDefinition[]): void {
    this.#registeredTools.length = 0;
    this.#registeredTools.push(...tools);
    this.#toolDefinitions.clear();
    this.#toolPromptSnippets.clear();
    this.#toolPromptGuidelines.clear();
    for (const tool of tools) {
      this.upsertIndexed(tool);
    }
  }

  upsert(tool: BrewvaToolDefinition): void {
    const existingIndex = this.#registeredTools.findIndex(
      (candidate) => candidate.name === tool.name,
    );
    if (existingIndex >= 0) {
      this.#registeredTools[existingIndex] = tool;
    } else {
      this.#registeredTools.push(tool);
    }
    this.upsertIndexed(tool);
  }

  listRegisteredTools(): readonly BrewvaToolDefinition[] {
    return [...this.#registeredTools];
  }

  listInfo(): BrewvaHostToolInfo[] {
    return [...this.#toolDefinitions.values()].map((tool) => {
      const info: BrewvaHostToolInfo = {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      };
      if (tool.sourceInfo !== undefined) {
        info.sourceInfo = tool.sourceInfo;
      }
      return info;
    });
  }

  resolveDefinitions(toolNames: readonly string[]): BrewvaToolDefinition[] {
    return toolNames
      .map((toolName) => this.#toolDefinitions.get(toolName))
      .filter((tool): tool is BrewvaToolDefinition => tool !== undefined);
  }

  buildSchemaSnapshot(
    definitions: readonly BrewvaToolDefinition[],
    invalidationReason: string,
  ): ToolSchemaSnapshot {
    return this.#resolveSchemaSnapshot(definitions, invalidationReason);
  }

  buildAgentTools(
    definitions: readonly BrewvaToolDefinition[],
    snapshot: ToolSchemaSnapshot,
    ctxFactory: () => BrewvaToolContext,
  ): BrewvaAgentProtocolTool[] {
    const schemasByName = new Map(snapshot.tools.map((tool) => [tool.name, tool]));
    return definitions.map((tool) => toAgentTool(tool, ctxFactory, schemasByName.get(tool.name)));
  }

  buildPromptInputs(activeToolNames: readonly string[]): {
    selectedTools: string[];
    toolSnippets: Record<string, string>;
    promptGuidelines: string[];
  } {
    const selectedTools = [...activeToolNames];
    const toolSnippets: Record<string, string> = {};
    const promptGuidelines: string[] = [];
    for (const toolName of selectedTools) {
      const snippet = this.#toolPromptSnippets.get(toolName);
      if (snippet) {
        toolSnippets[toolName] = snippet;
      }
      const guidelines = this.#toolPromptGuidelines.get(toolName);
      if (guidelines) {
        promptGuidelines.push(...guidelines);
      }
    }
    return { selectedTools, toolSnippets, promptGuidelines };
  }

  private upsertIndexed(tool: BrewvaToolDefinition): void {
    this.#toolDefinitions.set(tool.name, tool);
    const promptSnippet = normalizePromptSnippet(tool.promptSnippet);
    if (promptSnippet) {
      this.#toolPromptSnippets.set(tool.name, promptSnippet);
    } else {
      this.#toolPromptSnippets.delete(tool.name);
    }
    const guidelines = normalizePromptGuidelines(tool.promptGuidelines);
    if (guidelines.length > 0) {
      this.#toolPromptGuidelines.set(tool.name, guidelines);
    } else {
      this.#toolPromptGuidelines.delete(tool.name);
    }
  }
}

export function buildManagedSessionBaseSystemPrompt(input: {
  cwd: string;
  resourceLoader: BrewvaHostedResourceLoader;
  activeToolNames: readonly string[];
  toolPromptInputs: {
    selectedTools: string[];
    toolSnippets: Record<string, string>;
    promptGuidelines: string[];
  };
}): string {
  if (!stringArraysMatch(input.activeToolNames, input.toolPromptInputs.selectedTools)) {
    throw new Error("active tool prompt inputs must match active tool names");
  }
  const document = buildBrewvaSystemPromptDocument({
    cwd: input.cwd,
    selectedTools: [...input.activeToolNames],
    toolSnippets: input.toolPromptInputs.toolSnippets,
    promptGuidelines: input.toolPromptInputs.promptGuidelines,
    customInstructions: input.resourceLoader.getCustomInstructions(),
    appendInstructions: input.resourceLoader.getAppendInstructions().join("\n\n"),
    projectInstructions: input.resourceLoader.getProjectInstructions().files,
  });
  return renderBrewvaSystemPromptText(document);
}
