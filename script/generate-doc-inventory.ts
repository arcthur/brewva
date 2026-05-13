import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { BREWVA_REGISTERED_EVENT_TYPES } from "@brewva/brewva-runtime/events";
import { MANAGED_BREWVA_TOOL_NAMES } from "@brewva/brewva-tools/registry";

type InventoryBlock = {
  name: string;
  path: string;
  content: string;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_SURFACE_MEMBER_BUDGET = 90;
const RUNTIME_INSPECT_SURFACE_MEMBER_BUDGET = 55;

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

function extractObjectBodyAt(source: string, bodyStart: number): string {
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) {
      return source.slice(bodyStart + 1, index);
    }
  }
  throw new Error("Unable to close object body");
}

function collectTopLevelObjectKeys(body: string): string[] {
  const keys = new Set<string>();
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;

  for (const line of body.split("\n")) {
    if (braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      const match = /^\s*([a-zA-Z][a-zA-Z0-9]*):/.exec(line);
      if (match?.[1]) {
        keys.add(match[1]);
      }
    }
    braceDepth += (line.match(/{/g) ?? []).length;
    braceDepth -= (line.match(/}/g) ?? []).length;
    bracketDepth += (line.match(/\[/g) ?? []).length;
    bracketDepth -= (line.match(/\]/g) ?? []).length;
    parenDepth += (line.match(/\(/g) ?? []).length;
    parenDepth -= (line.match(/\)/g) ?? []).length;
  }

  return [...keys].toSorted((left, right) => left.localeCompare(right));
}

function extractFunctionBody(source: string, functionName: string): string | undefined {
  const marker = `export function ${functionName}`;
  const start = source.indexOf(marker);
  if (start < 0) {
    return undefined;
  }
  const bodyStart = source.indexOf("{", start);
  return bodyStart >= 0 ? extractObjectBodyAt(source, bodyStart) : undefined;
}

function extractReturnedObjectBody(functionBody: string): string | undefined {
  const returnStart = functionBody.indexOf("return {");
  if (returnStart < 0) {
    return undefined;
  }
  const bodyStart = functionBody.indexOf("{", returnStart);
  return bodyStart >= 0 ? extractObjectBodyAt(functionBody, bodyStart) : undefined;
}

function extractObjectPropertyBody(body: string, propertyName: string): string | undefined {
  const match = new RegExp(`\\b${propertyName}:\\s*\\{`).exec(body);
  if (!match) {
    return undefined;
  }
  const bodyStart = body.indexOf("{", match.index);
  return bodyStart >= 0 ? extractObjectBodyAt(body, bodyStart) : undefined;
}

