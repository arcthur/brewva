export type JsonSchema = Record<string, unknown>;

export interface ToolExecutionTraits {
  concurrencySafe: boolean;
  interruptBehavior: string;
  streamingEligible: boolean;
  contextModifying: boolean;
}

export interface ToolExecutionTraitResolverInput {
  toolName: string;
  args: unknown;
  cwd?: string | null;
}

export type ToolExecutionTraitsResolver = (
  input: ToolExecutionTraitResolverInput,
) => ToolExecutionTraits | Partial<ToolExecutionTraits> | undefined;

export type ToolExecutionTraitsDefinition = ToolExecutionTraits | ToolExecutionTraitsResolver;

export interface ToolDescriptor<TParameters extends JsonSchema = JsonSchema> {
  name: string;
  label: string;
  title?: string;
  description: string;
  parameters: TParameters;
  outputSchema?: JsonSchema;
  annotations?: Record<string, unknown>;
  promptSnippet?: string;
  promptGuidelines?: readonly string[];
  surface?: string;
  actionClass?: string;
  executionTraits?: ToolExecutionTraits;
  requiredCapabilities?: readonly string[];
}

export interface ToolCatalogEntry<TParameters extends JsonSchema = JsonSchema> {
  descriptor: ToolDescriptor<TParameters>;
  origin: "managed" | "dynamic" | "mcp";
  definition?: unknown;
}

export const DEFAULT_TOOL_EXECUTION_TRAITS: ToolExecutionTraits = {
  concurrencySafe: false,
  interruptBehavior: "terminate",
  streamingEligible: false,
  contextModifying: false,
};

export function resolveToolExecutionTraits(
  definition: ToolExecutionTraitsDefinition | undefined,
  input: ToolExecutionTraitResolverInput,
): ToolExecutionTraits {
  if (!definition) {
    return { ...DEFAULT_TOOL_EXECUTION_TRAITS };
  }
  if (typeof definition === "function") {
    return {
      ...DEFAULT_TOOL_EXECUTION_TRAITS,
      ...definition(input),
    };
  }
  return {
    ...DEFAULT_TOOL_EXECUTION_TRAITS,
    ...definition,
  };
}

export class ToolCatalog<TParameters extends JsonSchema = JsonSchema> {
  readonly #entries = new Map<string, ToolCatalogEntry<TParameters>>();

  upsert(entry: ToolCatalogEntry<TParameters>): this {
    this.#entries.set(entry.descriptor.name, entry);
    return this;
  }

  remove(name: string): boolean {
    return this.#entries.delete(name);
  }

  get(name: string): ToolCatalogEntry<TParameters> | undefined {
    return this.#entries.get(name);
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  list(): ToolCatalogEntry<TParameters>[] {
    return [...this.#entries.values()];
  }

  descriptors(): ToolDescriptor<TParameters>[] {
    return this.list().map((entry) => entry.descriptor);
  }

  snapshot(): ReadonlyMap<string, ToolCatalogEntry<TParameters>> {
    return new Map(this.#entries);
  }
}

export function createToolCatalog<TParameters extends JsonSchema = JsonSchema>(
  entries: Iterable<ToolCatalogEntry<TParameters>> = [],
): ToolCatalog<TParameters> {
  const catalog = new ToolCatalog<TParameters>();
  for (const entry of entries) {
    catalog.upsert(entry);
  }
  return catalog;
}
