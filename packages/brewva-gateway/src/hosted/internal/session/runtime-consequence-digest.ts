import type {
  RenderTurnConsequenceDigestOptions,
  TurnEffectCommitmentProjection,
} from "@brewva/brewva-vocabulary/iteration";

type ProjectionInput = RenderTurnConsequenceDigestOptions & Partial<TurnEffectCommitmentProjection>;

export function deriveTurnEffectCommitmentProjection(
  input: ProjectionInput = {},
): TurnEffectCommitmentProjection {
  return {
    runtimeTurn: typeof input.runtimeTurn === "number" ? input.runtimeTurn : 0,
    ...(typeof input.turnId === "string" ? { turnId: input.turnId } : {}),
    declared: input.declared ?? [],
    attempted: input.attempted ?? [],
    decisions: input.decisions ?? [],
    executed: input.executed ?? [],
    recovery: input.recovery ?? [],
    warnings: input.warnings ?? [],
  };
}

export function renderTurnConsequenceDigest(input: ProjectionInput = {}): string {
  const projection = deriveTurnEffectCommitmentProjection(input);
  const digest = `runtimeTurn=${projection.runtimeTurn} declared=${projection.declared.length} attempted=${projection.attempted.length} decisions=${projection.decisions.length} executed=${projection.executed.length} recovery=${projection.recovery.length} warnings=${projection.warnings.length}`;
  const maxChars = typeof input.maxChars === "number" ? Math.max(0, Math.trunc(input.maxChars)) : 0;
  return maxChars > 0 && digest.length > maxChars ? digest.slice(0, maxChars) : digest;
}