function collectDirectRuntimeSurfaceDefinitions(source: string): Array<{
  domainName: string;
  surfaceName: "authority" | "inspect" | "operator";
  methods: string[];
}> {
  const definitions: Array<{
    domainName: string;
    surfaceName: "authority" | "inspect" | "operator";
    methods: string[];
  }> = [];

  for (const match of source.matchAll(
    /export function create([A-Za-z][A-Za-z0-9]*)(Authority|Inspect|Operator)Surface\(/g,
  )) {
    const domainToken = match[1];
    const surfaceToken = match[2];
    if (!domainToken || !surfaceToken) {
      continue;
    }

    const functionName = `create${domainToken}${surfaceToken}Surface`;
    const functionBody = extractFunctionBody(source, functionName);
    if (!functionBody) {
      continue;
    }

    let objectBody = extractReturnedObjectBody(functionBody);
    const delegatedSurface =
      /return create[A-Za-z][A-Za-z0-9]*SurfaceMethods\(deps\)\.(authority|inspect|operator);/.exec(
        functionBody,
      )?.[1];
    if (delegatedSurface) {
      const surfaceMethodsName = `create${domainToken}SurfaceMethods`;
      const methodsBody = surfaceMethodsName
        ? extractFunctionBody(source, surfaceMethodsName)
        : undefined;
      const methodsObjectBody = methodsBody ? extractReturnedObjectBody(methodsBody) : undefined;
      objectBody = methodsObjectBody
        ? extractObjectPropertyBody(methodsObjectBody, delegatedSurface)
        : undefined;
    } else if (/return create[A-Za-z][A-Za-z0-9]*SurfaceMethods\(deps\);/.test(functionBody)) {
      const surfaceMethodsName = /create[A-Za-z][A-Za-z0-9]*SurfaceMethods/.exec(functionBody)?.[0];
      const methodsBody = surfaceMethodsName
        ? extractFunctionBody(source, surfaceMethodsName)
        : undefined;
      objectBody = methodsBody ? extractReturnedObjectBody(methodsBody) : undefined;
    }

    if (!objectBody) {
      continue;
    }

    const domainName = domainToken.charAt(0).toLowerCase() + domainToken.slice(1);
    definitions.push({
      domainName,
      surfaceName: surfaceToken.toLowerCase() as "authority" | "inspect" | "operator",
      methods: collectTopLevelObjectKeys(objectBody),
    });
  }

  return definitions;
}

function collectRuntimePortPaths(): string[] {
  const runtimeApiSource = readRepoFile("packages/brewva-runtime/src/runtime/runtime-api.ts");
  const paths = new Set<string>();
  const runtimeRoot = resolve(repoRoot, "packages/brewva-runtime/src/domain");

  for (const filePath of walkFiles(runtimeRoot, ".ts")) {
    const source = readFileSync(filePath, "utf-8");
    for (const definition of collectDirectRuntimeSurfaceDefinitions(source)) {
      for (const method of definition.methods) {
        paths.add(`${definition.surfaceName}.${definition.domainName}.${method}`);
      }
    }
  }

  for (const property of collectRuntimeRootProperties(runtimeApiSource)) {
    paths.add(`root.${property}`);
  }

  return [...paths].toSorted((left, right) => left.localeCompare(right));
}

function countRuntimeSurfaceMembers(paths: readonly string[]): {
  authority: number;
  inspect: number;
  operator: number;
  root: number;
  total: number;
} {
  return {
    authority: paths.filter((path) => path.startsWith("authority.")).length,
    inspect: paths.filter((path) => path.startsWith("inspect.")).length,
    operator: paths.filter((path) => path.startsWith("operator.")).length,
    root: paths.filter((path) => path.startsWith("root.")).length,
    total: paths.length,
  };
}

function assertRuntimeSurfaceBudget(paths: readonly string[]): {
  authority: number;
  inspect: number;
  operator: number;
  root: number;
  total: number;
} {
  const counts = countRuntimeSurfaceMembers(paths);
  const violations: string[] = [];
  if (counts.total > RUNTIME_SURFACE_MEMBER_BUDGET) {
    violations.push(
      `runtime surface member count ${counts.total} exceeds budget ${RUNTIME_SURFACE_MEMBER_BUDGET}`,
    );
  }
  if (counts.inspect > RUNTIME_INSPECT_SURFACE_MEMBER_BUDGET) {
    violations.push(
      `runtime inspect surface member count ${counts.inspect} exceeds budget ${RUNTIME_INSPECT_SURFACE_MEMBER_BUDGET}`,
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
  let insideRootInterface = false;

  for (const line of lines) {
    if (!insideRootInterface) {
      if (!line.startsWith("export interface BrewvaRuntimeRoot ")) {
        continue;
      }
      insideRootInterface = true;
      continue;
    }
    if (line.startsWith("}")) {
      break;
    }

    const match = /^  readonly ([a-zA-Z][a-zA-Z0-9_]*):/.exec(line);
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
  return [
    "> Generated by `bun run docs:inventory`. Do not edit this block by hand.",
    "",
    `Runtime surface member count: ${counts.total}. Root: ${counts.root}. Authority: ${counts.authority}. Inspect: ${counts.inspect}. Operator: ${counts.operator}.`,
    `Budget: total <= ${RUNTIME_SURFACE_MEMBER_BUDGET}; inspect <= ${RUNTIME_INSPECT_SURFACE_MEMBER_BUDGET}.`,
    "",
    markdownList(paths),
  ].join("\n");
}

function renderCliFlags(): string {
  const cliSource = readRepoFile("packages/brewva-cli/src/index.ts");
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
