import type { ContextBudgetUsage } from "../contracts/index.js";
import type { RegisterContextInjectionInput } from "./injection.js";
import type { ContextInjectionCategory } from "./sources.js";

export interface ContextSourceProviderRegistration extends Omit<
  RegisterContextInjectionInput,
  "source" | "category"
> {}

export interface ContextSourceProviderInput {
  sessionId: string;
  promptText: string;
  usage?: ContextBudgetUsage;
  injectionScopeId?: string;
  register(input: ContextSourceProviderRegistration): void;
}

export interface ContextSourceProvider {
  readonly source: string;
  readonly category: ContextInjectionCategory;
  readonly order?: number;
  collect(input: ContextSourceProviderInput): void;
}

export interface ContextSourceProviderDescriptor {
  source: string;
  category: ContextInjectionCategory;
  order: number;
}

export class ContextSourceProviderRegistry {
  private readonly providers = new Map<string, ContextSourceProvider>();

  register(provider: ContextSourceProvider): void {
    const source = this.normalizeSource(provider.source);
    if (this.providers.has(source)) {
      throw new Error(`Context source provider already registered: ${source}`);
    }
    this.providers.set(source, provider);
  }

  unregister(source: string): boolean {
    return this.providers.delete(this.normalizeSource(source));
  }

  collect(input: {
    sessionId: string;
    promptText: string;
    usage?: ContextBudgetUsage;
    injectionScopeId?: string;
    register(input: RegisterContextInjectionInput): void;
  }): void {
    for (const provider of this.getProviders()) {
      provider.collect({
        sessionId: input.sessionId,
        promptText: input.promptText,
        usage: input.usage,
        injectionScopeId: input.injectionScopeId,
        register: (registration) =>
          input.register({
            ...registration,
            source: provider.source,
            category: provider.category,
          }),
      });
    }
  }

  list(): readonly ContextSourceProviderDescriptor[] {
    return this.getProviders().map((provider) => ({
      source: provider.source,
      category: provider.category,
      order: this.getProviderOrder(provider),
    }));
  }

  private getProviders(): ContextSourceProvider[] {
    return [...this.providers.values()].toSorted((left, right) => {
      const leftOrder = this.getProviderOrder(left);
      const rightOrder = this.getProviderOrder(right);
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      return left.source.localeCompare(right.source);
    });
  }

  private getProviderOrder(provider: ContextSourceProvider): number {
    const order = provider.order ?? 0;
    return Number.isFinite(order) ? Math.trunc(order) : 0;
  }

  private normalizeSource(source: string): string {
    const normalized = source.trim();
    if (!normalized) {
      throw new Error("Context source provider source must be non-empty");
    }
    if (normalized !== source) {
      throw new Error(`Context source provider source must be trimmed: ${source}`);
    }
    return normalized;
  }
}
