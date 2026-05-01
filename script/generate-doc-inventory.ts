import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { BREWVA_REGISTERED_EVENT_TYPES } from "@brewva/brewva-runtime/events";

type InventoryBlock = {
  name: string;
  path: string;
  content: string;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8");
}

function writeRepoFile(relativePath: string, content: string): void {
  writeFileSync(resolve(repoRoot, relativePath), content);
}

function walkFiles(directory: string, extension: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath, extension));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(extension)) {
      files.push(fullPath);
    }
  }

  return files.toSorted((left, right) => left.localeCompare(right));
}

function collectDefinedToolNames(sourceRoot: string): string[] {
  const names = new Set<string>();

  for (const filePath of walkFiles(sourceRoot, ".ts")) {
    const text = readFileSync(filePath, "utf-8");
    for (const match of text.matchAll(
      /defineBrewvaTool\s*\(\s*\{[\s\S]*?name:\s*"([a-z0-9_]+)"/g,
    )) {
      const toolName = match[1];
      if (toolName) {
        names.add(toolName);
      }
    }
    for (const match of text.matchAll(
      /createRuntimeBoundBrewvaToolFactory\s*\(\s*[^,]+,\s*"([a-z0-9_]+)"/g,
    )) {
      const toolName = match[1];
      if (toolName) {
        names.add(toolName);
      }
    }
  }

  return [...names].toSorted((left, right) => left.localeCompare(right));
}

function collectSkillNames(root: string, relativeDirs: string[]): string[] {
  const names: string[] = [];

  for (const relativeDir of relativeDirs) {
    const tierDir = join(root, relativeDir);
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = readdirSync(tierDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(tierDir, entry.name, "SKILL.md");
      try {
        if (statSync(skillPath).isFile()) {
          names.push(entry.name);
        }
      } catch {
        // Ignore non-skill folders.
      }
    }
  }

  return names.toSorted((left, right) => left.localeCompare(right));
}

function collectProjectGuidanceNames(root: string): string[] {
  const sharedDir = join(root, "project/shared");
  try {
    return readdirSync(sharedDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.replace(/\.md$/i, ""))
      .toSorted((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function extractLongFlags(source: string): string[] {
  const matches = source.match(/--[a-z][a-z-]*/g) ?? [];
  return [...new Set(matches)].toSorted((left, right) => left.localeCompare(right));
}

function extractGatewayCommands(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/command === "([a-z][a-z-]+)"/g)) {
    const name = match[1];
    if (name && name !== "help") {
      names.add(name);
    }
  }
  return [...names].toSorted((left, right) => left.localeCompare(right));
}

function extractGatewayOptionKeys(source: string): string[] {
  const names = new Set<string>();
  for (const block of source.matchAll(/const [A-Z_]+_PARSE_OPTIONS = \{([\s\S]*?)\} as const;/g)) {
    const body = block[1] ?? "";
    for (const line of body.split("\n")) {
      const match = /^\s*(?:"([^"]+)"|([a-z][a-z-]*)):\s*\{/.exec(line);
      const key = match?.[1] ?? match?.[2];
      if (key) {
        names.add(`--${key}`);
      }
    }
  }
  return [...names].toSorted((left, right) => left.localeCompare(right));
}

function extractRootSubcommands(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/subcommand\?\.name === "([a-z][a-z-]+)"/g)) {
    const name = match[1];
    if (name) {
      names.add(name);
    }
  }
  return [...names].toSorted((left, right) => left.localeCompare(right));
}

function extractConstObjectBody(source: string, constName: string): string {
  const markers = [`export const ${constName} = {`, `const ${constName} = {`];
  const start =
    markers.map((marker) => source.indexOf(marker)).find((candidate) => candidate >= 0) ?? -1;
  if (start < 0) {
    throw new Error(`Unable to find const object ${constName}`);
  }
  const bodyStart = source.indexOf("{", start);
  if (bodyStart < 0) {
    throw new Error(`Unable to find const object ${constName} body`);
  }

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) {
      return source.slice(bodyStart + 1, index);
    }
  }

  throw new Error(`Unable to close const object ${constName}`);
}

