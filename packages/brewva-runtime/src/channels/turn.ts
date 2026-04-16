export type TurnKind = "user" | "assistant" | "tool" | "approval";
export const TURN_ENVELOPE_SCHEMA = "brewva.turn.v1";

export type TurnPart =
  | { type: "text"; text: string }
  | { type: "image"; uri: string; mimeType?: string }
  | { type: "file"; uri: string; name?: string; mimeType?: string };

export interface ApprovalAction {
  id: string;
  label: string;
  style?: "primary" | "neutral" | "danger";
}

export interface ApprovalPayload {
  requestId: string;
  title: string;
  detail?: string;
  actions: ApprovalAction[];
}

export interface TurnEnvelope {
  schema: typeof TURN_ENVELOPE_SCHEMA;
  kind: TurnKind;
  sessionId: string;
  turnId: string;
  channel: string;
  conversationId: string;
  messageId?: string;
  threadId?: string;
  timestamp: number;
  parts: TurnPart[];
  approval?: ApprovalPayload;
  meta?: Record<string, unknown>;
}

export type TurnEnvelopeCoerceResult =
  | {
      ok: true;
      envelope: TurnEnvelope;
    }
  | {
      ok: false;
      error: string;
    };

type TurnPartInput =
  | TurnPart
  | string
  | {
      type?: unknown;
      text?: unknown;
      content?: unknown;
      uri?: unknown;
      url?: unknown;
      src?: unknown;
      path?: unknown;
      name?: unknown;
      filename?: unknown;
      mimeType?: unknown;
      contentType?: unknown;
    };

export interface BuildTurnEnvelopeInput {
  kind: TurnKind;
  sessionId: string;
  turnId: string;
  channel: string;
  conversationId: string;
  messageId?: string;
  threadId?: string;
  timestamp?: number;
  parts: readonly TurnPartInput[];
  approval?: ApprovalPayload;
  meta?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeRequiredString(
  value: unknown,
  field: string,
  errors: string[],
): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    errors.push(`missing_${field}`);
    return undefined;
  }
  return normalized;
}

function normalizeApprovalAction(value: unknown): ApprovalAction | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = normalizeOptionalString(value.id);
  const label = normalizeOptionalString(value.label);
  if (!id || !label) {
    return undefined;
  }
  const style =
    value.style === "primary" || value.style === "neutral" || value.style === "danger"
      ? value.style
      : undefined;
  return style ? { id, label, style } : { id, label };
}

function normalizeApproval(value: unknown, errors: string[]): ApprovalPayload | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    errors.push("invalid_approval");
    return undefined;
  }
  const requestId = normalizeRequiredString(value.requestId, "approval.requestId", errors);
  const title = normalizeRequiredString(value.title, "approval.title", errors);
  const actions = Array.isArray(value.actions)
    ? value.actions
        .map((action) => normalizeApprovalAction(action))
        .filter((action): action is ApprovalAction => Boolean(action))
    : [];
  if (!requestId || !title || actions.length === 0) {
    errors.push("invalid_approval.actions");
    return undefined;
  }
  const detail = normalizeOptionalString(value.detail);
  return detail ? { requestId, title, detail, actions } : { requestId, title, actions };
}

function normalizeTextPart(value: TurnPartInput): TurnPart | undefined {
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 0 ? { type: "text", text } : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const text =
    normalizeOptionalString(candidate["text"]) ?? normalizeOptionalString(candidate["content"]);
  return text ? { type: "text", text } : undefined;
}

function normalizeUri(value: TurnPartInput): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  return (
    normalizeOptionalString(candidate["uri"]) ??
    normalizeOptionalString(candidate["url"]) ??
    normalizeOptionalString(candidate["src"]) ??
    normalizeOptionalString(candidate["path"])
  );
}

