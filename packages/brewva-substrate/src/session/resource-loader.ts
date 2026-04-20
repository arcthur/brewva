import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { InternalHostPlugin } from "../host-api/plugin.js";
import { type BrewvaPromptTemplate, loadBrewvaPromptTemplates } from "./prompt-templates.js";
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

export interface BrewvaHostedResourceLoader {
  getExtensions(): BrewvaHostedResourceExtensions;
  getSkills(): BrewvaHostedSkillLoadResult;
  getPrompts(): {
    prompts: BrewvaPromptTemplate[];
    diagnostics: Array<{ path: string; message: string }>;
  };
  getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
  getSystemPrompt(): string | undefined;
  getAppendSystemPrompt(): string[];
  reload(): Promise<void>;
}

function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
  for (const fileName of ["AGENTS.md", "CLAUDE.md"]) {
    const filePath = join(dir, fileName);
    if (!existsSync(filePath)) {
      continue;
    }
    try {
      return {
        path: filePath,
        content: readFileSync(filePath, "utf8"),
      };
    } catch {
      continue;
    }
  }
  return null;
}

function loadProjectContextFiles(input: {
  cwd: string;
  agentDir: string;
}): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  const seen = new Set<string>();

  const globalContext = loadContextFileFromDir(input.agentDir);
  if (globalContext) {
    files.push(globalContext);
    seen.add(globalContext.path);
  }

  const ancestorFiles: Array<{ path: string; content: string }> = [];
  let currentDir = input.cwd;
  const root = resolve("/");
  while (true) {
    const contextFile = loadContextFileFromDir(currentDir);
    if (contextFile && !seen.has(contextFile.path)) {
      ancestorFiles.unshift(contextFile);
      seen.add(contextFile.path);
    }
    if (currentDir === root) {
      break;
    }
    const parentDir = resolve(currentDir, "..");
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  files.push(...ancestorFiles);
  return files;
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
  #agentsFiles: Array<{ path: string; content: string }> = [];

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

  getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } {
    return { agentsFiles: this.#agentsFiles };
  }

  getSystemPrompt(): string | undefined {
    return undefined;
  }

  getAppendSystemPrompt(): string[] {
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
    this.#agentsFiles = loadProjectContextFiles({
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
