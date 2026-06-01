import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

type Schema = Record<string, unknown>;

function stableStringify(value: unknown): string {
  const keyOrder = [
    "$schema",
    "$id",
    "$ref",
    "title",
    "description",
    "markdownDescription",
    "type",
    "additionalProperties",
    "properties",
    "required",
    "items",
    "enum",
    "oneOf",
    "anyOf",
    "allOf",
    "patternProperties",
    "definitions",
    "$defs",
  ];
  const keyPriority = new Map<string, number>(keyOrder.map((key, index) => [key, index]));
  const sortKeys = (keys: string[]): string[] =>
    keys.toSorted((a, b) => {
      const ai = keyPriority.get(a);
      const bi = keyPriority.get(b);
      if (ai !== undefined && bi !== undefined) return ai - bi;
      if (ai !== undefined) return -1;
      if (bi !== undefined) return 1;
      return a.localeCompare(b);
    });

  const normalize = (input: unknown): unknown => {
    if (!input || typeof input !== "object") return input;
    if (Array.isArray(input)) return input.map(normalize);

    const record = input as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of sortKeys(Object.keys(record))) {
      output[key] = normalize(record[key]);
    }
    return output;
  };

  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

function formatJsonSource(source: string, outputPath: string): string {
  const result = spawnSync("bunx", ["oxfmt", "--stdin-filepath", outputPath], {
    encoding: "utf8",
    input: source,
  });

  if (result.error) {
    throw new Error(`Unable to run oxfmt for generated schema: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = [result.stderr.trim(), result.stdout.trim()]
      .filter((part) => part.length > 0)
      .join("\n");
    throw new Error(
      `Generated schema formatting failed with exit code ${result.status}${
        details ? `\n${details}` : ""
      }`,
    );
  }

  return result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`;
}

async function buildSchemaSource(): Promise<{ outputPath: string; source: string }> {
  const require = createRequire(import.meta.url);
  const { createGenerator } =
    require("ts-json-schema-generator") as typeof import("ts-json-schema-generator");

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "..");
  const tsconfig = resolve(repoRoot, "packages/brewva-runtime/tsconfig.schema.json");
  const typesPath = resolve(repoRoot, "packages/brewva-runtime/src/config/types.ts");
  const outputPath = resolve(repoRoot, "packages/brewva-runtime/schema/brewva.schema.json");

  const schema = createGenerator({
    tsconfig,
    path: typesPath,
    type: "BrewvaConfigFile",
    expose: "export",
    jsDoc: "extended",
    additionalProperties: false,
    sortProps: true,
    topRef: true,
    skipTypeCheck: false,
  }).createSchema("BrewvaConfigFile") as Schema;

  schema.title = "brewva BrewvaConfigFile";
  schema.description = "JSON Schema for .brewva/brewva.json (Brewva config patch file).";

  return {
    outputPath,
    source: formatJsonSource(stableStringify(schema), outputPath),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      check: { type: "boolean", default: false },
      write: { type: "boolean", default: false },
    },
  });

  if (values.write === values.check) {
    throw new Error("Use exactly one mode: --write or --check.");
  }

  const { outputPath, source } = await buildSchemaSource();

  if (values.check) {
    const current = readFileSync(outputPath, "utf8");
    if (current !== source) {
      throw new Error("Brewva config schema is stale. Run `bun run generate:schema`.");
    }
    return;
  }

  const parent = dirname(outputPath);
  mkdirSync(parent, { recursive: true });
  writeFileSync(outputPath, source, "utf8");
}

await main();
