import type { ContextBudgetUsage } from "../contracts/index.js";
import type { RegisterContextInjectionInput } from "./injection.js";
import { HISTORY_VIEW_BASELINE_RESERVED_BUDGET_RATIO } from "./reserved-budget.js";
import type { ContextInjectionBudgetClass, ContextInjectionCategory } from "./sources.js";

export type ContextDependencyPlane =
  | "contract_core"
  | "history_view"
  | "working_state"
  | "advisory_recall";

export type ContextAdmissionLane = "primary_registry";
export type ContextReadDependencyId = string;
export type ContextPreservationPolicy = "truncatable" | "non_truncatable";
export type ContextAuthorityTier =
  | "operator_profile"
  | "runtime_contract"
  | "runtime_read_model"
  | "working_state"
  | "advisory_recall";

const CONTEXT_SOURCE_PROVIDER_BRAND: unique symbol = Symbol("brewva.contextSourceProvider");

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

export type ContextSourceProviderCollect = (
  input: ContextSourceProviderInput,
) => void | Promise<void>;

export interface ContextSourceProvider {
  readonly [CONTEXT_SOURCE_PROVIDER_BRAND]: true;
  readonly source: string;
  readonly plane: ContextDependencyPlane;
  readonly authorityTier: ContextAuthorityTier;
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
  collect: ContextSourceProviderCollect;
}

interface ContextSourceProviderCommonDefinition {
  readonly source: string;
  readonly collectionOrder: number;
  readonly selectionPriority?: number;
  readonly readsFrom: readonly ContextReadDependencyId[];
  readonly collect: ContextSourceProviderCollect;
}

export interface OperatorProfileContextSourceProviderDefinition extends ContextSourceProviderCommonDefinition {
  readonly kind: "operator_profile";
  readonly profileSelectable?: boolean;
}

export interface HistoryViewContextSourceProviderDefinition extends ContextSourceProviderCommonDefinition {
  readonly kind: "history_view";
}

export interface RuntimeContractStateContextSourceProviderDefinition extends ContextSourceProviderCommonDefinition {
  readonly kind: "runtime_contract_state";
  readonly category: ContextInjectionCategory;
  readonly profileSelectable?: boolean;
}

export interface RuntimeReadModelContextSourceProviderDefinition extends ContextSourceProviderCommonDefinition {
  readonly kind: "runtime_read_model";
  readonly category: ContextInjectionCategory;
  readonly budgetClass: Extract<ContextInjectionBudgetClass, "core" | "working">;
  readonly profileSelectable?: boolean;
}

export interface WorkingStateContextSourceProviderDefinition extends ContextSourceProviderCommonDefinition {
  readonly kind: "working_state";
  readonly category: ContextInjectionCategory;
  readonly continuityCritical?: boolean;
  readonly profileSelectable?: boolean;
}

export interface AdvisoryRecallContextSourceProviderDefinition extends ContextSourceProviderCommonDefinition {
  readonly kind: "advisory_recall";
  readonly profileSelectable?: boolean;
}

export type ContextSourceProviderDefinition =
  | OperatorProfileContextSourceProviderDefinition
  | HistoryViewContextSourceProviderDefinition
  | RuntimeContractStateContextSourceProviderDefinition
  | RuntimeReadModelContextSourceProviderDefinition
  | WorkingStateContextSourceProviderDefinition
  | AdvisoryRecallContextSourceProviderDefinition;

