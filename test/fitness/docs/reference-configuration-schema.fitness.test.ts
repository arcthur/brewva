import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";

type SchemaObject = Record<string, unknown>;

function getObject(value: unknown): SchemaObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as SchemaObject;
}

function requireObject(value: unknown, label: string): SchemaObject {
  const object = getObject(value);
  if (!object) {
    throw new Error(`${label} must be an object`);
  }
  return object;
}

function resolveSchemaRef(schema: SchemaObject, ref: unknown): SchemaObject | undefined {
  if (typeof ref !== "string" || !ref.startsWith("#/definitions/")) return undefined;
  const definitionKey = ref.slice("#/definitions/".length);
  return getObject(getObject(schema.definitions)?.[definitionKey]);
}

function resolveSchemaNode(schema: SchemaObject, value: unknown, label: string): SchemaObject {
  const direct = requireObject(value, label);
  return resolveSchemaRef(schema, direct.$ref) ?? direct;
}

describe("brewva config schema", () => {
  it("covers all top-level BrewvaConfig keys", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const schemaPath = resolve(repoRoot, "packages/brewva-runtime/schema/brewva.schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as SchemaObject;

    expect(typeof schema.$schema).toBe("string");
    expect(typeof schema.$ref).toBe("string");

    const definitions = requireObject(schema.definitions, "schema.definitions");
    const brewvaConfig =
      getObject(definitions?.BrewvaConfigFile) ?? getObject(definitions?.BrewvaConfig);

    const properties = requireObject(
      brewvaConfig?.properties,
      "schema.definitions.BrewvaConfig.properties",
    );

    const keys = Object.keys(DEFAULT_BREWVA_CONFIG);
    const missing = keys.filter((key) => !(key in (properties ?? {})));

    expect(
      missing,
      `Missing keys in packages/brewva-runtime/schema/brewva.schema.json: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("does not expose removed selector or continuity override config under skills", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const schemaPath = resolve(repoRoot, "packages/brewva-runtime/schema/brewva.schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as SchemaObject;
    const definitions = requireObject(schema.definitions, "schema.definitions");

    const brewvaConfig =
      getObject(definitions?.BrewvaConfigFile) ?? getObject(definitions?.BrewvaConfig);
    const brewvaConfigProperties = requireObject(
      brewvaConfig?.properties,
      "schema.definitions.BrewvaConfig.properties",
    );
    const skillsConfig = resolveSchemaNode(
      schema,
      brewvaConfigProperties.skills,
      "skills property",
    );
    const skillsProperties = requireObject(skillsConfig.properties, "skills properties");
    expect(Object.hasOwn(skillsProperties, "selector")).toBe(false);
    expect(Object.hasOwn(skillsProperties, "routing")).toBe(false);
    expect(Object.hasOwn(skillsProperties, "overrides")).toBe(false);

    const capabilitiesConfig = resolveSchemaNode(
      schema,
      brewvaConfigProperties.capabilities,
      "capabilities property",
    );
    const capabilitiesProperties = requireObject(
      capabilitiesConfig.properties,
      "capabilities properties",
    );
    expect(Object.hasOwn(capabilitiesProperties, "roots")).toBe(true);
    expect(Object.hasOwn(capabilitiesProperties, "defaults")).toBe(true);
    expect(Object.hasOwn(capabilitiesProperties, "policy")).toBe(true);
  });
});
