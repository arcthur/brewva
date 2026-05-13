import type {
  RenderTurnConsequenceDigestOptions,
  TurnEffectCommitmentProjection,
} from "./types.js";

const DEFAULT_MAX_DIGEST_CHARS = 1200;

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - 3)}...`;
}

function fitLines(lines: readonly string[], maxChars: number): string {
  const selected: string[] = [];
  let length = 0;
  for (const line of lines) {
    const nextLength = length + (selected.length > 0 ? 1 : 0) + line.length;
    if (nextLength > maxChars) {
      selected.push("truncated=true");
      return truncate(selected.join("\n"), maxChars);
    }
    selected.push(line);
    length = nextLength;
  }
  return selected.join("\n");
}

export function renderTurnConsequenceDigest(
  projection: TurnEffectCommitmentProjection,
  options: RenderTurnConsequenceDigestOptions = {},
): string {
  const maxChars = Math.max(120, Math.floor(options.maxChars ?? DEFAULT_MAX_DIGEST_CHARS));
  const lines = [
    "[TurnConsequenceDigest]",
    `session_id=${projection.sessionId}`,
    `turn_id=${projection.turnId}`,
    `runtime_turn=${projection.runtimeTurn}`,
  ];

  if (
    projection.executed.length === 0 &&
    projection.decisions.length === 0 &&
    projection.prepared.length === 0
  ) {
    lines.push("effects=none_recorded");
  }

  for (const decision of projection.decisions.filter((entry) => entry.decision !== "allow")) {
    lines.push(
      [
        `decision tool=${decision.toolName}`,
        `decision=${decision.decision}`,
        `effects=${decision.effects.join("|") || "none"}`,
        `recoverability=${decision.recoverability}`,
        `visibility=${decision.visibility}`,
        decision.reason ? `reason=${decision.reason}` : undefined,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" ; "),
    );
  }

  for (const recovery of projection.recovery) {
    lines.push(
      [
        `recovery kind=${recovery.kind}`,
        `status=${recovery.status}`,
        `receipt=${recovery.receiptId}`,
        recovery.toolName ? `tool=${recovery.toolName}` : undefined,
        recovery.reason ? `reason=${recovery.reason}` : undefined,
        recovery.patchSetId ? `patch_set=${recovery.patchSetId}` : undefined,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" ; "),
    );
  }

  for (const warning of projection.warnings) {
    lines.push(
      [
        `classification=${warning.code}`,
        warning.toolName ? `tool=${warning.toolName}` : undefined,
        warning.receiptId ? `receipt=${warning.receiptId}` : undefined,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" ; "),
    );
  }

  for (const execution of projection.executed) {
    lines.push(
      [
        `executed tool=${execution.toolName}`,
        `effects=${execution.effects.join("|") || "none"}`,
        `recoverability=${execution.recoverability}`,
        `visibility=${execution.visibility}`,
        `recovery_preparation=${execution.recoveryPreparation}`,
        `rollback_available=${execution.rollbackAvailable ? "true" : "false"}`,
        `source=${execution.source}`,
        execution.receiptId ? `receipt=${execution.receiptId}` : undefined,
        execution.ledgerId ? `ledger=${execution.ledgerId}` : undefined,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" ; "),
    );
  }

  for (const preparation of projection.prepared) {
    lines.push(
      [
        `prepared tool=${preparation.toolName}`,
        `effects=${preparation.effects.join("|") || "none"}`,
        `recovery_preparation=${preparation.recoveryPreparation}`,
        `recoverability=${preparation.recoverability}`,
        `visibility=${preparation.visibility}`,
        `receipt=${preparation.receiptId}`,
      ].join(" ; "),
    );
  }

  for (const transition of projection.turnTransitions) {
    lines.push(
      [
        `turn_transition reason=${transition.reason}`,
        `status=${transition.status}`,
        `family=${transition.family}`,
      ].join(" ; "),
    );
  }

  return fitLines(lines, maxChars);
}
