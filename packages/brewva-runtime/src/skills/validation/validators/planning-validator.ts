import {
  DESIGN_EXECUTION_MODE_HINTS,
  coerceDesignExecutionPlan,
  coerceDesignImplementationTargets,
  coerceDesignRiskRegister,
} from "../../../contracts/index.js";
import type { SkillValidationContext } from "../context.js";
import {
  PLANNING_SEMANTIC_OUTPUT_KEYS,
  annotateSemanticIssues,
  normalizeText,
  skillDeclaresAllOutputs,
} from "../utils.js";
import { emptyValidationDelta, type SkillOutputValidator } from "../validator.js";

function validatePlanningSemanticOutputs(
  outputs: Record<string, unknown>,
): Array<{ name: string; reason: string }> {
  const issues: Array<{ name: string; reason: string }> = [];
  if (
    Object.prototype.hasOwnProperty.call(outputs, "design_spec") &&
    normalizeText(outputs.design_spec) === null
  ) {
    issues.push({
      name: "design_spec",
      reason: "design_spec must be a non-empty string",
    });
  }
  if (
    Object.prototype.hasOwnProperty.call(outputs, "execution_plan") &&
    !coerceDesignExecutionPlan(outputs.execution_plan)
  ) {
    issues.push({
      name: "execution_plan",
      reason:
        "execution_plan must use the canonical plan-step shape with step, intent, owner, exit_criteria, and verification_intent",
    });
  }
  const executionModeHint = normalizeText(outputs.execution_mode_hint);
  if (
    Object.prototype.hasOwnProperty.call(outputs, "execution_mode_hint") &&
    (!executionModeHint ||
      !DESIGN_EXECUTION_MODE_HINTS.includes(
        executionModeHint as (typeof DESIGN_EXECUTION_MODE_HINTS)[number],
      ))
  ) {
    issues.push({
      name: "execution_mode_hint",
      reason: "execution_mode_hint must be one of direct_patch, test_first, or coordinated_rollout",
    });
  }
  if (
    Object.prototype.hasOwnProperty.call(outputs, "risk_register") &&
    !coerceDesignRiskRegister(outputs.risk_register)
  ) {
    issues.push({
      name: "risk_register",
      reason:
        "risk_register must use canonical planning risk items, including valid review categories and owner lanes",
    });
  }
  if (
    Object.prototype.hasOwnProperty.call(outputs, "implementation_targets") &&
    !coerceDesignImplementationTargets(outputs.implementation_targets)
  ) {
    issues.push({
      name: "implementation_targets",
      reason:
        "implementation_targets must use canonical target items with target, kind, owner_boundary, and reason",
    });
  }
  return issues;
}

export class PlanningOutputValidator implements SkillOutputValidator {
  readonly name = "planning";

  appliesTo(context: SkillValidationContext): boolean {
    return (
      [...context.semanticSchemaIds].some((schemaId) => schemaId.startsWith("planning.")) ||
      skillDeclaresAllOutputs(context.skill, PLANNING_SEMANTIC_OUTPUT_KEYS)
    );
  }

  validate(context: SkillValidationContext) {
    const invalid = annotateSemanticIssues(
      validatePlanningSemanticOutputs(context.outputs),
      context.semanticBindings,
    );
    if (invalid.length === 0) {
      return emptyValidationDelta();
    }
    return {
      missing: [],
      invalid,
    };
  }
}
