import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import type { DelegationIsolationStrategy } from "@brewva/brewva-runtime/protocol";
import type { ManagedToolMode } from "@brewva/brewva-runtime/protocol";
import { parseMarkdownFrontmatter } from "@brewva/brewva-std/markdown";
import { normalizeStringList, readNonEmptyString } from "@brewva/brewva-std/text";
import { isRecord as isUnknownRecord, readFiniteNumberValue } from "@brewva/brewva-std/unknown";
import type {
  ExplorerConsultKind,
  SubagentContextBudget,
  SubagentExecutionBoundary,
  SubagentResultMode,
} from "@brewva/brewva-tools/contracts";

export type HostedDelegationBuiltinToolName = "read" | "edit" | "write";
export type HostedWorkspaceSubagentConfigKind = "envelope" | "agentSpec";
export type HostedWorkspaceSubagentConfigSource = "json" | "markdown";

export interface HostedWorkspaceSubagentConfigFile {
  fileName: string;
  filePath: string;
  kind: HostedWorkspaceSubagentConfigKind;
  source: HostedWorkspaceSubagentConfigSource;
  parsed: Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return isUnknownRecord(value);
}

export function asString(value: unknown): string | undefined {
  return readNonEmptyString(value);
}

export function asStringArray(value: unknown): string[] | undefined {
  const entries = normalizeStringList(value);
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
  return value === "hosted" || value === "direct" ? value : undefined;
}

export function asResultMode(value: unknown): SubagentResultMode | undefined {
  return value === "evidence" ||
    value === "consult" ||
    value === "verifier" ||
    value === "patch" ||
    value === "knowledge"
    ? value
    : undefined;
}

export function asConsultKind(value: unknown): ExplorerConsultKind | undefined {
  return value === "investigate" || value === "diagnose" || value === "design" || value === "review"
    ? value
    : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function asIsolationStrategy(value: unknown): DelegationIsolationStrategy | undefined {
  return value === "shared" ||
    value === "ephemeral" ||
    value === "snapshot" ||
    value === "worktree" ||
    value === "container"
    ? value
    : undefined;
}

export function asContextBudget(value: unknown): SubagentContextBudget | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const maxInjectionTokenValue = readFiniteNumberValue(value.maxInjectionTokens);
  const maxInjectionTokens =
    maxInjectionTokenValue !== undefined
      ? Math.max(1, Math.trunc(maxInjectionTokenValue))
      : undefined;
  const maxTurnTokenValue = readFiniteNumberValue(value.maxTurnTokens);
  const maxTurnTokens =
    maxTurnTokenValue !== undefined ? Math.max(1, Math.trunc(maxTurnTokenValue)) : undefined;
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
  extension: ".md";
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
      parsed = parseHostedWorkspaceAgentMarkdownConfig({
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
        defaultKind: "agentSpec",
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

function rejectUnsupportedWorkspaceConfigFiles(input: {
  directory: string;
  extension: ".json" | ".md";
  reason: string;
}): void {
  if (!existsSync(input.directory)) {
    return;
  }
  const unsupported = readdirSync(input.directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(input.extension))
    .map((entry) => entry.name)
    .toSorted((left, right) => left.localeCompare(right));
  if (unsupported.length === 0) {
    return;
  }
  throw new Error(`invalid_subagent_config:[${unsupported.join(",")}]:${input.reason}`);
}

export async function readHostedWorkspaceSubagentConfigFiles(
  workspaceRoot: string,
): Promise<HostedWorkspaceSubagentConfigFile[]> {
  rejectUnsupportedWorkspaceConfigFiles({
    directory: resolve(workspaceRoot, ".brewva", "subagents"),
    extension: ".json",
    reason: "JSON subagent configs are no longer supported; use .brewva/subagents/*.md",
  });
  rejectUnsupportedWorkspaceConfigFiles({
    directory: resolve(workspaceRoot, ".brewva", "agents"),
    extension: ".md",
    reason:
      "legacy .brewva/agents subagent configs are no longer supported; use .brewva/subagents/*.md",
  });
  rejectUnsupportedWorkspaceConfigFiles({
    directory: resolve(workspaceRoot, ".config", "brewva", "agents"),
    extension: ".md",
    reason:
      "legacy .config/brewva/agents subagent configs are no longer supported; use .brewva/subagents/*.md",
  });
  const files = await Promise.all([
    readHostedWorkspaceConfigDirectory({
      directory: resolve(workspaceRoot, ".brewva", "subagents"),
      extension: ".md",
      source: "markdown",
    }),
    readHostedWorkspaceConfigDirectory({
      directory: resolve(homedir(), ".brewva", "subagents"),
      extension: ".md",
      source: "markdown",
    }),
  ]);

  return files.flat().toSorted((left, right) => left.filePath.localeCompare(right.filePath));
}
