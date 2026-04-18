import { collectActiveConfigFieldPolicyViolations } from "./field-policy.js";

export function collectExplicitBrewvaConfigSemanticErrors(value: unknown): string[] {
  return collectActiveConfigFieldPolicyViolations(value).map((violation) => violation.message);
}

export function assertExplicitBrewvaConfigSemantics(value: unknown): void {
  const errors = collectExplicitBrewvaConfigSemanticErrors(value);
  if (errors.length === 0) {
    return;
  }
  throw new Error(errors[0]);
}
