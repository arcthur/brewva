import type { TurnEnvelope, TurnPart } from "@brewva/brewva-vocabulary/wire";

export type BuildTurnEnvelopeInput = Partial<TurnEnvelope> & {
  readonly channelId?: string;
  readonly channel?: string;
  readonly conversationId?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly kind?: string;
  readonly parts?: readonly TurnPart[] | string;
};

function normalizeTurnParts(parts: readonly TurnPart[] | string | undefined): readonly TurnPart[] {
  if (typeof parts === "string") return [{ type: "text", text: parts }];
  return parts ?? [];
}

export function buildTurnEnvelope(input: BuildTurnEnvelopeInput): TurnEnvelope {
  const envelope = {
    schema: "brewva.turn.v1",
    channel: input.channel ?? input.channelId ?? "",
    conversationId: input.conversationId ?? "",
    sessionId: input.sessionId ?? "",
    turnId: input.turnId ?? "",
    kind: input.kind ?? "message",
    parts: normalizeTurnParts(input.parts),
    ...input,
  } satisfies TurnEnvelope;
  return Object.freeze(envelope);
}
