import { isRecord, normalizeNonEmptyString, normalizeStringArray } from "../../utils/coerce.js";
import type { TaskSpec } from "./types.js";

export function normalizeTaskSpec(input: TaskSpec): TaskSpec {
  const goal = input.goal.trim();
  const expectedBehavior = normalizeNonEmptyString(input.expectedBehavior);
  const constraints = normalizeStringArray(input.constraints);
  const files = normalizeStringArray(input.targets?.files);
  const symbols = normalizeStringArray(input.targets?.symbols);
  const verificationCommands = normalizeStringArray(input.verification?.commands);
  const acceptanceCriteria = normalizeStringArray(input.acceptance?.criteria);
  const acceptanceRequired =
    typeof input.acceptance?.required === "boolean"
      ? input.acceptance.required
      : Boolean(acceptanceCriteria);

  return {
    schema: "brewva.task.v1",
    goal,
    targets:
      files || symbols
        ? {
            files,
            symbols,
          }
        : undefined,
    expectedBehavior,
    constraints,
    verification: verificationCommands
      ? {
          commands: verificationCommands,
        }
      : undefined,
    acceptance:
      acceptanceRequired || acceptanceCriteria
        ? {
            required: acceptanceRequired || undefined,
            criteria: acceptanceCriteria,
          }
        : undefined,
  };
}

export function parseTaskSpec(
  input: unknown,
): { ok: true; spec: TaskSpec } | { ok: false; reason: string } {
  if (typeof input === "string") {
    const goal = input.trim();
    if (!goal) return { ok: false, reason: "TaskSpec goal must be a non-empty string." };
    return { ok: true, spec: { schema: "brewva.task.v1", goal } };
  }

  if (!isRecord(input)) {
    return { ok: false, reason: "TaskSpec must be an object." };
  }

  const schema = normalizeNonEmptyString(input.schema);
  if (schema && schema !== "brewva.task.v1") {
    return { ok: false, reason: `Unsupported TaskSpec schema: ${schema}` };
  }

  const goal = normalizeNonEmptyString(input.goal ?? input.prompt);
  if (!goal) {
    return { ok: false, reason: "TaskSpec goal must be a non-empty string." };
  }

  const targetsRaw = input.targets;
  const targets = isRecord(targetsRaw)
    ? {
        files: normalizeStringArray(targetsRaw.files),
        symbols: normalizeStringArray(targetsRaw.symbols),
      }
    : undefined;

  const verificationRaw = input.verification;
  if (isRecord(verificationRaw) && verificationRaw.level !== undefined) {
    return {
      ok: false,
      reason:
        "TaskSpec verification.level has been removed. Verification profile is skill-owned; use verification.commands only when you need explicit command checks.",
    };
  }
  const verification = isRecord(verificationRaw)
    ? {
        commands: normalizeStringArray(verificationRaw.commands),
      }
    : undefined;
  const acceptanceRaw = input.acceptance;
  if (isRecord(acceptanceRaw) && acceptanceRaw.owner !== undefined) {
    return {
      ok: false,
      reason:
        "TaskSpec acceptance.owner has been removed. Acceptance is always operator-owned when enabled.",
    };
  }
  const acceptance = isRecord(acceptanceRaw)
    ? {
        required: typeof acceptanceRaw.required === "boolean" ? acceptanceRaw.required : undefined,
        criteria: normalizeStringArray(acceptanceRaw.criteria),
      }
    : undefined;

  const spec: TaskSpec = normalizeTaskSpec({
    schema: "brewva.task.v1",
    goal,
    targets:
      targets?.files || targets?.symbols
        ? {
            files: targets.files,
            symbols: targets.symbols,
          }
        : undefined,
    expectedBehavior: normalizeNonEmptyString(input.expectedBehavior),
    constraints: normalizeStringArray(input.constraints),
    verification: verification?.commands
      ? {
          commands: verification.commands,
        }
      : undefined,
    acceptance:
      acceptance?.required !== undefined || acceptance?.criteria
        ? {
            required: acceptance.required,
            criteria: acceptance.criteria,
          }
        : undefined,
  });

  return { ok: true, spec };
}
