import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseJsonc, type ManagedToolMode } from "@brewva/brewva-runtime";
import { parseMarkdownFrontmatter } from "@brewva/brewva-runtime/internal";
import type {
  AdvisorConsultKind,
  SubagentContextBudget,
  SubagentExecutionBoundary,
  SubagentResultMode,
} from "@brewva/brewva-tools";

export type HostedDelegationBuiltinToolName = "read" | "edit" | "write";
export type HostedWorkspaceSubagentConfigKind = "envelope" | "agentSpec";
export type HostedWorkspaceSubagentConfigSource = "json" | "markdown";
export type HostedContextProfile = "minimal" | "standard" | "full";

export interface HostedWorkspaceSubagentConfigFile {
  fileName: string;
  filePath: string;
  kind: HostedWorkspaceSubagentConfigKind;
  source: HostedWorkspaceSubagentConfigSource;
  parsed: Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value
    .map((item) => asString(item))
    .filter((item): item is string => item !== undefined);
  return entries.length > 0 ? entries : undefined;
}

export function asBuiltinToolArray(value: unknown): HostedDelegationBuiltinToolName[] | undefined {
  const entries = asStringArray(value);
  if (!entries) {
    return undefined;
  }
  const normalized = entries.filter(
    (entry): entry is HostedDelegationBuiltinToolName =>
      entry === "read" || entry === "edit" || entry === "write",
  );
  return normalized.length > 0 ? normalized : undefined;
}

export function asBoundary(value: unknown): SubagentExecutionBoundary | undefined {
  return value === "safe" || value === "effectful" ? value : undefined;
}

export function asManagedToolMode(value: unknown): ManagedToolMode | undefined {
  return value === "runtime_plugin" || value === "direct" ? value : undefined;
}

export function asResultMode(value: unknown): SubagentResultMode | undefined {
  return value === "consult" || value === "qa" || value === "patch" ? value : undefined;
}

export function asConsultKind(value: unknown): AdvisorConsultKind | undefined {
  return value === "investigate" || value === "diagnose" || value === "design" || value === "review"
    ? value
    : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function asContextProfile(value: unknown): HostedContextProfile | undefined {
  return value === "minimal" || value === "standard" || value === "full" ? value : undefined;
}

export function asContextBudget(value: unknown): SubagentContextBudget | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const maxInjectionTokens =
    typeof value.maxInjectionTokens === "number" && Number.isFinite(value.maxInjectionTokens)
      ? Math.max(1, Math.trunc(value.maxInjectionTokens))
      : undefined;
  const maxTurnTokens =
    typeof value.maxTurnTokens === "number" && Number.isFinite(value.maxTurnTokens)
      ? Math.max(1, Math.trunc(value.maxTurnTokens))
      : undefined;
  if (!maxInjectionTokens && !maxTurnTokens) {
    return undefined;
  }
  return {
    maxInjectionTokens,
    maxTurnTokens,
  };
}

function normalizeWorkspaceSubagentConfigKind(
  value: string | undefined,
): HostedWorkspaceSubagentConfigKind | undefined {
  if (value === "envelope") {
    return "envelope";
  }
  if (value === "agentSpec") {
    return "agentSpec";
  }
  return undefined;
}

export function classifyHostedWorkspaceSubagentConfig(
  source: Record<string, unknown>,
  options: {
    defaultKind?: HostedWorkspaceSubagentConfigKind;
  } = {},
): HostedWorkspaceSubagentConfigKind {
  const explicitKind = asString(source.kind);
  if (!explicitKind) {
    if (options.defaultKind) {
      return options.defaultKind;
    }
    throw new Error("missing required kind");
  }
  const normalized = normalizeWorkspaceSubagentConfigKind(explicitKind);
  if (!normalized) {
    throw new Error(`unknown kind '${explicitKind}'`);
  }
  return normalized;
}

function parseHostedWorkspaceAgentMarkdownConfig(input: {
  fileName: string;
  raw: string;
}): Record<string, unknown> {
  const frontmatter = parseMarkdownFrontmatter(input.raw);
  const parsed: Record<string, unknown> = {
    ...frontmatter.data,
    name: asString(frontmatter.data.name) ?? basename(input.fileName, ".md"),
  };
  const trimmedBody = frontmatter.body.trim();
  if (trimmedBody.length > 0) {
    parsed.instructionsMarkdown = trimmedBody;
  }
  return parsed;
}

async function readHostedWorkspaceConfigDirectory(input: {
  directory: string;
  extension: ".json" | ".md";
  source: HostedWorkspaceSubagentConfigSource;
}): Promise<HostedWorkspaceSubagentConfigFile[]> {
  if (!existsSync(input.directory)) {
    return [];
  }

  const files: HostedWorkspaceSubagentConfigFile[] = [];
  const entries = readdirSync(input.directory, { withFileTypes: true }).toSorted((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(input.extension)) {
      continue;
    }
    const filePath = resolve(input.directory, entry.name);
    const raw = await readFile(filePath, "utf8");
    if (!raw.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed =
        input.extension === ".json"
          ? parseJsonc(raw)
          : parseHostedWorkspaceAgentMarkdownConfig({
              fileName: entry.name,
              raw,
            });
    } catch (error) {
      throw new Error(
        `invalid_subagent_config:${entry.name}:${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!isRecord(parsed)) {
      throw new Error(`invalid_subagent_config:${entry.name}:root must be an object`);
    }
    let kind: HostedWorkspaceSubagentConfigKind;
    try {
      kind = classifyHostedWorkspaceSubagentConfig(parsed, {
        defaultKind: input.extension === ".md" ? "agentSpec" : undefined,
      });
    } catch (error) {
      throw new Error(
        `invalid_subagent_config:${entry.name}:${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    files.push({
      fileName: entry.name,
      filePath,
      kind,
      source: input.source,
      parsed,
    });
  }

  return files;
}

export async function readHostedWorkspaceSubagentConfigFiles(
  workspaceRoot: string,
): Promise<HostedWorkspaceSubagentConfigFile[]> {
  const files = await Promise.all([
    readHostedWorkspaceConfigDirectory({
      directory: resolve(workspaceRoot, ".brewva", "subagents"),
      extension: ".json",
      source: "json",
    }),
    readHostedWorkspaceConfigDirectory({
      directory: resolve(workspaceRoot, ".brewva", "agents"),
      extension: ".md",
      source: "markdown",
    }),
    readHostedWorkspaceConfigDirectory({
      directory: resolve(workspaceRoot, ".config", "brewva", "agents"),
      extension: ".md",
      source: "markdown",
    }),
  ]);

  return files.flat().toSorted((left, right) => left.filePath.localeCompare(right.filePath));
}
