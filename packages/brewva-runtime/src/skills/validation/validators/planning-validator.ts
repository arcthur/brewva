import type { SkillValidationContext } from "../context.js";
import { normalizedIssuesToValidationIssues } from "../utils.js";
import { emptyValidationDelta, type SkillOutputValidator } from "../validator.js";

export class PlanningOutputValidator implements SkillOutputValidator {
  readonly name = "planning";

  appliesTo(context: SkillValidationContext): boolean {
    return context.semanticSchemaIds.size > 0;
  }

  validate(context: SkillValidationContext) {
    const invalid = normalizedIssuesToValidationIssues(
      context.normalizedOutputs.issues.filter((issue) => issue.tier === "tier_a"),
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
