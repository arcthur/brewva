import type {
  EffectCommitmentPosture,
  EffectPostureEvidenceSource,
  EffectPostureWarning,
  EffectRecoverability,
  EffectVisibility,
  ToolActionPolicy,
  ToolEffectClass,
  ToolReceiptPolicy,
  ToolRecoveryPolicy,
  ToolRecoveryPreparation,
} from "./types.js";

export interface EffectCommitmentExecutionEvidence {
  undoHandle?: string | null;
  externallyObserved?: boolean;
  credentialObserved?: boolean;
}

export interface DeriveEffectCommitmentPostureInput {
  effects: readonly ToolEffectClass[];
  receiptPolicy?: ToolReceiptPolicy;
  recoveryPolicy?: ToolRecoveryPolicy;
  recoveryPreparation?: ToolRecoveryPreparation;
  evidenceSources?: readonly EffectPostureEvidenceSource[];
  executionEvidence?: EffectCommitmentExecutionEvidence;
}

const OBSERVE_ONLY_EFFECTS = new Set<ToolEffectClass>(["workspace_read", "runtime_observe"]);

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function hasEffect(effects: readonly ToolEffectClass[], value: ToolEffectClass): boolean {
  return effects.includes(value);
}

function hasOnlyObserveEffects(effects: readonly ToolEffectClass[]): boolean {
  return effects.length > 0 && effects.every((effect) => OBSERVE_ONLY_EFFECTS.has(effect));
}

function warning(
  code: EffectPostureWarning["code"],
  message: string,
  evidenceSource?: EffectPostureEvidenceSource,
): EffectPostureWarning {
  return {
    code,
    message,
    ...(evidenceSource ? { evidenceSource } : {}),
  };
}

export function resolveRecoveryPreparationFromPolicy(
  recoveryPolicy: ToolRecoveryPolicy | undefined,
): ToolRecoveryPreparation {
  if (!recoveryPolicy || recoveryPolicy.kind === "none") {
    return "none";
  }
  if (recoveryPolicy.kind === "exact_patch") {
    return "workspace_patchset";
  }
  if (recoveryPolicy.kind === "compensation") {
    return "compensation";
  }
  return "manual";
}

export function resolveToolRecoveryPreparation(
  policy: Pick<ToolActionPolicy, "recoveryPolicy"> | ToolRecoveryPolicy | undefined,
): ToolRecoveryPreparation {
  if (!policy) {
    return "none";
  }
  if ("recoveryPolicy" in policy) {
    return resolveRecoveryPreparationFromPolicy(policy.recoveryPolicy);
  }
  return resolveRecoveryPreparationFromPolicy(policy);
}

function deriveVisibility(input: DeriveEffectCommitmentPostureInput): EffectVisibility {
  if (
    input.executionEvidence?.credentialObserved ||
    hasEffect(input.effects, "credential_access")
  ) {
    return "credential_sensitive";
  }
  if (
    input.executionEvidence?.externallyObserved ||
    hasEffect(input.effects, "external_network") ||
    hasEffect(input.effects, "external_side_effect") ||
    hasEffect(input.effects, "schedule_mutation")
  ) {
    return "externally_observable";
  }
  if (
    hasEffect(input.effects, "workspace_write") ||
    hasEffect(input.effects, "memory_write") ||
    hasEffect(input.effects, "control_state_mutation") ||
    hasEffect(input.effects, "budget_mutation")
  ) {
    return "workspace_visible";
  }
  return "local_only";
}

function mutableEffectsRequireManualRecovery(effects: readonly ToolEffectClass[]): boolean {
  return effects.some((effect) => !OBSERVE_ONLY_EFFECTS.has(effect));
}

function deriveBaseRecoverability(input: DeriveEffectCommitmentPostureInput): {
  recoverability: EffectRecoverability;
  warnings: EffectPostureWarning[];
} {
  const warnings: EffectPostureWarning[] = [];
  if (
    input.executionEvidence?.credentialObserved ||
    hasEffect(input.effects, "credential_access")
  ) {
    return {
      recoverability: "irreversible",
      warnings,
    };
  }
  if (hasOnlyObserveEffects(input.effects)) {
    return {
      recoverability: "observe_only",
      warnings,
    };
  }

  const recoveryPreparation =
    input.recoveryPreparation ?? resolveRecoveryPreparationFromPolicy(input.recoveryPolicy);
  if (recoveryPreparation === "workspace_patchset") {
    if (input.executionEvidence?.undoHandle) {
      return {
        recoverability: "reversible",
        warnings,
      };
    }
    warnings.push(
      warning(
        "reversible_requires_undo_handle",
        "Exact recovery requires a recorded undo handle.",
        "action_policy",
      ),
    );
    return {
      recoverability: "manual_recovery",
      warnings,
    };
  }
  if (recoveryPreparation === "compensation") {
    return {
      recoverability: "compensatable",
      warnings,
    };
  }
  if (recoveryPreparation === "manual") {
    return {
      recoverability: "manual_recovery",
      warnings,
    };
  }
  if (mutableEffectsRequireManualRecovery(input.effects)) {
    return {
      recoverability: "irreversible",
      warnings,
    };
  }
  warnings.push(
    warning("missing_effect_evidence", "No effect evidence was available for posture derivation."),
  );
  return {
    recoverability: "observe_only",
    warnings,
  };
}

export function deriveEffectCommitmentPosture(
  input: DeriveEffectCommitmentPostureInput,
): EffectCommitmentPosture {
  const visibility = deriveVisibility(input);
  const base = deriveBaseRecoverability(input);
  const warnings = [...base.warnings];
  let recoverability = base.recoverability;

  if (
    input.executionEvidence?.externallyObserved &&
    recoverability === "reversible" &&
    visibility === "externally_observable"
  ) {
    recoverability = "manual_recovery";
    warnings.push(
      warning(
        "external_evidence_overrode_reversible",
        "External execution evidence prevents presenting this effect as exactly reversible.",
        "execution_receipt",
      ),
    );
  }
  if (input.executionEvidence?.credentialObserved && visibility === "credential_sensitive") {
    warnings.push(
      warning(
        "credential_evidence_overrode_visibility",
        "Credential evidence makes this effect credential-sensitive.",
        "execution_receipt",
      ),
    );
  }

  return {
    recoverability,
    visibility,
    evidenceSources: unique(
      [
        ...(input.evidenceSources ?? []),
        input.executionEvidence ? "execution_receipt" : undefined,
        input.recoveryPolicy || input.receiptPolicy || input.recoveryPreparation
          ? "action_policy"
          : undefined,
      ].filter((source): source is EffectPostureEvidenceSource => Boolean(source)),
    ),
    warnings,
  };
}