function normalizeTurnPart(value: TurnPartInput): TurnPart | undefined {
  if (typeof value === "string") {
    return normalizeTextPart(value);
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const type = normalizeOptionalString(candidate["type"]) ?? "text";
  if (type === "text") {
    return normalizeTextPart(candidate);
  }
  if (type === "image") {
    const uri = normalizeUri(candidate);
    if (!uri) {
      return undefined;
    }
    const mimeType =
      normalizeOptionalString(candidate["mimeType"]) ??
      normalizeOptionalString(candidate["contentType"]);
    return mimeType ? { type: "image", uri, mimeType } : { type: "image", uri };
  }
  if (type === "file") {
    const uri = normalizeUri(candidate);
    if (!uri) {
      return undefined;
    }
    const name =
      normalizeOptionalString(candidate["name"]) ?? normalizeOptionalString(candidate["filename"]);
    const mimeType =
      normalizeOptionalString(candidate["mimeType"]) ??
      normalizeOptionalString(candidate["contentType"]);
    return {
      type: "file",
      uri,
      ...(name ? { name } : {}),
      ...(mimeType ? { mimeType } : {}),
    };
  }
  return undefined;
}

export function normalizeTurnParts(value: unknown): TurnPart[] {
  if (Array.isArray(value)) {
    return value
      .map((part) => normalizeTurnPart(part))
      .filter((part): part is TurnPart => Boolean(part));
  }
  const normalized = normalizeTurnPart(value as TurnPartInput);
  return normalized ? [normalized] : [];
}

export function buildTurnEnvelope(input: BuildTurnEnvelopeInput): TurnEnvelope {
  const errors: string[] = [];
  const sessionId = normalizeRequiredString(input.sessionId, "sessionId", errors);
  const turnId = normalizeRequiredString(input.turnId, "turnId", errors);
  const channel = normalizeRequiredString(input.channel, "channel", errors);
  const conversationId = normalizeRequiredString(input.conversationId, "conversationId", errors);
  const parts = normalizeTurnParts(input.parts);
  if (parts.length === 0) {
    errors.push("missing_parts");
  }
  const approval = normalizeApproval(input.approval, errors);
  if (errors.length > 0 || !sessionId || !turnId || !channel || !conversationId) {
    throw new Error(`invalid_turn_envelope:${errors.join(",") || "unknown"}`);
  }
  const timestamp =
    typeof input.timestamp === "number" && Number.isFinite(input.timestamp)
      ? input.timestamp
      : Date.now();
  const messageId = normalizeOptionalString(input.messageId);
  const threadId = normalizeOptionalString(input.threadId);

  return {
    schema: TURN_ENVELOPE_SCHEMA,
    kind: input.kind,
    sessionId,
    turnId,
    channel,
    conversationId,
    ...(messageId ? { messageId } : {}),
    ...(threadId ? { threadId } : {}),
    timestamp,
    parts,
    ...(approval ? { approval } : {}),
    ...(input.meta && isRecord(input.meta) ? { meta: { ...input.meta } } : {}),
  };
}

export function coerceTurnEnvelope(input: unknown): TurnEnvelopeCoerceResult {
  if (!isRecord(input)) {
    return { ok: false, error: "invalid_turn_envelope:not_record" };
  }
  try {
    const envelope = buildTurnEnvelope({
      kind:
        input.kind === "user" ||
        input.kind === "assistant" ||
        input.kind === "tool" ||
        input.kind === "approval"
          ? input.kind
          : "user",
      sessionId: normalizeOptionalString(input["sessionId"]) ?? "",
      turnId: normalizeOptionalString(input["turnId"]) ?? "",
      channel: normalizeOptionalString(input["channel"]) ?? "",
      conversationId: normalizeOptionalString(input["conversationId"]) ?? "",
      messageId: normalizeOptionalString(input["messageId"]),
      threadId: normalizeOptionalString(input["threadId"]),
      timestamp:
        typeof input.timestamp === "number" && Number.isFinite(input.timestamp)
          ? input.timestamp
          : undefined,
      parts: normalizeTurnParts(input.parts ?? input.text),
      approval: input.approval as ApprovalPayload | undefined,
      meta: isRecord(input.meta) ? input.meta : undefined,
    });
    return { ok: true, envelope };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error && error.message.trim().length > 0
          ? error.message.trim()
          : "invalid_turn_envelope:unknown",
    };
  }
}

export function assertTurnEnvelope(value: unknown): TurnEnvelope {
  const result = coerceTurnEnvelope(value);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.envelope;
}