export interface ContextSourceProviderDescriptor {
  readonly source: string;
  readonly plane: ContextDependencyPlane;
  readonly authorityTier: ContextAuthorityTier;
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

export function defineContextSourceProvider(
  definition: ContextSourceProviderDefinition,
): ContextSourceProvider {
  const source = normalizeContextSourceProviderSource(definition.source);
  const collectionOrder = normalizeFiniteOrder(
    definition.collectionOrder,
    source,
    "collectionOrder",
  );
  const selectionPriority = normalizeFiniteOrder(
    definition.selectionPriority ?? definition.collectionOrder,
    source,
    "selectionPriority",
  );
  const readsFrom = normalizeReadsFrom(definition.readsFrom, source);
  const collect = normalizeCollect(definition.collect, source);
  const common = {
    [CONTEXT_SOURCE_PROVIDER_BRAND]: true as const,
    source,
    admissionLane: "primary_registry" as const,
    collectionOrder,
    selectionPriority,
    readsFrom,
    collect,
  };

  switch (definition.kind) {
    case "operator_profile":
      return freezeProvider({
        ...common,
        plane: "contract_core",
        authorityTier: "operator_profile",
        category: "narrative",
        budgetClass: "core",
        continuityCritical: false,
        profileSelectable: definition.profileSelectable ?? true,
        preservationPolicy: "truncatable",
      });
    case "history_view":
      return freezeProvider({
        ...common,
        plane: "history_view",
        authorityTier: "runtime_contract",
        category: "narrative",
        budgetClass: "core",
        continuityCritical: true,
        profileSelectable: true,
        preservationPolicy: "non_truncatable",
        reservedBudgetRatio: HISTORY_VIEW_BASELINE_RESERVED_BUDGET_RATIO,
      });
    case "runtime_contract_state":
      return freezeProvider({
        ...common,
        plane: "working_state",
        authorityTier: "runtime_contract",
        category: definition.category,
        budgetClass: "core",
        continuityCritical: false,
        profileSelectable: definition.profileSelectable ?? true,
        preservationPolicy: "truncatable",
      });
    case "runtime_read_model":
      return freezeProvider({
        ...common,
        plane: "working_state",
        authorityTier: "runtime_read_model",
        category: definition.category,
        budgetClass: definition.budgetClass,
        continuityCritical: false,
        profileSelectable: definition.profileSelectable ?? true,
        preservationPolicy: "truncatable",
      });
    case "working_state":
      return freezeProvider({
        ...common,
        plane: "working_state",
        authorityTier: "working_state",
        category: definition.category,
        budgetClass: "working",
        continuityCritical: definition.continuityCritical ?? false,
        profileSelectable: definition.profileSelectable ?? true,
        preservationPolicy: "truncatable",
      });
    case "advisory_recall":
      return freezeProvider({
        ...common,
        plane: "advisory_recall",
        authorityTier: "advisory_recall",
        category: "narrative",
        budgetClass: "recall",
        continuityCritical: false,
        profileSelectable: definition.profileSelectable ?? true,
        preservationPolicy: "truncatable",
      });
  }

  const exhaustive: never = definition;
  return exhaustive;
}

function freezeProvider(provider: ContextSourceProvider): ContextSourceProvider {
  Object.freeze(provider.readsFrom);
  return Object.freeze(provider);
}

export class ContextSourceProviderRegistry {
  private readonly providers = new Map<string, ContextSourceProvider>();

