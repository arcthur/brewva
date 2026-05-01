import type { SkillValidationContext } from "../context.js";
import { normalizedIssuesToValidationIssues } from "../utils.js";
import { emptyValidationDelta, type SkillOutputValidator } from "../validator.js";

export class ConsumedOutputBlockingValidator implements SkillOutputValidator {
  readonly name = "consumed-output-blocking";

  appliesTo(context: SkillValidationContext): boolean {
    return context.consumedOutputView.issues.some(
      (issue) =>
        (issue.tier === "tier_a" || issue.tier === "tier_b") &&
        issue.blockingConsumer === context.skill.name,
    );
  }

  validate(context: SkillValidationContext) {
    const invalid = normalizedIssuesToValidationIssues(
      context.consumedOutputView.issues.filter(
        (issue) =>
          (issue.tier === "tier_a" || issue.tier === "tier_b") &&
          issue.blockingConsumer === context.skill.name,
      ),
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
