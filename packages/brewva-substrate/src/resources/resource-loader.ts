import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { InternalHostPlugin } from "../host-api/plugin.js";
import { type BrewvaPromptTemplate, loadBrewvaPromptTemplates } from "../prompt/templates.js";
import { discoverHostedSkills } from "./skill-discovery.js";

export interface BrewvaHostedSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
}

export interface BrewvaHostedSkillLoadResult {
  skills: BrewvaHostedSkill[];
  diagnostics: Array<{ path: string; message: string }>;
}

export interface BrewvaHostedResourceExtensions {
  extensions: unknown[];
  errors: Array<{ path: string; error: string }>;
}

export type BrewvaProjectInstructionSource = "global" | "ancestor" | "target";

export interface BrewvaProjectInstructionFile {
  path: string;
  content: string;
  fileName: "CLAUDE.md" | "AGENTS.md";
  directory: string;
  source: BrewvaProjectInstructionSource;
}

export interface BrewvaProjectInstructionSet {
  files: BrewvaProjectInstructionFile[];
  diagnostics: Array<{ path: string; message: string }>;
}

export interface BrewvaHostedResourceLoader {
  getExtensions(): BrewvaHostedResourceExtensions;
  getSkills(): BrewvaHostedSkillLoadResult;
  getPrompts(): {
    prompts: BrewvaPromptTemplate[];
    diagnostics: Array<{ path: string; message: string }>;
  };
  getProjectInstructions(): BrewvaProjectInstructionSet;
  getProjectInstructionsForTarget(targetPath: string): BrewvaProjectInstructionSet;
  getCustomInstructions(): string | undefined;
  getAppendInstructions(): string[];
  reload(): Promise<void>;
}

const PROJECT_INSTRUCTION_FILE_NAMES = ["CLAUDE.md", "AGENTS.md"] as const;

function loadInstructionFilesFromDir(
  dir: string,
  source: BrewvaProjectInstructionSource,
): BrewvaProjectInstructionSet {
  const files: BrewvaProjectInstructionFile[] = [];
  const diagnostics: Array<{ path: string; message: string }> = [];
  for (const fileName of PROJECT_INSTRUCTION_FILE_NAMES) {
    const filePath = join(dir, fileName);
    if (!existsSync(filePath)) {
      continue;
    }
    try {
      files.push({
        path: filePath,
        content: readFileSync(filePath, "utf8"),
        fileName,
        directory: dir,
        source,
      });
    } catch (error) {
      diagnostics.push({
        path: filePath,
        message: error instanceof Error ? error.message : "failed_to_read_project_instruction",
      });
    }
  }
  return { files, diagnostics };
}

function collectInstructionDirectoriesFromRootToCwd(cwd: string): string[] {
  const directories: string[] = [];
  let currentDir = resolve(cwd);
  const root = resolve("/");
  while (true) {
    directories.unshift(currentDir);
    if (currentDir === root) {
      break;
    }
    const parentDir = resolve(currentDir, "..");
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }
  return directories;
}

