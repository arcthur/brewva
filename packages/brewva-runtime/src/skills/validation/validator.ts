import type {
  SkillOutputValidationIssue,
  SkillOutputValidationResult,
} from "../../contracts/index.js";
import type { SkillValidationContext } from "./context.js";

export interface SkillOutputValidationDelta {
  missing: string[];
  invalid: SkillOutputValidationIssue[];
}

export interface SkillOutputValidator {
  readonly name: string;
  appliesTo(context: SkillValidationContext): boolean;
  validate(context: SkillValidationContext): SkillOutputValidationDelta;
}

export function emptyValidationDelta(): SkillOutputValidationDelta {
  return {
    missing: [],
    invalid: [],
  };
}

export function okValidationResult(): SkillOutputValidationResult {
  return {
    ok: true,
    missing: [],
    invalid: [],
  };
}
