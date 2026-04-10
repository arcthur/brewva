import type {
  SkillOutputValidationIssue,
  SkillOutputValidationResult,
} from "../../contracts/index.js";
import type { SkillValidationContext } from "./context.js";
import { okValidationResult, type SkillOutputValidator } from "./validator.js";

export class SkillOutputValidationPipeline {
  private readonly validators: readonly SkillOutputValidator[];

  constructor(validators: readonly SkillOutputValidator[]) {
    this.validators = [...validators];
  }

  validate(context: SkillValidationContext | undefined): SkillOutputValidationResult {
    if (!context) {
      return okValidationResult();
    }

    const missing: string[] = [];
    const invalid: SkillOutputValidationIssue[] = [];
    for (const validator of this.validators) {
      if (!validator.appliesTo(context)) {
        continue;
      }
      const result = validator.validate(context);
      missing.push(...result.missing);
      invalid.push(...result.invalid);
    }

    if (missing.length === 0 && invalid.length === 0) {
      return okValidationResult();
    }
    return {
      ok: false,
      missing,
      invalid,
    };
  }
}