function isInsideOrEqual(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function resolveTargetInstructionDirectory(cwd: string, targetPath: string): string {
  const absoluteTarget = isAbsolute(targetPath) ? resolve(targetPath) : resolve(cwd, targetPath);
  try {
    return statSync(absoluteTarget).isDirectory() ? absoluteTarget : dirname(absoluteTarget);
  } catch {
    return dirname(absoluteTarget);
  }
}

function collectNestedDirectoriesFromCwdToTarget(input: { cwd: string; targetPath: string }): {
  directories: string[];
  diagnostic?: { path: string; message: string };
} {
  const cwd = resolve(input.cwd);
  const targetDir = resolveTargetInstructionDirectory(cwd, input.targetPath);
  if (!isInsideOrEqual(cwd, targetDir)) {
    return {
      directories: [],
      diagnostic: {
        path: input.targetPath,
        message: "target_path_outside_cwd",
      },
    };
  }
  const relativeTarget = relative(cwd, targetDir);
  if (relativeTarget === "") {
    return { directories: [] };
  }
  const segments = relativeTarget.split(/[\\/]+/u).filter((segment) => segment.length > 0);
  const directories: string[] = [];
  let current = cwd;
  for (const segment of segments) {
    current = join(current, segment);
    directories.push(current);
  }
  return { directories };
}

function addInstructionSet(
  output: BrewvaProjectInstructionSet,
  seen: Set<string>,
  input: BrewvaProjectInstructionSet,
): void {
  for (const file of input.files) {
    const key = resolve(file.path);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.files.push(file);
  }
  output.diagnostics.push(...input.diagnostics);
}

function loadProjectInstructions(input: {
  cwd: string;
  agentDir: string;
}): BrewvaProjectInstructionSet {
  const output: BrewvaProjectInstructionSet = { files: [], diagnostics: [] };
  const seen = new Set<string>();

  addInstructionSet(output, seen, loadInstructionFilesFromDir(input.agentDir, "global"));
  for (const directory of collectInstructionDirectoriesFromRootToCwd(input.cwd)) {
    addInstructionSet(output, seen, loadInstructionFilesFromDir(directory, "ancestor"));
  }
  return output;
}

function loadTargetProjectInstructions(input: {
  cwd: string;
  base: BrewvaProjectInstructionSet;
  targetPath: string;
}): BrewvaProjectInstructionSet {
  const output: BrewvaProjectInstructionSet = {
    files: [...input.base.files],
    diagnostics: [...input.base.diagnostics],
  };
  const seen = new Set(output.files.map((file) => resolve(file.path)));
  const nested = collectNestedDirectoriesFromCwdToTarget({
    cwd: input.cwd,
    targetPath: input.targetPath,
  });
  if (nested.diagnostic) {
    output.diagnostics.push(nested.diagnostic);
  }
  for (const directory of nested.directories) {
    addInstructionSet(output, seen, loadInstructionFilesFromDir(directory, "target"));
  }
  return output;
}

class InMemoryHostedResourceLoader implements BrewvaHostedResourceLoader {
  readonly #cwd: string;
  readonly #agentDir: string;
  readonly #runtimePlugins: readonly InternalHostPlugin[];
  #extensions: BrewvaHostedResourceExtensions = {
    extensions: [],
    errors: [],
  };
  #skills: BrewvaHostedSkillLoadResult = { skills: [], diagnostics: [] };
  #prompts: {
    prompts: BrewvaPromptTemplate[];
    diagnostics: Array<{ path: string; message: string }>;
  } = {
    prompts: [],
    diagnostics: [],
  };
  #projectInstructions: BrewvaProjectInstructionSet = {
    files: [],
    diagnostics: [],
  };

  constructor(input: {
    cwd: string;
    agentDir: string;
    runtimePlugins?: readonly InternalHostPlugin[];
  }) {
    this.#cwd = input.cwd;
    this.#agentDir = input.agentDir;
    this.#runtimePlugins = input.runtimePlugins ?? [];
  }

  getExtensions(): BrewvaHostedResourceExtensions {
    return this.#extensions;
  }

  getSkills(): BrewvaHostedSkillLoadResult {
    return this.#skills;
  }

  getPrompts(): {
    prompts: BrewvaPromptTemplate[];
    diagnostics: Array<{ path: string; message: string }>;
  } {
    return this.#prompts;
  }

  getProjectInstructions(): BrewvaProjectInstructionSet {
    return {
      files: [...this.#projectInstructions.files],
      diagnostics: [...this.#projectInstructions.diagnostics],
    };
  }

  getProjectInstructionsForTarget(targetPath: string): BrewvaProjectInstructionSet {
    return loadTargetProjectInstructions({
      cwd: this.#cwd,
      base: this.#projectInstructions,
      targetPath,
    });
  }

  getCustomInstructions(): string | undefined {
    return undefined;
  }

  getAppendInstructions(): string[] {
    return [];
  }

  async reload(): Promise<void> {
    this.#extensions = {
      extensions: [],
      errors: [],
    };
    this.#skills = discoverHostedSkills({
      cwd: this.#cwd,
      agentDir: this.#agentDir,
    });
    this.#prompts = {
      prompts: loadBrewvaPromptTemplates({
        cwd: this.#cwd,
        agentDir: this.#agentDir,
        configDirName: ".brewva",
      }),
      diagnostics: [],
    };
    this.#projectInstructions = loadProjectInstructions({
      cwd: this.#cwd,
      agentDir: this.#agentDir,
    });

    // Runtime plugins are already materialized through the Brewva plugin runner.
    // The resource-loader extensions surface remains empty until Brewva grows a
    // Brewva-native file extension discovery layer.
    void this.#runtimePlugins;
  }
}

export async function createHostedResourceLoader(input: {
  cwd: string;
  agentDir: string;
  runtimePlugins?: readonly InternalHostPlugin[];
}): Promise<BrewvaHostedResourceLoader> {
  const loader = new InMemoryHostedResourceLoader(input);
  await loader.reload();
  return loader;
}
