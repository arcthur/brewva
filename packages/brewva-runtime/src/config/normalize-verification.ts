import type { BrewvaConfig, VerificationLevel } from "../contracts/index.js";
import {
  type AnyRecord,
  isRecord,
  normalizeStringArray,
  normalizeStringRecord,
} from "./normalization-shared.js";

const VALID_VERIFICATION_LEVELS = new Set<VerificationLevel>(["quick", "standard", "strict"]);

function normalizeVerificationLevel(
  value: unknown,
  fallback: VerificationLevel,
): VerificationLevel {
  return VALID_VERIFICATION_LEVELS.has(value as VerificationLevel)
    ? (value as VerificationLevel)
    : fallback;
}

export function normalizeVerificationConfig(
  verificationInput: AnyRecord,
  defaults: BrewvaConfig["verification"],
): BrewvaConfig["verification"] {
  const verificationChecksInput = isRecord(verificationInput.checks)
    ? verificationInput.checks
    : {};

  return {
    defaultLevel: normalizeVerificationLevel(verificationInput.defaultLevel, defaults.defaultLevel),
    checks: {
      quick: normalizeStringArray(verificationChecksInput.quick, defaults.checks.quick),
      standard: normalizeStringArray(verificationChecksInput.standard, defaults.checks.standard),
      strict: normalizeStringArray(verificationChecksInput.strict, defaults.checks.strict),
    },
    commands: normalizeStringRecord(verificationInput.commands, defaults.commands),
  };
}
