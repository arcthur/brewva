import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { MANAGED_BREWVA_TOOL_NAMES } from "@brewva/brewva-tools/registry";

type InventoryBlock = {
  name: string;
  path: string;
  content: string;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_ROOT_MEMBER_BUDGET = 8;
const CANONICAL_EVENT_TYPE_BUDGET = 15;

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8");
}

function writeRepoFile(relativePath: string, content: string): void {
  writeFileSync(resolve(repoRoot, relativePath), content);
}

function collectDefinedToolNames(): string[] {
  return [...MANAGED_BREWVA_TOOL_NAMES].toSorted((left, right) => left.localeCompare(right));
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
  for (const match of source.matchAll(/kind:\s*"([a-z][a-z-]+)"/g)) {
    const name = match[1];
    if (name && name !== "help" && name !== "unknown") {
      names.add(name);
    }
  }
  for (const match of source.matchAll(/case "([a-z][a-z-]+)"/g)) {
    const name = match[1];
    if (name && name !== "help" && name !== "unknown") {
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

function collectRuntimePortPaths(): string[] {
  const runtimeApiSource = readRepoFile("packages/brewva-runtime/src/runtime/runtime-api.ts");
  return collectRuntimeRootProperties(runtimeApiSource).map((property) => `runtime.${property}`);
}

function countRuntimeSurfaceMembers(paths: readonly string[]): {
  root: number;
  ports: number;
  lifecycle: number;
  total: number;
} {
  return {
    ports: paths.filter((path) =>
      ["runtime.tape", "runtime.kernel", "runtime.model"].includes(path),
    ).length,
    lifecycle: paths.filter((path) =>
      ["runtime.start", "runtime.turn", "runtime.close"].includes(path),
    ).length,
    root: paths.filter((path) => path.startsWith("runtime.")).length,
    total: paths.length,
  };
}

function assertRuntimeSurfaceBudget(paths: readonly string[]): {
  root: number;
  ports: number;
  lifecycle: number;
  total: number;
} {
  const counts = countRuntimeSurfaceMembers(paths);
  const violations: string[] = [];
  if (counts.root > RUNTIME_ROOT_MEMBER_BUDGET) {
    violations.push(
      `runtime root member count ${counts.root} exceeds budget ${RUNTIME_ROOT_MEMBER_BUDGET}`,
    );
  }
  if (violations.length > 0) {
    throw new Error(violations.join("; "));
  }
  return counts;
}

function collectRuntimeRootProperties(source: string): string[] {
  const lines = source.split("\n");
  const properties: string[] = [];
  let insideRuntimeInterface = false;

  for (const line of lines) {
    if (!insideRuntimeInterface) {
      if (!line.startsWith("export interface BrewvaRuntime ")) {
        continue;
      }
      insideRuntimeInterface = true;
      continue;
    }
    if (line.startsWith("}")) {
      break;
    }

    const match =
      /^  readonly ([a-zA-Z][a-zA-Z0-9_]*):/.exec(line) ??
      /^  ([a-zA-Z][a-zA-Z0-9_]*)\(/.exec(line);
    if (!match) continue;
    const property = match[1];
    if (property) {
      properties.push(property);
    }
  }

  return [...new Set(properties)].toSorted((left, right) => left.localeCompare(right));
}

function markdownList(values: readonly string[]): string {
  return values.map((value) => `- \`${value}\``).join("\n");
}

function renderToolsInventory(): string {
  const toolNames = collectDefinedToolNames();
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
  const counts = assertRuntimeSurfaceBudget(paths);
  const runtimeApiSource = readRepoFile("packages/brewva-runtime/src/runtime/runtime-api.ts");
  const canonicalEventCount =
    runtimeApiSource
      .match(/export const CANONICAL_EVENT_TYPES = \[([\s\S]*?)\] as const;/u)?.[1]
      ?.match(/"[^"]+"/gu)?.length ?? 0;
  if (canonicalEventCount > CANONICAL_EVENT_TYPE_BUDGET) {
    throw new Error(
      `canonical event type count ${canonicalEventCount} exceeds budget ${CANONICAL_EVENT_TYPE_BUDGET}`,
    );
  }
  return [
    "> Generated by `bun run docs:inventory`. Do not edit this block by hand.",
    "",
    `Runtime root member count: ${counts.root}. Public semantic ports: ${counts.ports}. Lifecycle methods: ${counts.lifecycle}.`,
    `Budget: root <= ${RUNTIME_ROOT_MEMBER_BUDGET}; canonical event types <= ${CANONICAL_EVENT_TYPE_BUDGET}.`,
    "",
    markdownList(paths),
  ].join("\n");
}

function renderCliFlags(): string {
  const cliSource = readRepoFile("packages/brewva-cli/src/entry/main.ts");
  const gatewaySource = readRepoFile("packages/brewva-gateway/src/admin/internal/cli.ts");
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
  const runtimeApiSource = readRepoFile("packages/brewva-runtime/src/runtime/runtime-api.ts");
  const canonicalEventTypes =
    runtimeApiSource
      .match(/export const CANONICAL_EVENT_TYPES = \[([\s\S]*?)\] as const;/u)?.[1]
      ?.match(/"[^"]+"/gu)
      ?.map((entry) => entry.slice(1, -1)) ?? [];
  return [
    "> Generated by `bun run docs:inventory`. Do not edit this block by hand.",
    "",
    `Canonical event type count: ${canonicalEventTypes.length}.`,
    "",
    markdownList(canonicalEventTypes),
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
