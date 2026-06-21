import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");

function readSource(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8");
}

function listSourceFiles(relativeDir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(resolve(repoRoot, relativeDir), { withFileTypes: true })) {
    const relativePath = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(relativePath));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      files.push(relativePath);
    }
  }
  return files;
}

// WS1 standing fitness (RFC "Wire Reality Is Quarantined Into Data"): model-era and
// vendor wire reality lives ONLY in the quirks module, so the catalog and the
// cache-capability resolver stay clean lookups. A new model or compatible vendor is
// a data change in one place, not a code change smeared across abstractions.

describe("catalog wire-reality quarantine (WS1 standing fitness)", () => {
  const catalogSource = readSource("packages/brewva-provider-core/src/catalog/index.ts");

  test("the catalog carries no model-era literals", () => {
    const forbidden: readonly RegExp[] = [
      /gpt-5\.\d/u, // version substrings (codex era / xhigh allowlist)
      /chatgpt\.com/u, // codex synthesis endpoint
      /backend-api/u, // codex synthesis endpoint
      /opus-4[.-]6/u, // xhigh allowlist
      /deepseek-v4/u, // xhigh allowlist
    ];
    const offenders = forbidden
      .filter((pattern) => pattern.test(catalogSource))
      .map((p) => p.source);
    expect(offenders).toEqual([]);
  });

  test("the catalog delegates model-era quirks to the quarantine module", () => {
    expect(catalogSource).toContain('from "../quirks/index.js"');
    expect(catalogSource).toContain("isCodexEligibleModelId");
    expect(catalogSource).toContain("synthesizeCodexModel");
    expect(catalogSource).toContain("modelSupportsXhigh");
  });
});

describe("cache-capability wire-reality quarantine (WS1 standing fitness)", () => {
  const capabilitySource = readSource("packages/brewva-provider-core/src/cache/capability.ts");

  test("the capability resolver carries no deployment literals", () => {
    const forbidden: readonly RegExp[] = [
      /api\.kimi\.com/u, // kimi route hostname
      /deepseek\.com/u, // deepseek route hostname
      /api\.openai\.com/u, // direct-openai host check
      /api\.anthropic\.com/u, // direct-anthropic host check
      /startsWith\("gpt-"\)/u, // openai prompt-cache-key model prefix
    ];
    const offenders = forbidden
      .filter((pattern) => pattern.test(capabilitySource))
      .map((p) => p.source);
    expect(offenders).toEqual([]);
  });

  test("the capability resolver keys on a deployment descriptor from the quarantine module", () => {
    expect(capabilitySource).toContain('from "../quirks/index.js"');
    expect(capabilitySource).toContain("DeploymentDescriptor");
    expect(capabilitySource).toContain("isKimiCodeRoute");
    expect(capabilitySource).toContain("isDeepSeekRoute");
    expect(capabilitySource).toContain("modelAdvertisesOpenAIPromptCacheKey");
  });
});

// The leak cannot recur by sneaking into a sibling file (e.g. a cache/render/* host
// check): wire-reality literals must live only in the quirks module across the whole
// catalog and cache trees. The generated model table is the data plane, not code,
// and is excluded.
describe("quarantine holds across the catalog and cache trees (WS1 standing fitness)", () => {
  test("no deployment or model-era literal is re-inlined outside the quirks module", () => {
    const forbidden: readonly RegExp[] = [
      /api\.kimi\.com/u,
      /\bdeepseek\.com/u,
      /api\.openai\.com/u,
      /api\.anthropic\.com/u,
      /chatgpt\.com/u,
      /backend-api/u,
      /gpt-5\.\d/u,
      /opus-4[.-]6/u,
      /deepseek-v4/u,
      /startsWith\("gpt-"\)/u,
    ];
    const scanned = [
      ...listSourceFiles("packages/brewva-provider-core/src/catalog"),
      ...listSourceFiles("packages/brewva-provider-core/src/cache"),
    ].filter((file) => !file.endsWith("models.generated.ts"));
    const offenders: string[] = [];
    for (const file of scanned) {
      const source = readFileSync(resolve(repoRoot, file), "utf-8");
      for (const pattern of forbidden) {
        if (pattern.test(source)) {
          offenders.push(`${file} :: /${pattern.source}/`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