function collectSurfaceContributionDefinitions(): Map<string, Map<string, string[]>> {
  const runtimeRoot = resolve(repoRoot, "packages/brewva-runtime/src");
  const contributions = new Map<string, Map<string, string[]>>();

  for (const filePath of walkFiles(runtimeRoot, ".ts")) {
    const text = readFileSync(filePath, "utf-8");
    for (const match of text.matchAll(
      /export const ([A-Za-z][A-Za-z0-9]*SurfaceContribution) = \{/g,
    )) {
      const contributionName = match[1];
      if (!contributionName || contributions.has(contributionName)) {
        continue;
      }
      const body = extractConstObjectBody(text, contributionName);
      const surfaces = new Map<string, string[]>();
      const lines = body.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const headerMatch = /^\s{2}(authority|inspect|maintain): \[(.*)$/.exec(line);
        const surfaceName = headerMatch?.[1];
        if (!surfaceName) {
          continue;
        }
        let surfaceBody = headerMatch[2] ?? "";
        let bracketDepth = (surfaceBody.match(/\[/g) ?? []).length + 1;
        bracketDepth -= (surfaceBody.match(/\]/g) ?? []).length;
        while (bracketDepth > 0 && index + 1 < lines.length) {
          index += 1;
          const nextLine = lines[index] ?? "";
          surfaceBody += `\n${nextLine}`;
          bracketDepth += (nextLine.match(/\[/g) ?? []).length;
          bracketDepth -= (nextLine.match(/\]/g) ?? []).length;
        }
        const methods = [...surfaceBody.matchAll(/"([a-zA-Z][a-zA-Z0-9]*)"/g)]
          .map((entry) => entry[1])
          .filter((value): value is string => Boolean(value))
          .toSorted((left, right) => left.localeCompare(right));
        surfaces.set(surfaceName, methods);
      }
      contributions.set(contributionName, surfaces);
    }
  }

  return contributions;
}

function collectRuntimePortPaths(): string[] {
  const runtimeSource = readRepoFile("packages/brewva-runtime/src/runtime/runtime.ts");
  const contributions = collectSurfaceContributionDefinitions();
  const paths = new Set<string>();
  const runtimeRoot = resolve(repoRoot, "packages/brewva-runtime/src/domain");

  for (const filePath of walkFiles(runtimeRoot, ".ts")) {
    const source = readFileSync(filePath, "utf-8");
    for (const moduleMatch of source.matchAll(
      /export const [A-Za-z][A-Za-z0-9]*RuntimeSurface = defineRuntimeSurfaceModule\(\{\s*name: "([a-zA-Z][a-zA-Z0-9]*)",[\s\S]*?contribution: ([A-Za-z][A-Za-z0-9]*SurfaceContribution),/g,
    )) {
      const domainName = moduleMatch[1];
      const contributionName = moduleMatch[2];
      if (!domainName || !contributionName) continue;
      const surfaceDefinitions = contributions.get(contributionName);
      if (!surfaceDefinitions) continue;
      for (const surfaceName of ["authority", "inspect", "maintain"] as const) {
        for (const method of surfaceDefinitions.get(surfaceName) ?? []) {
          paths.add(`${surfaceName}.${domainName}.${method}`);
        }
      }
    }
  }

  const directRuntimeMethods = collectPublicRuntimeMethods(runtimeSource).map(
    (method) => `runtime.${method}`,
  );
  for (const path of directRuntimeMethods) {
    paths.add(path);
  }

  return [...paths].toSorted((left, right) => left.localeCompare(right));
}

function collectPublicRuntimeMethods(source: string): string[] {
  const lines = source.split("\n");
  const methods: string[] = [];
  let insideRuntimeClass = false;
  let classDepth = 0;

  for (const line of lines) {
    if (!insideRuntimeClass) {
      if (!line.startsWith("export class BrewvaRuntime ")) {
        continue;
      }
      insideRuntimeClass = true;
      classDepth = 1;
      continue;
    }

    classDepth += (line.match(/{/g) ?? []).length;
    classDepth -= (line.match(/}/g) ?? []).length;
    if (classDepth <= 0) {
      break;
    }

    if (!line.startsWith("  ")) continue;
    if (line.startsWith("  private ")) continue;
    if (line.startsWith("  constructor(")) continue;

    const match = /^  ([a-zA-Z][a-zA-Z0-9_]*)\(/.exec(line);
    if (!match) continue;

    const method = match[1];
    if (method) {
      methods.push(method);
    }
  }

  return [...new Set(methods)].toSorted((left, right) => left.localeCompare(right));
}

function markdownList(values: readonly string[]): string {
  return values.map((value) => `- \`${value}\``).join("\n");
}

function renderToolsInventory(): string {
  const toolNames = collectDefinedToolNames(resolve(repoRoot, "packages/brewva-tools/src"));
  return [
    "> Generated by `bun run docs:inventory`. Do not edit this block by hand.",
    "",
    `Tool count: ${toolNames.length}.`,
    "",
    markdownList(toolNames),
  ].join("\n");
}

function renderSkillsInventory(): string {
  const skillNames = collectSkillNames(resolve(repoRoot, "skills"), [
    "core",
    "domain",
    "operator",
    "meta",
    "project/overlays",
  ]);
  const projectGuidanceNames = collectProjectGuidanceNames(resolve(repoRoot, "skills"));
  return [
    "> Generated by `bun run docs:inventory`. Do not edit this block by hand.",
    "",
    `Skill count: ${skillNames.length}. Project guidance count: ${projectGuidanceNames.length}.`,
    "",
    "### Skills",
    "",
    markdownList(skillNames),
    "",
    "### Project Guidance",
    "",
    markdownList(projectGuidanceNames),
  ].join("\n");
}

function renderRuntimeSurface(): string {
  const paths = collectRuntimePortPaths();
  return [
    "> Generated by `bun run docs:inventory`. Do not edit this block by hand.",
    "",
    `Runtime surface member count: ${paths.length}.`,
    "",
    markdownList(paths),
  ].join("\n");
}

function renderCliFlags(): string {
  const cliSource = readRepoFile("packages/brewva-cli/src/index.ts");
  const gatewaySource = readRepoFile("packages/brewva-gateway/src/cli.ts");
  const flags = [
    ...new Set([...extractLongFlags(cliSource), ...extractGatewayOptionKeys(gatewaySource)]),
  ].toSorted((left, right) => left.localeCompare(right));
  const rootSubcommands = extractRootSubcommands(cliSource);
  const gatewaySubcommands = extractGatewayCommands(gatewaySource);
  return [
    "> Generated by `bun run docs:inventory`. Do not edit this block by hand.",
    "",
    `Root subcommand count: ${rootSubcommands.length}. Gateway subcommand count: ${gatewaySubcommands.length}. CLI flag count: ${flags.length}.`,
    "",
    "### Root Subcommands",
    "",
    markdownList(rootSubcommands),
    "",
    "### Gateway Subcommands",
    "",
    markdownList(gatewaySubcommands),
    "",
    "### Long Flags",
    "",
    markdownList(flags),
  ].join("\n");
}

function renderEventCatalog(): string {
  return [
    "> Generated by `bun run docs:inventory`. Do not edit this block by hand.",
    "",
    `Registered event type count: ${BREWVA_REGISTERED_EVENT_TYPES.length}.`,
    "",
    markdownList(BREWVA_REGISTERED_EVENT_TYPES),
  ].join("\n");
}

function renderConfigKeys(): string {
  const keys = Object.keys(DEFAULT_BREWVA_CONFIG).toSorted((left, right) =>
    left.localeCompare(right),
  );
  return [
    "> Generated by `bun run docs:inventory`. Do not edit this block by hand.",
    "",
    `Top-level config key count: ${keys.length}.`,
    "",
    markdownList(keys),
  ].join("\n");
}

function replaceGeneratedBlock(markdown: string, blockName: string, content: string): string {
  const startMarker = `<!-- generated:${blockName} start -->`;
  const endMarker = `<!-- generated:${blockName} end -->`;
  const start = markdown.indexOf(startMarker);
  const end = markdown.indexOf(endMarker);

  if (start < 0 || end < 0 || end < start) {
    throw new Error(`Missing generated markers for ${blockName}`);
  }

  const before = markdown.slice(0, start + startMarker.length);
  const after = markdown.slice(end);
  return `${before}\n\n${content}\n${after}`;
}

function buildBlocks(): InventoryBlock[] {
  return [
    {
      name: "tools-inventory",
      path: "docs/reference/tools.md",
      content: renderToolsInventory(),
    },
    {
      name: "skills-inventory",
      path: "docs/reference/skills.md",
      content: renderSkillsInventory(),
    },
    {
      name: "runtime-surface",
      path: "docs/reference/runtime.md",
      content: renderRuntimeSurface(),
    },
    {
      name: "cli-flags",
      path: "docs/reference/commands.md",
      content: renderCliFlags(),
    },
    {
      name: "event-catalog",
      path: "docs/reference/events/README.md",
      content: renderEventCatalog(),
    },
    {
      name: "config-keys",
      path: "docs/reference/configuration.md",
      content: renderConfigKeys(),
    },
  ];
}

function main(): void {
  const { values } = parseArgs({
    options: {
      write: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
    },
  });

  if (values.write === values.check) {
    throw new Error("Use exactly one mode: --write or --check.");
  }

  const changed: string[] = [];

  for (const block of buildBlocks()) {
    const markdown = readRepoFile(block.path);
    const next = replaceGeneratedBlock(markdown, block.name, block.content);
    if (next !== markdown) {
      changed.push(block.path);
      if (values.write) {
        writeRepoFile(block.path, next);
      }
    }
  }

  if (values.check && changed.length > 0) {
    console.error(
      [
        "Generated docs inventory is stale. Run `bun run docs:inventory`.",
        ...changed.map((path) => `- ${path}`),
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  if (values.write) {
    console.log(
      changed.length > 0
        ? `Updated generated docs inventory in ${changed.length} file(s).`
        : "Generated docs inventory is already up to date.",
    );
  }
}

main();
