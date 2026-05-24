import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { parseMarkdownFrontmatter } from "@brewva/brewva-std/markdown";
import type { ShellCommand, ShellCommandProvider } from "./command-provider.js";

interface FileCommandProviderSpec {
  id: string;
  label: string;
  root: string;
}

interface FileCommandArgument {
  name: string;
  description?: string;
  required: boolean;
}

interface LoadedFileCommand {
  command: ShellCommand;
  provider: FileCommandProviderSpec;
  path: string;
}

const UNSUPPORTED_AUTHORITY_KEYS = new Set([
  "allowed-tools",
  "allowedTools",
  "tools",
  "permissions",
  "mcp",
  "capabilities",
]);

function commandProviderSpecs(cwd: string, home = homedir()): FileCommandProviderSpec[] {
  return [
    { id: "brewva.project", label: "Project Brewva", root: join(cwd, ".brewva", "commands") },
    { id: "brewva.user", label: "User Brewva", root: join(home, ".brewva", "commands") },
    { id: "claude.project", label: "Project Claude", root: join(cwd, ".claude", "commands") },
    { id: "claude.user", label: "User Claude", root: join(home, ".claude", "commands") },
    { id: "codex.project", label: "Project Codex", root: join(cwd, ".codex", "commands") },
    { id: "codex.user", label: "User Codex", root: join(home, ".codex", "commands") },
    {
      id: "opencode.project",
      label: "Project OpenCode",
      root: join(cwd, ".opencode", "commands"),
    },
    { id: "opencode.user", label: "User OpenCode", root: join(home, ".opencode", "commands") },
  ];
}

function listMarkdownFiles(root: string): string[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return [];
  }
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files.toSorted();
}

function slashNameFromPath(root: string, path: string): string {
  const withoutExtension = relative(root, path).replace(/\.md$/iu, "");
  return withoutExtension
    .split(sep)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join("/");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readArguments(value: unknown, path: string): FileCommandArgument[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${path}: frontmatter.arguments must be an array`);
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${path}: frontmatter.arguments[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const name = readString(record.name);
    if (!name) {
      throw new Error(`${path}: frontmatter.arguments[${index}].name is required`);
    }
    return {
      name,
      description: readString(record.description),
      required: record.required === true,
    };
  });
}

function assertNoAuthorityFrontmatter(data: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(data)) {
    if (UNSUPPORTED_AUTHORITY_KEYS.has(key)) {
      throw new Error(`${path}: file-backed slash commands cannot request authority via ${key}`);
    }
  }
}

function tokenizeArgs(args: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const char = args[index];
    if (char === "\\" && quote !== "'") {
      const next = args[index + 1];
      if (next !== undefined) {
        current += next;
        index += 1;
        continue;
      }
    }
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (/\s/u.test(char ?? "") && quote === null) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function resolveArgumentValues(
  schema: readonly FileCommandArgument[],
  rawArgs: string,
): Record<string, string> {
  const values: Record<string, string> = {};
  const tokens = tokenizeArgs(rawArgs.trim());
  for (const token of tokens) {
    const separator = token.indexOf("=");
    if (separator > 0) {
      values[token.slice(0, separator)] = token.slice(separator + 1);
    }
  }
  if (schema.length === 1 && rawArgs.trim().length > 0 && values[schema[0]!.name] === undefined) {
    values[schema[0]!.name] = rawArgs.trim();
  }
  let positionalIndex = 0;
  for (const argument of schema) {
    if (values[argument.name] !== undefined) {
      continue;
    }
    while (tokens[positionalIndex]?.includes("=")) {
      positionalIndex += 1;
    }
    const token = tokens[positionalIndex];
    if (token !== undefined) {
      values[argument.name] = token;
      positionalIndex += 1;
    }
  }
  for (const argument of schema) {
    if (argument.required && !values[argument.name]) {
      throw new Error(`Missing required slash command argument: ${argument.name}`);
    }
  }
  return values;
}

function expandTemplate(
  body: string,
  values: Record<string, string>,
): { text: string; missingArgs: readonly string[] } {
  const missingArgs = new Set<string>();
  const text = body.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/gu, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) {
      missingArgs.add(name);
      return "";
    }
    return value;
  });
  return { text, missingArgs: [...missingArgs].toSorted() };
}

function loadFileCommand(provider: FileCommandProviderSpec, path: string): LoadedFileCommand {
  const parsed = parseMarkdownFrontmatter(readFileSync(path, "utf8"));
  assertNoAuthorityFrontmatter(parsed.data, path);
  const slashName = slashNameFromPath(provider.root, path);
  const args = readArguments(parsed.data.arguments, path);
  const description = readString(parsed.data.description);
  const title = description ?? basename(path, ".md");
  const body = parsed.body.trim();
  if (!slashName || !body) {
    throw new Error(`${path}: slash command requires a non-empty name and body`);
  }
  return {
    provider,
    path,
    command: {
      id: `file-command.${provider.id}.${slashName.replace(/[^a-z0-9_-]+/giu, ".")}`,
      title,
      description,
      category: "Commands",
      slash: {
        name: slashName,
        argumentMode:
          args.length === 0
            ? "none"
            : args.some((argument) => argument.required)
              ? "required"
              : "optional",
      },
      createIntent(input) {
        const values = resolveArgumentValues(args, input.args);
        const expanded = expandTemplate(body, values);
        return {
          type: "prompt.submit",
          source: "slash",
          text: expanded.text,
          ...(expanded.missingArgs.length > 0
            ? {
                warnings: [
                  `Slash command /${slashName} has missing optional template variables: ${expanded.missingArgs.join(
                    ", ",
                  )}`,
                ],
              }
            : {}),
        };
      },
    },
  };
}

export function registerFileBackedSlashCommands(input: {
  commandProvider: ShellCommandProvider;
  cwd: string;
  homeDir?: string;
}): void {
  for (const provider of commandProviderSpecs(input.cwd, input.homeDir)) {
    for (const path of listMarkdownFiles(provider.root)) {
      const loaded = loadFileCommand(provider, path);
      input.commandProvider.register(loaded.command, {
        allowSlashShadowing: true,
        provenance: {
          providerId: loaded.provider.id,
          providerLabel: loaded.provider.label,
          path: loaded.path,
        },
      });
    }
  }
}
