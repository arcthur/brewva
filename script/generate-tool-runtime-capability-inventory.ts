import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const capabilityTypeSourcePath = resolve(
  repoRoot,
  "packages/brewva-tools/src/contracts/runtime-capabilities.ts",
);
const inventoryPath = resolve(
  repoRoot,
  "packages/brewva-tools/src/registry/runtime-capability-inventory.ts",
);

type PackageJson = {
  readonly name?: unknown;
  readonly exports?: unknown;
};

function toRepoPath(absolutePath: string): string {
  return relative(repoRoot, absolutePath).replaceAll("\\", "/");
}

function readBunSourceExport(exportValue: unknown): string | undefined {
  if (!exportValue || typeof exportValue !== "object") {
    return undefined;
  }
  const bunSource = (exportValue as { readonly bun?: unknown }).bun;
  return typeof bunSource === "string" && bunSource.endsWith(".ts") ? bunSource : undefined;
}

export function collectWorkspaceSourcePathMappings(): Record<string, string[]> {
  const packageMappings: Record<string, string[]> = {};
  const packagesRoot = resolve(repoRoot, "packages");

  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packageRoot = join(packagesRoot, entry.name);
    const packageJsonPath = join(packageRoot, "package.json");
    try {
      if (!statSync(packageJsonPath).isFile()) {
        continue;
      }
    } catch {
      continue;
    }

    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as PackageJson;
    if (typeof packageJson.name !== "string" || !packageJson.exports) {
      continue;
    }
    if (typeof packageJson.exports !== "object" || Array.isArray(packageJson.exports)) {
      continue;
    }

    for (const [exportPath, exportValue] of Object.entries(packageJson.exports)) {
      if (!exportPath.startsWith(".")) {
        continue;
      }
      const sourceExport = readBunSourceExport(exportValue);
      if (!sourceExport) {
        continue;
      }
      const importPath =
        exportPath === "." ? packageJson.name : `${packageJson.name}/${exportPath.slice(2)}`;
      packageMappings[importPath] = [toRepoPath(resolve(packageRoot, sourceExport))];
    }
  }

  return Object.fromEntries(
    Object.entries(packageMappings).toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function loadCompilerOptions(): ts.CompilerOptions {
  const configPath = resolve(repoRoot, "packages/brewva-tools/tsconfig.json");
  if (!configPath) {
    throw new Error("Unable to find brewva-tools tsconfig.json");
  }

  const config = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  }

  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
        .join("\n"),
    );
  }

  return {
    ...parsed.options,
    baseUrl: repoRoot,
    noEmit: true,
    paths: {
      ...parsed.options.paths,
      ...collectWorkspaceSourcePathMappings(),
    },
    rootDir: repoRoot,
  };
}

function findCapabilityTypeAlias(sourceFile: ts.SourceFile): ts.TypeAliasDeclaration {
  let alias: ts.TypeAliasDeclaration | undefined;
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === "BrewvaToolRequiredCapability") {
      alias = node;
    }
  });

  if (!alias) {
    throw new Error("Unable to find BrewvaToolRequiredCapability type alias");
  }
  return alias;
}

function collectStringLiteralUnionValues(checker: ts.TypeChecker, type: ts.Type): string[] {
  const values = new Set<string>();
  const unexpectedTypes: string[] = [];

  function visit(current: ts.Type): void {
    if (current.isUnion()) {
      for (const member of current.types) {
        visit(member);
      }
      return;
    }

    if (current.isStringLiteral()) {
      values.add(current.value);
      return;
    }

    unexpectedTypes.push(checker.typeToString(current));
  }

  visit(type);

  if (unexpectedTypes.length > 0) {
    throw new Error(
      `BrewvaToolRequiredCapability must resolve to string literals only; got ${unexpectedTypes.join(", ")}`,
    );
  }

  return [...values].toSorted((left, right) => left.localeCompare(right));
}

export function collectCapabilityPaths(): string[] {
  const program = ts.createProgram({
    rootNames: [capabilityTypeSourcePath],
    options: loadCompilerOptions(),
  });
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(capabilityTypeSourcePath);
  if (!sourceFile) {
    throw new Error("Unable to load Brewva tool metadata source file");
  }

  const alias = findCapabilityTypeAlias(sourceFile);
  const values = collectStringLiteralUnionValues(checker, checker.getTypeFromTypeNode(alias.type));
  if (values.length === 0) {
    throw new Error("BrewvaToolRequiredCapability resolved to an empty inventory");
  }

  const invalidPaths = values.filter(
    (value) => !value.startsWith("capabilities.") && !value.startsWith("extensions.tools."),
  );
  if (invalidPaths.length > 0) {
    throw new Error(
      `Brewva tool runtime capabilities include invalid namespaces: ${invalidPaths.join(", ")}`,
    );
  }

  const operatorPaths = values.filter(
    (value) =>
      value.startsWith("operator.") ||
      value.startsWith("authority.") ||
      value.startsWith("inspect."),
  );
  if (operatorPaths.length > 0) {
    throw new Error(
      `Brewva tool runtime capabilities must not include removed root paths: ${operatorPaths.join(", ")}`,
    );
  }

  return values;
}

function renderInventory(capabilities: readonly string[]): string {
  return [
    "import {",
    "  BREWVA_TOOL_RUNTIME_CAPABILITY_PATHS,",
    "  type BrewvaToolRequiredCapability,",
    '} from "../contracts/runtime-capabilities.js";',
    "",
    `// Generated by \`bun run tools:capability-inventory\`. Source owns ${capabilities.length} paths.`,
    "const BREWVA_TOOL_RUNTIME_CAPABILITY_PATH_SET = new Set<string>(",
    "  BREWVA_TOOL_RUNTIME_CAPABILITY_PATHS,",
    ");",
    "",
    "export { BREWVA_TOOL_RUNTIME_CAPABILITY_PATHS };",
    "",
    "export function isBrewvaToolRuntimeCapabilityPath(",
    "  capability: string,",
    "): capability is BrewvaToolRequiredCapability {",
    "  return BREWVA_TOOL_RUNTIME_CAPABILITY_PATH_SET.has(capability);",
    "}",
    "",
  ].join("\n");
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

  const generated = renderInventory(collectCapabilityPaths());
  const existing = readFileSync(inventoryPath, "utf-8");

  if (existing === generated) {
    if (values.write) {
      console.log("Tool runtime capability inventory is already up to date.");
    }
    return;
  }

  if (values.check) {
    console.error(
      [
        "Tool runtime capability inventory is stale.",
        "Run `bun run tools:capability-inventory`.",
        `- ${inventoryPath}`,
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  writeFileSync(inventoryPath, generated);
  console.log("Updated tool runtime capability inventory.");
}

if (import.meta.main) {
  main();
}
