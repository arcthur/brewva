import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getModels, getProviders } from "@brewva/brewva-provider-core/catalog";
import {
  buildModelsDevCatalog,
  type GeneratedModelsCatalog,
  renderModelsGeneratedSource,
  type ModelsDevCatalog,
} from "./provider-model-catalog.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = resolve(
  repoRoot,
  "packages/brewva-provider-core/src/catalog/models.generated.ts",
);
const defaultModelsDevUrl = "https://models.dev/api.json";

function readRepoFile(path: string): string {
  return readFileSync(path, "utf-8");
}

function loadBaseCatalog(): GeneratedModelsCatalog {
  const catalog: Partial<GeneratedModelsCatalog> = {};
  for (const provider of getProviders()) {
    catalog[provider] = Object.fromEntries(getModels(provider).map((model) => [model.id, model]));
  }
  return catalog as GeneratedModelsCatalog;
}

async function loadModelsDevCatalog(inputPath: string | undefined): Promise<ModelsDevCatalog> {
  if (inputPath) {
    return JSON.parse(readRepoFile(resolve(repoRoot, inputPath))) as ModelsDevCatalog;
  }

  const response = await fetch(defaultModelsDevUrl);
  if (!response.ok) {
    throw new Error(
      `Unable to fetch ${defaultModelsDevUrl}: ${response.status} ${response.statusText}`,
    );
  }
  return (await response.json()) as ModelsDevCatalog;
}

function assertGeneratedCatalogIsUsable(source: ReturnType<typeof buildModelsDevCatalog>): void {
  const requiredProviders = [
    "anthropic",
    "openai",
    "openrouter",
    "moonshot-cn",
    "moonshot-ai",
  ] as const;
  const emptyProviders = requiredProviders.filter(
    (provider) => Object.keys(source[provider]).length === 0,
  );
  if (emptyProviders.length > 0) {
    throw new Error(
      `Refusing to generate an empty dynamic model catalog for: ${emptyProviders.join(", ")}`,
    );
  }

  if (Object.keys(source["openai-codex"]).length > 0) {
    throw new Error("OpenAI Codex OAuth models must stay derived from the OpenAI catalog.");
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      check: {
        type: "boolean",
      },
      input: {
        type: "string",
      },
      write: {
        type: "boolean",
      },
    },
  });

  if (!values.check && !values.write) {
    throw new Error("Pass --check or --write.");
  }
  if (values.check && values.write) {
    throw new Error("Pass only one of --check or --write.");
  }

  const modelsDevCatalog = await loadModelsDevCatalog(values.input);
  const generatedCatalog = buildModelsDevCatalog(modelsDevCatalog, loadBaseCatalog());
  assertGeneratedCatalogIsUsable(generatedCatalog);
  const nextSource = renderModelsGeneratedSource(generatedCatalog);

  if (values.check) {
    const currentSource = readRepoFile(catalogPath);
    if (currentSource !== nextSource) {
      throw new Error(
        "Provider model catalog is stale. Run `bun run models:catalog` to refresh it.",
      );
    }
    return;
  }

  writeFileSync(catalogPath, nextSource);
}

await main();
