import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { parseMarkdownFrontmatter } from "@brewva/brewva-std/markdown";
import { normalizeStringList, readNonEmptyString } from "@brewva/brewva-std/text";
import { isRecord } from "@brewva/brewva-std/unknown";

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

export { isRecord };

export function asString(value: unknown): string | undefined {
  return readNonEmptyString(value);
}

export function asStringArray(value: unknown): string[] | undefined {
  const entries = normalizeStringList(value);
  return entries.length > 0 ? entries : undefined;
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
