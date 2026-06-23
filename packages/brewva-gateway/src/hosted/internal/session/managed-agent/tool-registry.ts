import type { BrewvaAgentProtocolTool } from "@brewva/brewva-substrate/agent-protocol";
import type { BrewvaHostToolInfo } from "@brewva/brewva-substrate/host-api";
import {
  buildBrewvaSystemPromptDocument,
  renderBrewvaSystemPromptText,
  type WorktreeInfo,
} from "@brewva/brewva-substrate/prompt";
import type { BrewvaHostedResourceLoader } from "@brewva/brewva-substrate/resources";
import type { BrewvaToolContext, BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import { outcomeIsError } from "@brewva/brewva-vocabulary/outcome";
import type { ToolSchemaSnapshot, ToolSchemaSnapshotTool } from "../../provider/cache/index.js";
import { collectGitWorktrees } from "./git-worktrees.js";

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
  cwd: string;
  resourceLoader: BrewvaHostedResourceLoader;
  resolveSchemaSnapshot: (
    tools: readonly BrewvaToolDefinition[],
    invalidationReason: string,
  ) => ToolSchemaSnapshot;
}

export interface ManagedSessionToolApplicationDeps {
  createToolContext: () => BrewvaToolContext;
  getActiveToolNames: () => string[];
  applyBaseContext: (input: { systemPrompt: string; tools: BrewvaAgentProtocolTool[] }) => void;
  applyBaseSystemPrompt: (systemPrompt: string) => void;
}

export class ManagedSessionToolRegistry {
  readonly #registeredTools: BrewvaToolDefinition[] = [];
  readonly #toolDefinitions = new Map<string, BrewvaToolDefinition>();
  readonly #toolPromptSnippets = new Map<string, string>();
  readonly #toolPromptGuidelines = new Map<string, string[]>();
  readonly #cwd: string;
  readonly #worktrees: readonly WorktreeInfo[];
  readonly #resourceLoader: BrewvaHostedResourceLoader;
  readonly #resolveSchemaSnapshot: ManagedSessionToolRegistryOptions["resolveSchemaSnapshot"];
  #baseSystemPrompt = "";

  constructor(options: ManagedSessionToolRegistryOptions) {
    this.#cwd = options.cwd;
    this.#worktrees = collectGitWorktrees(options.cwd);
    this.#resourceLoader = options.resourceLoader;
    this.#resolveSchemaSnapshot = options.resolveSchemaSnapshot;
  }

  get currentBaseSystemPrompt(): string {
    return this.#baseSystemPrompt;
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

  resolveProviderToolSchemaSnapshot(
    invalidationReason: string,
    activeToolNames: readonly string[],
  ): ToolSchemaSnapshot {
    const activeDefinitions = this.resolveDefinitions(activeToolNames);
    return this.buildSchemaSnapshot(activeDefinitions, invalidationReason);
  }

  refreshTools(deps: ManagedSessionToolApplicationDeps): void {
    // Rebuild the indexed maps from the current registered tools. A defensive
    // copy is required because the registry now owns the single source array;
    // passing the live array to replaceAll would alias it and clear it mid-rebuild.
    this.replaceAll([...this.#registeredTools]);
    this.applyToolSet(this.listRegisteredTools(), "tool_refresh", deps);
  }

  setActiveTools(toolNames: string[], deps: ManagedSessionToolApplicationDeps): void {
    this.applyToolSet(this.resolveDefinitions(toolNames), "active_tool_set_changed", deps);
  }

  registerHostedTool(tool: BrewvaToolDefinition, deps: ManagedSessionToolApplicationDeps): void {
    this.upsert(tool);
    this.#baseSystemPrompt = this.rebuildSystemPrompt(deps.getActiveToolNames());
    deps.applyBaseSystemPrompt(this.#baseSystemPrompt);
  }

  private applyToolSet(
    definitions: readonly BrewvaToolDefinition[],
    invalidationReason: string,
    deps: ManagedSessionToolApplicationDeps,
  ): void {
    const activeToolNames = definitions.map((tool) => tool.name);
    const snapshot = this.buildSchemaSnapshot(definitions, invalidationReason);
    const tools = this.buildAgentTools(definitions, snapshot, () => deps.createToolContext());
    this.#baseSystemPrompt = this.rebuildSystemPrompt(activeToolNames);
    deps.applyBaseContext({
      tools,
      systemPrompt: this.#baseSystemPrompt,
    });
  }

  private rebuildSystemPrompt(activeToolNames: readonly string[]): string {
    return buildManagedSessionBaseSystemPrompt({
      cwd: this.#cwd,
      worktrees: this.#worktrees,
      resourceLoader: this.#resourceLoader,
      activeToolNames,
      toolPromptInputs: this.buildPromptInputs(activeToolNames),
    });
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
  worktrees?: readonly WorktreeInfo[];
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
    worktrees: input.worktrees,
    selectedTools: [...input.activeToolNames],
    toolSnippets: input.toolPromptInputs.toolSnippets,
    promptGuidelines: input.toolPromptInputs.promptGuidelines,
    customInstructions: input.resourceLoader.getCustomInstructions(),
    appendInstructions: input.resourceLoader.getAppendInstructions().join("\n\n"),
    projectInstructions: input.resourceLoader.getProjectInstructions().files,
  });
  return renderBrewvaSystemPromptText(document);
}
