import type { ContextBudgetUsage } from "../contracts/index.js";
import type { RegisterContextInjectionInput } from "./injection.js";
import type { ContextInjectionBudgetClass, ContextInjectionCategory } from "./sources.js";

export type ContextDependencyPlane =
  | "contract_core"
  | "history_view"
  | "working_state"
  | "advisory_recall";

export type ContextAdmissionLane = "primary_registry";
export type ContextReadDependencyId = string;
export type ContextPreservationPolicy = "truncatable" | "non_truncatable";

export interface ContextSourceProviderRegistration extends Omit<
  RegisterContextInjectionInput,
  | "source"
  | "category"
  | "budgetClass"
  | "selectionPriority"
  | "preservationPolicy"
  | "reservedBudgetRatio"
> {}

export interface ContextSourceProviderInput {
  sessionId: string;
  promptText: string;
  usage?: ContextBudgetUsage;
  injectionScopeId?: string;
  referenceContextDigest?: string | null;
  register(input: ContextSourceProviderRegistration): void;
}

export interface ContextSourceProvider {
  readonly source: string;
  readonly plane: ContextDependencyPlane;
  readonly admissionLane: ContextAdmissionLane;
  readonly category: ContextInjectionCategory;
  readonly budgetClass: ContextInjectionBudgetClass;
  readonly collectionOrder: number;
  readonly selectionPriority: number;
  readonly readsFrom: readonly ContextReadDependencyId[];
  readonly continuityCritical: boolean;
  readonly profileSelectable: boolean;
  readonly preservationPolicy: ContextPreservationPolicy;
  readonly reservedBudgetRatio?: number;
  collect(input: ContextSourceProviderInput): void;
}

export interface ContextSourceProviderDescriptor {
  readonly source: string;
  readonly plane: ContextDependencyPlane;
  readonly admissionLane: ContextAdmissionLane;
  readonly category: ContextInjectionCategory;
  readonly budgetClass: ContextInjectionBudgetClass;
  readonly collectionOrder: number;
  readonly selectionPriority: number;
  readonly readsFrom: readonly ContextReadDependencyId[];
  readonly continuityCritical: boolean;
  readonly profileSelectable: boolean;
  readonly preservationPolicy: ContextPreservationPolicy;
  readonly reservedBudgetRatio?: number;
}

export class ContextSourceProviderRegistry {
  private readonly providers = new Map<string, ContextSourceProvider>();

  register(provider: ContextSourceProvider): void {
    const source = this.normalizeSource(provider.source);
    this.validateProvider(provider);
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
    referenceContextDigest?: string | null;
    sourceSelection?: ReadonlySet<string>;
    register(input: RegisterContextInjectionInput): void;
  }): void {
    for (const provider of this.getProviders()) {
      if (input.sourceSelection && !input.sourceSelection.has(provider.source)) {
        continue;
      }
      provider.collect({
        sessionId: input.sessionId,
        promptText: input.promptText,
        usage: input.usage,
        injectionScopeId: input.injectionScopeId,
        referenceContextDigest: input.referenceContextDigest,
        register: (registration) =>
          input.register({
            ...registration,
            source: provider.source,
            category: provider.category,
            budgetClass: provider.budgetClass,
            selectionPriority: provider.selectionPriority,
            preservationPolicy: provider.preservationPolicy,
            reservedBudgetRatio: provider.reservedBudgetRatio,
          }),
      });
    }
  }

  list(): readonly ContextSourceProviderDescriptor[] {
    return this.getProviders().map((provider) => this.toDescriptor(provider));
  }

  private getProviders(): ContextSourceProvider[] {
    return [...this.providers.values()].toSorted((left, right) => {
      const leftOrder = this.getProviderCollectionOrder(left);
      const rightOrder = this.getProviderCollectionOrder(right);
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      return left.source.localeCompare(right.source);
    });
  }

  private getProviderCollectionOrder(provider: ContextSourceProvider): number {
    const order = provider.collectionOrder;
    return Number.isFinite(order) ? Math.trunc(order) : 0;
  }

  private getProviderSelectionPriority(provider: ContextSourceProvider): number {
    const priority = provider.selectionPriority;
    return Number.isFinite(priority) ? Math.trunc(priority) : 0;
  }

  private toDescriptor(provider: ContextSourceProvider): ContextSourceProviderDescriptor {
    return {
      source: provider.source,
      plane: provider.plane,
      admissionLane: provider.admissionLane,
      category: provider.category,
      budgetClass: provider.budgetClass,
      collectionOrder: this.getProviderCollectionOrder(provider),
      selectionPriority: this.getProviderSelectionPriority(provider),
      readsFrom: [...provider.readsFrom],
      continuityCritical: provider.continuityCritical,
      profileSelectable: provider.profileSelectable,
      preservationPolicy: provider.preservationPolicy,
      ...(provider.reservedBudgetRatio !== undefined
        ? { reservedBudgetRatio: provider.reservedBudgetRatio }
        : {}),
    };
  }

  private validateProvider(provider: ContextSourceProvider): void {
    if (provider.admissionLane !== "primary_registry") {
      throw new Error(
        `Context source provider admission lane must be primary_registry: ${provider.source}`,
      );
    }
    if (!Array.isArray(provider.readsFrom)) {
      throw new Error(`Context source provider readsFrom must be an array: ${provider.source}`);
    }
    if (!Number.isFinite(provider.collectionOrder)) {
      throw new Error(`Context source provider collectionOrder must be finite: ${provider.source}`);
    }
    if (!Number.isFinite(provider.selectionPriority)) {
      throw new Error(
        `Context source provider selectionPriority must be finite: ${provider.source}`,
      );
    }
    const ratio = provider.reservedBudgetRatio;
    if (ratio !== undefined && (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1)) {
      throw new Error(
        `Context source provider reservedBudgetRatio must be within (0, 1]: ${provider.source}`,
      );
    }
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