  register(provider: ContextSourceProvider): void {
    this.validateProviderObject(provider);
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

  async collect(input: {
    sessionId: string;
    promptText: string;
    usage?: ContextBudgetUsage;
    injectionScopeId?: string;
    referenceContextDigest?: string | null;
    sourceSelection?: ReadonlySet<string>;
    register(input: RegisterContextInjectionInput): void;
  }): Promise<void> {
    for (const provider of this.getProviders()) {
      if (input.sourceSelection && !input.sourceSelection.has(provider.source)) {
        continue;
      }
      await provider.collect({
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
      authorityTier: provider.authorityTier,
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

  private validateProviderObject(provider: ContextSourceProvider): void {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
      throw new Error("Context source provider must be an object");
    }
  }

  private validateProvider(provider: ContextSourceProvider): void {
    if (!isConstructedContextSourceProvider(provider)) {
      throw new Error(
        `Context source provider must be created with defineContextSourceProvider: ${provider.source}`,
      );
    }
    // Defense-in-depth for JavaScript callers or tests that copy the private
    // symbol brand onto a hand-authored provider object. Keep validating the
    // normalized fields after the brand check instead of trusting the object.
    if (provider.admissionLane !== "primary_registry") {
      throw new Error(
        `Context source provider admission lane must be primary_registry: ${provider.source}`,
      );
    }
    if (!this.isAuthorityTier(provider.authorityTier)) {
      throw new Error(`Context source provider authorityTier is invalid: ${provider.source}`);
    }
    this.validateProviderMatrix(provider);
    if (!Array.isArray(provider.readsFrom)) {
      throw new Error(`Context source provider readsFrom must be an array: ${provider.source}`);
    }
    for (const dependency of provider.readsFrom) {
      if (typeof dependency !== "string" || dependency.trim().length === 0) {
        throw new Error(
          `Context source provider readsFrom entries must be non-empty strings: ${provider.source}`,
        );
      }
      if (dependency !== dependency.trim()) {
        throw new Error(
          `Context source provider readsFrom entries must be trimmed: ${provider.source}`,
        );
      }
    }
    if (typeof provider.collect !== "function") {
      throw new Error(`Context source provider collect must be a function: ${provider.source}`);
    }
    if (!Number.isFinite(provider.collectionOrder)) {
      throw new Error(`Context source provider collectionOrder must be finite: ${provider.source}`);
    }
    if (!Number.isInteger(provider.collectionOrder)) {
      throw new Error(
        `Context source provider collectionOrder must be an integer: ${provider.source}`,
      );
    }
    if (!Number.isFinite(provider.selectionPriority)) {
      throw new Error(
        `Context source provider selectionPriority must be finite: ${provider.source}`,
      );
    }
    if (!Number.isInteger(provider.selectionPriority)) {
      throw new Error(
        `Context source provider selectionPriority must be an integer: ${provider.source}`,
      );
    }
    const ratio = provider.reservedBudgetRatio;
    if (ratio !== undefined && (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1)) {
      throw new Error(
        `Context source provider reservedBudgetRatio must be within (0, 1]: ${provider.source}`,
      );
    }
  }

  // Defense-in-depth for JavaScript callers or tests that copy the private
  // symbol brand onto a hand-authored provider object.
  private validateProviderMatrix(provider: ContextSourceProvider): void {
    if (provider.plane === "contract_core") {
      if (
        provider.authorityTier !== "operator_profile" ||
        provider.category !== "narrative" ||
        provider.budgetClass !== "core" ||
        provider.preservationPolicy !== "truncatable" ||
        provider.continuityCritical ||
        provider.reservedBudgetRatio !== undefined
      ) {
        throw new Error(
          `Contract-core context source provider has an invalid descriptor combination: ${provider.source}`,
        );
      }
      return;
    }

    if (provider.plane === "history_view") {
      if (
        provider.authorityTier !== "runtime_contract" ||
        provider.category !== "narrative" ||
        provider.budgetClass !== "core" ||
        provider.preservationPolicy !== "non_truncatable" ||
        !provider.continuityCritical ||
        !provider.profileSelectable ||
        provider.reservedBudgetRatio !== HISTORY_VIEW_BASELINE_RESERVED_BUDGET_RATIO
      ) {
        throw new Error(
          `History-view context source provider has an invalid descriptor combination: ${provider.source}`,
        );
      }
      return;
    }

    if (provider.plane === "working_state") {
      if (
        provider.preservationPolicy !== "truncatable" ||
        provider.reservedBudgetRatio !== undefined
      ) {
        throw new Error(
          `Working-state context source provider has an invalid preservation descriptor: ${provider.source}`,
        );
      }
      if (provider.authorityTier === "runtime_contract") {
        if (provider.budgetClass !== "core" || provider.continuityCritical) {
          throw new Error(
            `Runtime-contract working context source provider has an invalid descriptor combination: ${provider.source}`,
          );
        }
        return;
      }
      if (provider.authorityTier === "runtime_read_model") {
        if (
          (provider.budgetClass !== "core" && provider.budgetClass !== "working") ||
          provider.continuityCritical
        ) {
          throw new Error(
            `Runtime-read-model context source provider has an invalid descriptor combination: ${provider.source}`,
          );
        }
        return;
      }
      if (provider.authorityTier === "working_state") {
        // A working-state source may be continuity-critical because minimal
        // recovery profiles intentionally retain sources such as
        // brewva.recovery-working-set. Unlike runtime-contract and
        // runtime-read-model working sources, this tier represents current
        // working continuity rather than a stable contract/read-model plane.
        if (provider.budgetClass !== "working") {
          throw new Error(
            `Working-state context source provider must use working budget: ${provider.source}`,
          );
        }
        return;
      }
      throw new Error(
        `Working-state context source provider has an invalid authority tier: ${provider.source}`,
      );
    }

    if (provider.plane === "advisory_recall") {
      if (
        provider.authorityTier !== "advisory_recall" ||
        provider.category !== "narrative" ||
        provider.budgetClass !== "recall" ||
        provider.preservationPolicy !== "truncatable" ||
        provider.continuityCritical ||
        provider.reservedBudgetRatio !== undefined
      ) {
        throw new Error(
          `Advisory context source provider has an invalid descriptor combination: ${provider.source}`,
        );
      }
      return;
    }

    throw new Error(`Context source provider plane is invalid: ${provider.source}`);
  }

  private normalizeSource(source: string): string {
    return normalizeContextSourceProviderSource(source);
  }

  private isAuthorityTier(value: unknown): value is ContextAuthorityTier {
    return (
      value === "operator_profile" ||
      value === "runtime_contract" ||
      value === "runtime_read_model" ||
      value === "working_state" ||
      value === "advisory_recall"
    );
  }
}

function isConstructedContextSourceProvider(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  return (
    (value as Partial<Record<typeof CONTEXT_SOURCE_PROVIDER_BRAND, true>>)[
      CONTEXT_SOURCE_PROVIDER_BRAND
    ] === true
  );
}

function normalizeContextSourceProviderSource(source: unknown): string {
  if (typeof source !== "string") {
    throw new Error("Context source provider source must be a string");
  }
  const normalized = source.trim();
  if (!normalized) {
    throw new Error("Context source provider source must be non-empty");
  }
  if (normalized !== source) {
    throw new Error(`Context source provider source must be trimmed: ${source}`);
  }
  return normalized;
}

function normalizeFiniteOrder(value: number, source: string, field: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Context source provider ${field} must be finite: ${source}`);
  }
  if (!Number.isInteger(value)) {
    throw new Error(`Context source provider ${field} must be an integer: ${source}`);
  }
  return value;
}

function normalizeReadsFrom(
  readsFrom: readonly ContextReadDependencyId[],
  source: string,
): readonly ContextReadDependencyId[] {
  if (!Array.isArray(readsFrom)) {
    throw new Error(`Context source provider readsFrom must be an array: ${source}`);
  }
  for (const dependency of readsFrom) {
    if (typeof dependency !== "string" || dependency.trim().length === 0) {
      throw new Error(
        `Context source provider readsFrom entries must be non-empty strings: ${source}`,
      );
    }
    if (dependency !== dependency.trim()) {
      throw new Error(`Context source provider readsFrom entries must be trimmed: ${source}`);
    }
  }
  return [...readsFrom];
}

function normalizeCollect(
  collect: ContextSourceProviderCollect,
  source: string,
): ContextSourceProviderCollect {
  if (typeof collect !== "function") {
    throw new Error(`Context source provider collect must be a function: ${source}`);
  }
  return collect;
}
