import type { TaskAcceptanceOwner, TaskSpec, VerificationLevel } from "../contracts/index.js";
import { isRecord, normalizeNonEmptyString, normalizeStringArray } from "../utils/coerce.js";

export const TASK_SPEC_VERIFICATION_LEVEL_VALUES = ["quick", "standard", "strict", "none"] as const;

export type TaskSpecVerificationLevelInput = (typeof TASK_SPEC_VERIFICATION_LEVEL_VALUES)[number];

export const TASK_SPEC_VERIFICATION_LEVEL_ALIASES = {
  smoke: "quick",
  targeted: "standard",
  full: "strict",
  inspection: "none",
  investigate: "none",
  readonly: "none",
  read_only: "none",
  "read-only": "none",
} as const satisfies Readonly<Record<string, TaskSpecVerificationLevelInput>>;

export function normalizeTaskSpecVerificationLevel(value: unknown): VerificationLevel | undefined {
  if (typeof value !== "string") return undefined;
  const normalized =
    value in TASK_SPEC_VERIFICATION_LEVEL_ALIASES
      ? TASK_SPEC_VERIFICATION_LEVEL_ALIASES[
          value as keyof typeof TASK_SPEC_VERIFICATION_LEVEL_ALIASES
        ]
      : value;
  if (normalized === "quick" || normalized === "standard" || normalized === "strict") {
    return normalized;
  }
  return undefined;
}

export function normalizeTaskAcceptanceOwner(value: unknown): TaskAcceptanceOwner | undefined {
  const normalized = normalizeNonEmptyString(value);
  return normalized === "operator" ? "operator" : undefined;
}

export function normalizeTaskSpec(input: TaskSpec): TaskSpec {
  const goal = input.goal.trim();
  const expectedBehavior = normalizeNonEmptyString(input.expectedBehavior);
  const constraints = normalizeStringArray(input.constraints);
  const files = normalizeStringArray(input.targets?.files);
  const symbols = normalizeStringArray(input.targets?.symbols);
  const verificationLevel = normalizeTaskSpecVerificationLevel(input.verification?.level);
  const verificationCommands = normalizeStringArray(input.verification?.commands);
  const acceptanceOwner = normalizeTaskAcceptanceOwner(input.acceptance?.owner);
  const acceptanceCriteria = normalizeStringArray(input.acceptance?.criteria);
  const acceptanceRequired =
    typeof input.acceptance?.required === "boolean"
      ? input.acceptance.required
      : Boolean(acceptanceOwner || acceptanceCriteria);

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
    verification:
      verificationLevel || verificationCommands
        ? {
            level: verificationLevel,
            commands: verificationCommands,
          }
        : undefined,
    acceptance:
      acceptanceRequired || acceptanceOwner || acceptanceCriteria
        ? {
            required: acceptanceRequired || undefined,
            owner: acceptanceOwner,
            criteria: acceptanceCriteria,
          }
        : undefined,
  };
}

export function parseTaskSpec(
  input: unknown,
): { ok: true; spec: TaskSpec } | { ok: false; error: string } {
  if (typeof input === "string") {
    const goal = input.trim();
    if (!goal) return { ok: false, error: "TaskSpec goal must be a non-empty string." };
    return { ok: true, spec: { schema: "brewva.task.v1", goal } };
  }

  if (!isRecord(input)) {
    return { ok: false, error: "TaskSpec must be an object." };
  }

  const schema = normalizeNonEmptyString(input.schema);
  if (schema && schema !== "brewva.task.v1") {
    return { ok: false, error: `Unsupported TaskSpec schema: ${schema}` };
  }

  const goal = normalizeNonEmptyString(input.goal ?? input.prompt);
  if (!goal) {
    return { ok: false, error: "TaskSpec goal must be a non-empty string." };
  }

  const targetsRaw = input.targets;
  const targets = isRecord(targetsRaw)
    ? {
        files: normalizeStringArray(targetsRaw.files),
        symbols: normalizeStringArray(targetsRaw.symbols),
      }
    : undefined;

  const verificationRaw = input.verification;
  const verification = isRecord(verificationRaw)
    ? {
        level: normalizeTaskSpecVerificationLevel(verificationRaw.level),
        commands: normalizeStringArray(verificationRaw.commands),
      }
    : undefined;
  const acceptanceRaw = input.acceptance;
  const acceptance = isRecord(acceptanceRaw)
    ? {
        required: typeof acceptanceRaw.required === "boolean" ? acceptanceRaw.required : undefined,
        owner: normalizeTaskAcceptanceOwner(acceptanceRaw.owner),
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
    verification:
      verification?.level || verification?.commands
        ? {
            level: verification.level,
            commands: verification.commands,
          }
        : undefined,
    acceptance:
      acceptance?.required !== undefined || acceptance?.owner || acceptance?.criteria
        ? {
            required: acceptance.required,
            owner: acceptance.owner,
            criteria: acceptance.criteria,
          }
        : undefined,
  });

  return { ok: true, spec };
}
