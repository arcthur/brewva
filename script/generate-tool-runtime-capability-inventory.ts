import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeCapabilityTypeSourcePath = resolve(
  repoRoot,
  "packages/brewva-tools/src/contracts/runtime.ts",
);
const runtimeExtensionTypeSourcePath = resolve(
  repoRoot,
  "packages/brewva-tools/src/contracts/metadata.ts",
);
const inventoryPath = resolve(
  repoRoot,
  "packages/brewva-tools/src/registry/runtime-capability-inventory.ts",
);
const capabilityContractPath = resolve(
  repoRoot,
  "packages/brewva-tools/src/contracts/runtime-capabilities.ts",
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

function findExportedTypeDeclaration(
  sourceFile: ts.SourceFile,
  name: string,
): ts.InterfaceDeclaration | ts.TypeAliasDeclaration {
  let declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration | undefined;
  ts.forEachChild(sourceFile, (node) => {
    if (
      (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
      node.name.text === name
    ) {
      declaration = node;
    }
  });

  if (!declaration) {
    throw new Error(`Unable to find ${name} type declaration`);
  }
  return declaration;
}

function removeNullable(type: ts.Type): ts.Type[] {
  if (!type.isUnion()) {
    return [type];
  }
  return type.types.filter(
    (member) =>
      (member.flags & ts.TypeFlags.Undefined) === 0 && (member.flags & ts.TypeFlags.Null) === 0,
  );
}

function collectCallablePropertyPaths(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  type: ts.Type,
  prefix: string,
  paths: Set<string>,
  visited: Set<string>,
): void {
  const stableTypeId = `${prefix}:${checker.typeToString(type)}`;
  if (visited.has(stableTypeId)) {
    return;
  }
  visited.add(stableTypeId);

  for (const property of checker.getPropertiesOfType(type)) {
    const name = property.getName();
    if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(name)) {
      continue;
    }
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? sourceFile;
    const propertyPath = `${prefix}.${name}`;
    const propertyTypes = removeNullable(checker.getTypeOfSymbolAtLocation(property, declaration));

    if (propertyTypes.some((propertyType) => propertyType.getCallSignatures().length > 0)) {
      paths.add(propertyPath);
      continue;
    }

    for (const propertyType of propertyTypes) {
      if (checker.getPropertiesOfType(propertyType).length > 0) {
        collectCallablePropertyPaths(
          checker,
          sourceFile,
          propertyType,
          propertyPath,
          paths,
          visited,
        );
      }
    }
  }
}

function collectPathsFromType(input: {
  readonly program: ts.Program;
  readonly sourcePath: string;
  readonly typeName: string;
  readonly prefix: string;
}): string[] {
  const checker = input.program.getTypeChecker();
  const sourceFile = input.program.getSourceFile(input.sourcePath);
  if (!sourceFile) {
    throw new Error(`Unable to load ${toRepoPath(input.sourcePath)}`);
  }

  const declaration = findExportedTypeDeclaration(sourceFile, input.typeName);
  const type =
    ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration)
      ? checker.getTypeAtLocation(declaration.name)
      : checker.getTypeAtLocation(declaration);
  const paths = new Set<string>();
  collectCallablePropertyPaths(checker, sourceFile, type, input.prefix, paths, new Set<string>());
  return [...paths].toSorted((left, right) => left.localeCompare(right));
}

function createCapabilityProgram(): ts.Program {
  return ts.createProgram({
    rootNames: [runtimeCapabilityTypeSourcePath, runtimeExtensionTypeSourcePath],
    options: loadCompilerOptions(),
  });
}

function validateCapabilityPaths(values: readonly string[]): void {
  if (values.length === 0) {
    throw new Error("Brewva tool runtime capabilities resolved to an empty inventory");
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
}

export function collectCapabilityPaths(): string[] {
  const program = createCapabilityProgram();
  const values = [
    ...collectPathsFromType({
      program,
      sourcePath: runtimeCapabilityTypeSourcePath,
      typeName: "BrewvaToolRuntimeCapabilitiesPort",
      prefix: "capabilities",
    }),
    ...collectPathsFromType({
      program,
      sourcePath: runtimeExtensionTypeSourcePath,
      typeName: "BrewvaToolRuntimeToolsExtension",
      prefix: "extensions.tools",
    }),
  ].toSorted((left, right) => left.localeCompare(right));
  validateCapabilityPaths(values);
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

function renderCapabilityContract(capabilities: readonly string[]): string {
  return [
    "export const BREWVA_TOOL_RUNTIME_CAPABILITY_PATHS = Object.freeze([",
    ...capabilities.map((capability) => `  ${JSON.stringify(capability)},`),
    "] as const);",
    "",
    "// Generated by `bun run tools:capability-inventory` from `BrewvaToolRuntimeCapabilitiesPort` and explicit tools extensions.",
    "export type BrewvaToolRequiredCapability = (typeof BREWVA_TOOL_RUNTIME_CAPABILITY_PATHS)[number];",
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

  const capabilities = collectCapabilityPaths();
  const generated = renderInventory(capabilities);
  const generatedCapabilityContract = renderCapabilityContract(capabilities);
  const existing = readFileSync(inventoryPath, "utf-8");
  const existingCapabilityContract = readFileSync(capabilityContractPath, "utf-8");

  if (existing === generated && existingCapabilityContract === generatedCapabilityContract) {
    if (values.write) {
      console.log("Tool runtime capability inventory is already up to date.");
    }
    return;
  }

  if (values.check) {
    const stalePaths = [
      ...(existing === generated ? [] : [inventoryPath]),
      ...(existingCapabilityContract === generatedCapabilityContract
        ? []
        : [capabilityContractPath]),
    ];
    console.error(
      ["Tool runtime capability inventory is stale.", "Run `bun run tools:capability-inventory`."]
        .concat(stalePaths.map((path) => `- ${path}`))
        .join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  writeFileSync(inventoryPath, generated);
  writeFileSync(capabilityContractPath, generatedCapabilityContract);
  console.log("Updated tool runtime capability inventory.");
}

if (import.meta.main) {
  main();
}
