import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  createBrewvaSyntheticSourceInfo,
  type BrewvaSourceInfo,
  type BrewvaSourceScope,
} from "../provenance/source-info.js";
import { parseMarkdownFrontmatter } from "./markdown-frontmatter.js";

export interface BrewvaPromptTemplate {
  name: string;
  description: string;
  content: string;
  filePath: string;
  sourceInfo?: BrewvaSourceInfo;
}

function normalizePath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  if (trimmed.startsWith("~")) return join(homedir(), trimmed.slice(1));
  return trimmed;
}

function resolvePromptPath(p: string, cwd: string): string {
  const normalized = normalizePath(p);
  return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

function loadTemplateFromFile(
  filePath: string,
  sourceInfo?: BrewvaSourceInfo,
): BrewvaPromptTemplate | null {
  try {
    const raw = readFileSync(filePath, "utf8");
    const { data, body } = parseMarkdownFrontmatter(raw);
    const name = basename(filePath).replace(/\.md$/u, "");
    let description = typeof data.description === "string" ? data.description : "";
    if (!description) {
      const firstLine = body.split("\n").find((line) => line.trim().length > 0);
      if (firstLine) {
        description = firstLine.slice(0, 60);
        if (firstLine.length > 60) {
          description += "...";
        }
      }
    }
    return {
      name,
      description,
      content: body,
      filePath,
      ...(sourceInfo !== undefined ? { sourceInfo } : {}),
    };
  } catch {
    return null;
  }
}

function loadTemplatesFromDir(
  dir: string,
  input?: {
    cwd: string;
    agentDir: string;
    configDirName: string;
  },
): BrewvaPromptTemplate[] {
  if (!existsSync(dir)) {
    return [];
  }

  const templates: BrewvaPromptTemplate[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          isFile = statSync(fullPath).isFile();
        } catch {
          continue;
        }
      }
      if (!isFile || !entry.name.endsWith(".md")) {
        continue;
      }
      const template = loadTemplateFromFile(
        fullPath,
        input
          ? buildPromptTemplatePathSourceInfo(
              fullPath,
              input.cwd,
              input.agentDir,
              input.configDirName,
            )
          : undefined,
      );
      if (template) {
        templates.push(template);
      }
    }
  } catch {
    return templates;
  }

  return templates;
}

export interface LoadBrewvaPromptTemplatesOptions {
  cwd?: string;
  agentDir?: string;
  promptPaths?: string[];
  includeDefaults?: boolean;
  configDirName?: string;
}

export function loadBrewvaPromptTemplates(
  options: LoadBrewvaPromptTemplatesOptions = {},
): BrewvaPromptTemplate[] {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? join(homedir(), ".brewva-agent");
  const includeDefaults = options.includeDefaults ?? true;
  const configDirName = options.configDirName ?? ".brewva";
  const promptPaths = options.promptPaths ?? [];

  const templates: BrewvaPromptTemplate[] = [];
  const globalPromptDir = join(agentDir, "prompts");
  const projectPromptDir = join(cwd, configDirName, "prompts");

  if (includeDefaults) {
    templates.push(...loadTemplatesFromDir(globalPromptDir, { cwd, agentDir, configDirName }));
    templates.push(...loadTemplatesFromDir(projectPromptDir, { cwd, agentDir, configDirName }));
  }

  for (const rawPath of promptPaths) {
    const resolvedPath = resolvePromptPath(rawPath, cwd);
    if (!existsSync(resolvedPath)) {
      continue;
    }
    try {
      const stats = statSync(resolvedPath);
      if (stats.isDirectory()) {
        templates.push(...loadTemplatesFromDir(resolvedPath, { cwd, agentDir, configDirName }));
      } else if (stats.isFile() && resolvedPath.endsWith(".md")) {
        const template = loadTemplateFromFile(
          resolvedPath,
          buildPromptTemplatePathSourceInfo(resolvedPath, cwd, agentDir, configDirName),
        );
        if (template) {
          templates.push(template);
        }
      }
    } catch {
      continue;
    }
  }

  return templates;
}

export function parsePromptTemplateArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (const char of argsString) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === " " || char === "\t") {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current.length > 0) {
    args.push(current);
  }
  return args;
}

export function substitutePromptTemplateArgs(content: string, args: string[]): string {
  let result = content.replace(/\$(\d+)/gu, (_match, numberText) => {
    const index = Number.parseInt(numberText, 10) - 1;
    return args[index] ?? "";
  });

  result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/gu, (_match, startText, lengthText) => {
    let startIndex = Number.parseInt(startText, 10) - 1;
    if (startIndex < 0) {
      startIndex = 0;
    }
    if (lengthText) {
      const length = Number.parseInt(lengthText, 10);
      return args.slice(startIndex, startIndex + length).join(" ");
    }
    return args.slice(startIndex).join(" ");
  });

  const allArgs = args.join(" ");
  result = result.replace(/\$ARGUMENTS/gu, allArgs);
  result = result.replace(/\$@/gu, allArgs);
  return result;
}

export function expandBrewvaPromptTemplate(
  text: string,
  templates: readonly BrewvaPromptTemplate[],
): string {
  if (!text.startsWith("/")) {
    return text;
  }
  const spaceIndex = text.indexOf(" ");
  const templateName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
  const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);
  const template = templates.find((candidate) => candidate.name === templateName);
  if (!template) {
    return text;
  }
  const args = parsePromptTemplateArgs(argsString);
  return substitutePromptTemplateArgs(template.content, args);
}

export function isPathUnderRoot(target: string, root: string): boolean {
  const normalizedRoot = resolve(root);
  if (target === normalizedRoot) {
    return true;
  }
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  return target.startsWith(prefix);
}

export function buildPromptTemplatePathSourceInfo(
  resolvedPath: string,
  cwd: string,
  agentDir: string,
  configDirName: string,
): BrewvaSourceInfo {
  const globalPromptDir = join(agentDir, "prompts");
  const projectPromptDir = join(cwd, configDirName, "prompts");
  if (isPathUnderRoot(resolvedPath, globalPromptDir)) {
    return createBrewvaSyntheticSourceInfo(resolvedPath, {
      source: "local",
      scope: "user",
      baseDir: globalPromptDir,
    });
  }
  if (isPathUnderRoot(resolvedPath, projectPromptDir)) {
    return createBrewvaSyntheticSourceInfo(resolvedPath, {
      source: "local",
      scope: "project",
      baseDir: projectPromptDir,
    });
  }
  const scope: BrewvaSourceScope = isPathUnderRoot(resolvedPath, agentDir) ? "user" : "project";
  return createBrewvaSyntheticSourceInfo(resolvedPath, {
    source: "local",
    scope,
    baseDir: statSync(resolvedPath).isDirectory() ? resolvedPath : dirname(resolvedPath),
  });
}
