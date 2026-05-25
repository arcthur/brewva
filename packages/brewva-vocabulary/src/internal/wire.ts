import { type ContextStatusView } from "./context.js";
import { type BrewvaEventRecord } from "./events.js";
import { TURN_INPUT_RECORDED_EVENT_TYPE } from "./session.js";
import { UnknownRecord, isProtocolRecord } from "./shared.js";
import type { ProtocolRecord } from "./types/foundation.js";

export type { ProtocolRecord } from "./types/foundation.js";

export const TURN_ENVELOPE_SCHEMA = "brewva.turn.v1" as const;

export const SESSION_WIRE_SCHEMA = "brewva.session-wire.v2" as const;

export const CHANNEL_SESSION_BOUND_EVENT_TYPE = "channel.session.bound" as const;

export const CHANNEL_SESSION_CONVERSATION_BOUND_EVENT_TYPE =
  "channel.session.conversation.bound" as const;

export const OPERATOR_QUESTION_ANSWERED_EVENT_TYPE = "operator.question.answered" as const;

export const STEER_APPLIED_EVENT_TYPE = "steer.applied" as const;

export const STEER_DROPPED_EVENT_TYPE = "steer.dropped" as const;

export const STEER_QUEUED_EVENT_TYPE = "steer.queued" as const;

export interface ToolOutputDisplayView extends ProtocolRecord {
  summaryText?: string;
  detailsText?: string;
  rawText?: string;
}

export interface AssistantTextSegmentView extends ProtocolRecord {
  readonly text: string;
  readonly ts: number;
  readonly sequence?: number;
  readonly sourceEventId?: string;
}

export interface ToolOutputView extends ProtocolRecord {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly verdict: string;
  readonly isError: boolean;
  readonly text: string;
  readonly ts?: number;
  readonly sequence?: number;
  readonly sourceEventId?: string;
  readonly display?: ToolOutputDisplayView;
}

export type TurnPart =
  | ({
      readonly type: "text";
      readonly text: string;
      readonly uri?: string;
      readonly name?: string;
    } & Record<string, unknown>)
  | ({
      readonly type: string;
      readonly text?: string;
      readonly uri?: string;
      readonly name?: string;
    } & Record<string, unknown>);

export interface TurnEnvelope {
  readonly schema: typeof TURN_ENVELOPE_SCHEMA;
  readonly id?: string;
  readonly channelId?: string;
  readonly channel: string;
  readonly conversationId: string;
  readonly sessionId: string;
  readonly agentId?: string;
  readonly turnId: string;
  readonly threadId?: string;
  readonly timestamp?: number;
  readonly kind: TurnKind;
  readonly parts: readonly TurnPart[];
  readonly approval?: ApprovalPayload;
  readonly createdAt?: string;
  readonly meta?: ProtocolRecord & { readonly deliveryPlan?: TurnDeliveryPlan };
  readonly [key: string]: unknown;
}

export type TurnKind = string;

export interface ApprovalPayload {
  readonly requestId: string;
  readonly title: string;
  readonly detail?: string;
  readonly actions: Array<{ id: string; label: string; style?: string }>;
  readonly [key: string]: unknown;
}

export interface AdapterSendResult extends ProtocolRecord {
  readonly providerMessageId?: string | null;
}

export interface AdapterStartContext {
  readonly onTurn: (turn: TurnEnvelope) => Promise<void>;
}

export type BuildTurnEnvelopeInput = Partial<TurnEnvelope> & {
  readonly parts?: readonly TurnPart[];
};

export interface ChannelCapabilities extends ProtocolRecord {
  readonly streaming?: boolean;
  readonly inlineActions?: boolean;
  readonly codeBlocks?: boolean;
  readonly multiModal?: boolean;
  readonly threadedReplies?: boolean;
}

export interface ChannelCapabilityParams {
  readonly conversationId: string;
  readonly [key: string]: unknown;
}

export interface TurnStreamWriter {
  write(chunk: string): void;
}

export interface ChannelAdapter {
  readonly id?: string;
  readonly capabilities?: (params: ChannelCapabilityParams) => ChannelCapabilities;
  readonly start?: (context: AdapterStartContext) => unknown;
  readonly stop?: (context?: unknown) => unknown;
  readonly deliver?: (turn: TurnEnvelope) => AdapterSendResult | Promise<AdapterSendResult>;
  readonly sendTurn?: (turn: TurnEnvelope) => AdapterSendResult | Promise<AdapterSendResult>;
  readonly sendTurnStream?: (
    turn: TurnEnvelope,
    stream: TurnStreamWriter,
  ) => AdapterSendResult | Promise<AdapterSendResult>;
}

export interface ChannelTurnEmittedInput {
  readonly requestedTurn: TurnEnvelope;
  readonly deliveredTurn: TurnEnvelope;
  readonly result: AdapterSendResult;
}

export interface TurnBridgeHandlers {
  readonly deliver?: (...args: readonly unknown[]) => unknown;
  readonly sendTurn?: (...args: readonly unknown[]) => unknown;
  readonly start?: (...args: readonly unknown[]) => unknown;
  readonly stop?: (...args: readonly unknown[]) => unknown;
  readonly onInboundTurn?: (turn: TurnEnvelope) => unknown;
  readonly onAdapterError?: (error: unknown) => unknown;
  readonly onTurnEmitted?: (input: ChannelTurnEmittedInput) => void | Promise<void>;
  readonly onTurnIngested?: (turn: TurnEnvelope) => unknown;
  readonly onStreamChunk?: (turn: TurnEnvelope, chunk: string) => unknown;
  readonly [key: string]: unknown;
}

export interface TurnDeliveryPlan extends ProtocolRecord {
  readonly streamMode: "stream" | "buffered";
  readonly approvalMode: "inline" | "text" | "none";
  readonly codeBlockMode: "native" | "plain_text";
  readonly mediaMode: "native" | "link_only";
  readonly threadMode: "native" | "prepend_context";
}

export type TurnEnvelopeCoerceResult =
  | { readonly ok: true; readonly envelope: TurnEnvelope }
  | { readonly ok: false; readonly reason: string };

export const DEFAULT_CHANNEL_CAPABILITIES = Object.freeze({
  streaming: true,
  inlineActions: true,
  codeBlocks: true,
  multiModal: true,
  threadedReplies: true,
});

export interface ChannelAdapterRegistration {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly create: () => ChannelAdapter;
}

export class ChannelAdapterRegistry {
  private readonly registrations = new Map<string, ChannelAdapterRegistration>();
  private readonly aliases = new Map<string, string>();

  register(registration: ChannelAdapterRegistration): void {
    const id = normalizeChannelId(registration.id);
    if (!id) {
      throw new Error("adapter id is required");
    }
    if (this.registrations.has(id) || this.aliases.has(id)) {
      throw new Error(`adapter already registered: ${id}`);
    }
    for (const aliasValue of registration.aliases ?? []) {
      const alias = normalizeChannelId(aliasValue);
      if (!alias) continue;
      if (this.registrations.has(alias) || this.aliases.has(alias)) {
        throw new Error(`adapter already registered: ${alias}`);
      }
    }

    const normalizedAliases = (registration.aliases ?? [])
      .map(normalizeChannelId)
      .filter((alias): alias is string => alias.length > 0);
    this.registrations.set(id, { ...registration, id, aliases: normalizedAliases });
    for (const alias of normalizedAliases) {
      this.aliases.set(alias, id);
    }
  }

  unregister(id: string): boolean {
    const resolved = this.resolveId(id);
    if (!resolved) {
      return false;
    }
    const registration = this.registrations.get(resolved);
    this.registrations.delete(resolved);
    for (const alias of registration?.aliases ?? []) {
      this.aliases.delete(alias);
    }
    return true;
  }

  resolveId(id: string): string | undefined {
    const normalized = normalizeChannelId(id);
    if (this.registrations.has(normalized)) {
      return normalized;
    }
    return this.aliases.get(normalized);
  }

  createAdapter(id: string): ChannelAdapter | undefined {
    const resolved = this.resolveId(id);
    if (!resolved) {
      return undefined;
    }
    const registration = this.registrations.get(resolved);
    const adapter = registration?.create();
    if (!adapter) {
      return undefined;
    }
    const adapterId = normalizeChannelId((adapter as UnknownRecord).id);
    if (adapterId !== resolved) {
      throw new Error(`adapter id mismatch: expected ${resolved}, got ${adapterId}`);
    }
    return adapter;
  }

  get(id: string): ChannelAdapter | undefined {
    return this.createAdapter(id);
  }

  list(): readonly { readonly id: string }[] {
    return [...this.registrations.keys()].toSorted().map((id) => ({ id }));
  }
}

export class ChannelTurnBridge {
  readonly adapter?: ChannelAdapter;
  readonly handlers: TurnBridgeHandlers;
  #running = false;
  constructor(
    adapterOrHandlers: ChannelAdapter | TurnBridgeHandlers = {},
    handlers: TurnBridgeHandlers = {},
  ) {
    this.adapter =
      handlers && Object.keys(handlers).length > 0
        ? (adapterOrHandlers as ChannelAdapter)
        : undefined;
    this.handlers = this.adapter ? handlers : (adapterOrHandlers as TurnBridgeHandlers);
  }
  isRunning(): boolean {
    return this.#running;
  }

  async start(input?: unknown): Promise<unknown> {
    if (this.#running) {
      return { started: true };
    }
    const handler = (this.handlers as UnknownRecord).start;
    if (typeof handler === "function") {
      const result = await handler(input);
      this.#running = true;
      return result;
    }
    const context: AdapterStartContext = {
      ...(typeof input === "object" && input !== null ? (input as UnknownRecord) : {}),
      onTurn: async (turn: TurnEnvelope) => {
        await this.handlers.onInboundTurn?.(turn);
        await this.handlers.onTurnIngested?.(turn);
      },
    };
    const result =
      typeof this.adapter?.start === "function" ? await this.adapter.start(context) : undefined;
    this.#running = true;
    return result ?? { started: true };
  }
  async stop(input?: unknown): Promise<unknown> {
    if (!this.#running) {
      return { stopped: true };
    }
    const handler = (this.handlers as UnknownRecord).stop;
    if (typeof handler === "function") {
      const result = await handler(input);
      this.#running = false;
      return result;
    }
    const result =
      typeof this.adapter?.stop === "function" ? await this.adapter.stop(input) : undefined;
    this.#running = false;
    return result ?? { stopped: true };
  }
  async sendTurn(...args: unknown[]): Promise<AdapterSendResult> {
    const handler =
      (this.handlers as UnknownRecord).sendTurn ?? (this.handlers as UnknownRecord).deliver;
    if (typeof handler === "function") {
      const result = await handler(...args);
      return isProtocolRecord(result) ? result : { delivered: true };
    }
    const requestedTurn = args[0] as TurnEnvelope;
    const capabilities =
      this.adapter?.capabilities?.({ conversationId: requestedTurn.conversationId }) ??
      DEFAULT_CHANNEL_CAPABILITIES;
    const deliveredTurn = prepareTurnForDelivery(requestedTurn, capabilities);
    try {
      let result: AdapterSendResult;
      if (capabilities.streaming && typeof this.adapter?.sendTurnStream === "function") {
        result = await this.adapter.sendTurnStream(deliveredTurn, {
          write: (chunk: string) => {
            void this.handlers.onStreamChunk?.(deliveredTurn, chunk);
          },
        });
      } else if (typeof this.adapter?.sendTurn === "function") {
        result = await this.adapter.sendTurn(deliveredTurn);
      } else {
        result = { delivered: true };
      }
      await this.handlers.onTurnEmitted?.({ requestedTurn, deliveredTurn, result });
      return result;
    } catch (error) {
      await this.handlers.onAdapterError?.(error);
      throw error;
    }
  }
  async deliver(envelope: TurnEnvelope): Promise<AdapterSendResult> {
    const handler = (this.handlers as UnknownRecord).deliver;
    if (typeof handler === "function") {
      return await handler(envelope);
    }
    if (typeof this.adapter?.deliver === "function") {
      return await this.adapter.deliver(envelope);
    }
    return await this.sendTurn(envelope);
  }
}

export function normalizeChannelId(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function requireNonEmptyChannelToken(label: string, value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length === 0) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

export function buildRawConversationKey(input: {
  readonly channelId: string;
  readonly conversationId: string;
}): string {
  const channel = normalizeChannelId(requireNonEmptyChannelToken("channel", input.channelId));
  const conversationId = requireNonEmptyChannelToken("conversationId", input.conversationId);
  return `${channel}:${conversationId}`;
}

export function buildChannelSessionId(
  input: string | { readonly channelId: string; readonly conversationId: string },
  conversationId?: string,
): string {
  if (typeof input === "string" && conversationId !== undefined) {
    const channel = normalizeChannelId(requireNonEmptyChannelToken("channel", input));
    const normalizedConversationId = requireNonEmptyChannelToken("conversationId", conversationId);
    return `channel:${channel}:${normalizedConversationId}`;
  }
  if (typeof input === "string") return `channel:${requireNonEmptyChannelToken("channel", input)}`;
  return `channel:${buildRawConversationKey(input)}`;
}

export function buildChannelDedupeKey(input: unknown, ...parts: unknown[]): string {
  if (parts.length > 0) {
    const labels = ["channel", "conversationId", "messageId"];
    return [input, ...parts]
      .map((part, index) => requireNonEmptyChannelToken(labels[index] ?? "part", part))
      .join(":");
  }
  if (typeof input !== "object" || input === null) {
    return typeof input === "string" ? input : input == null ? "" : JSON.stringify(input);
  }
  const record = input as ProtocolRecord;
  return [record.channelId, record.conversationId, record.messageId, record.id]
    .filter(Boolean)
    .join(":");
}

export function normalizeTurnParts(
  parts: readonly TurnPart[] | string | undefined,
): readonly TurnPart[] {
  if (typeof parts === "string") return [{ type: "text", text: parts }];
  return parts ?? [];
}

function buildTurnEnvelope(input: BuildTurnEnvelopeInput, ..._rest: unknown[]): TurnEnvelope {
  const envelope = {
    schema: TURN_ENVELOPE_SCHEMA,
    channel: input.channel ?? input.channelId ?? "",
    conversationId: input.conversationId ?? "",
    sessionId: input.sessionId ?? "",
    turnId: input.turnId ?? "",
    kind: input.kind ?? "message",
    parts: normalizeTurnParts(input.parts),
    ...input,
  };
  return Object.freeze(envelope);
}

export function coerceTurnEnvelope(value: unknown, ..._rest: unknown[]): TurnEnvelopeCoerceResult {
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "invalid_turn_envelope:not_object" };
  }
  const candidate = value as ProtocolRecord;
  if (candidate.schema !== undefined && candidate.schema !== TURN_ENVELOPE_SCHEMA) {
    return { ok: false, reason: "invalid_turn_envelope:invalid_schema" };
  }
  const missing = ["sessionId", "turnId", "channel", "conversationId"].filter((key) => {
    const candidateValue = candidate[key];
    return typeof candidateValue !== "string" || candidateValue.trim().length === 0;
  });
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `invalid_turn_envelope:${missing.map((key) => `missing_${key}`).join(",")}`,
    };
  }
  return { ok: true, envelope: buildTurnEnvelope(candidate) };
}

export function assertTurnEnvelope(value: unknown): asserts value is TurnEnvelope {
  const result = coerceTurnEnvelope(value);
  if (!result.ok) throw new Error(result.reason);
}

function stripCodeFence(text: string): string {
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/u.exec(text.trim());
  return match?.[1] ?? text;
}

function textForLinkedPart(part: TurnPart): string {
  const label =
    part.type === "file" && typeof part.name === "string" && part.name.trim().length > 0
      ? `file (${part.name})`
      : part.type;
  return `[${label}] ${part.uri ?? ""}`.trim();
}

function approvalText(approval: ApprovalPayload | undefined): string | null {
  if (!approval) return null;
  const actions = approval.actions.map((action) => action.id).join(", ");
  return [
    approval.title,
    approval.detail,
    actions.length > 0 ? `Reply with one of: ${actions}` : undefined,
  ]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n");
}

export function prepareTurnForDelivery(
  envelope: TurnEnvelope,
  capabilities: ChannelCapabilities = DEFAULT_CHANNEL_CAPABILITIES,
): TurnEnvelope {
  const plan = resolveTurnDeliveryPlan(envelope, capabilities);
  const parts: TurnPart[] = [];
  for (const part of envelope.parts) {
    if (part.type === "text") {
      const text =
        plan.codeBlockMode === "plain_text" && typeof part.text === "string"
          ? stripCodeFence(part.text)
          : part.text;
      parts.push({ ...part, text });
      continue;
    }
    if ((part.type === "image" || part.type === "file") && plan.mediaMode === "link_only") {
      parts.push({ type: "text", text: textForLinkedPart(part) });
      continue;
    }
    parts.push(part);
  }
  if (plan.threadMode === "prepend_context" && envelope.threadId && parts[0]?.type === "text") {
    parts[0] = { ...parts[0], text: `[thread:${envelope.threadId}]\n${parts[0].text ?? ""}` };
  }
  if (plan.approvalMode === "text") {
    const text = approvalText(envelope.approval);
    if (text) {
      parts.push({ type: "text", text });
    }
  }
  return buildTurnEnvelope({
    ...envelope,
    parts,
    meta: {
      ...envelope.meta,
      deliveryPlan: plan,
    },
  });
}

export function resolveChannelCapabilities(input: ChannelCapabilities = {}): ChannelCapabilities {
  return Object.freeze({ ...DEFAULT_CHANNEL_CAPABILITIES, ...input });
}

export function resolveTurnDeliveryPlan(
  input: TurnEnvelope,
  capabilities: ChannelCapabilities = DEFAULT_CHANNEL_CAPABILITIES,
): TurnDeliveryPlan {
  const caps = resolveChannelCapabilities(capabilities);
  const approvalMode =
    input.approval || input.kind === "approval"
      ? caps.inlineActions === false
        ? "text"
        : "inline"
      : "none";
  return Object.freeze({
    streamMode: caps.streaming === false ? "buffered" : "stream",
    approvalMode,
    codeBlockMode: caps.codeBlocks === false ? "plain_text" : "native",
    mediaMode: caps.multiModal === false ? "link_only" : "native",
    threadMode: caps.threadedReplies === false ? "prepend_context" : "native",
  });
}

export type SessionWireSource = "live" | "replay";

export type SessionWireDurability = "cache" | "durable";

export type SessionWireStatusState =
  | "idle"
  | "running"
  | "waiting_approval"
  | "restarting"
  | "error"
  | "closed";

export interface SessionWireFrameBase extends ProtocolRecord {
  readonly schema: typeof SESSION_WIRE_SCHEMA;
  readonly sessionId: string;
  readonly frameId: string;
  readonly ts: number;
  readonly source: SessionWireSource;
  readonly durability: SessionWireDurability;
  readonly sourceEventId?: string;
  readonly sourceEventType?: string;
}

export type SessionWireFrame =
  | (SessionWireFrameBase & {
      readonly type: "replay.begin" | "replay.complete";
    })
  | (SessionWireFrameBase & {
      readonly type: "session.status";
      readonly state: SessionWireStatusState;
      readonly reason?: string;
      readonly detail?: string;
      readonly contextStatus?: ContextStatusView;
    })
  | (SessionWireFrameBase & {
      readonly type: "turn.input";
      readonly turnId: string;
      readonly promptText: string;
      readonly trigger: SessionWireTurnTrigger;
    })
  | (SessionWireFrameBase & {
      readonly type: "turn.transition";
      readonly turnId: string;
      readonly reason: string;
      readonly status: SessionWireTransitionStatus;
      readonly family: SessionWireTransitionFamily;
      readonly attempt?: number | null;
      readonly attemptId?: string;
      readonly error?: string;
    })
  | (SessionWireFrameBase & {
      readonly type: "attempt.started";
      readonly turnId: string;
      readonly attemptId: string;
      readonly reason: SessionWireAttemptReason;
    })
  | (SessionWireFrameBase & {
      readonly type: "attempt.superseded";
      readonly turnId: string;
      readonly attemptId: string;
      readonly supersededByAttemptId: string;
      readonly reason: SessionWireAttemptReason;
    })
  | (SessionWireFrameBase & {
      readonly type: "assistant.delta";
      readonly turnId: string;
      readonly attemptId: string;
      readonly lane: "answer" | "thinking";
      readonly delta: string;
    })
  | (SessionWireFrameBase & {
      readonly type: "tool.started";
      readonly turnId: string;
      readonly attemptId: string;
      readonly toolCallId: string;
      readonly toolName: string;
    })
  | (SessionWireFrameBase & {
      readonly type: "tool.progress" | "tool.finished";
      readonly turnId: string;
      readonly attemptId: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly verdict: string;
      readonly isError: boolean;
      readonly text: string;
      readonly display?: ToolOutputDisplayView;
    })
  | (SessionWireFrameBase & {
      readonly type: "turn.committed";
      readonly turnId: string;
      readonly attemptId: string;
      readonly status: SessionWireCommittedStatus;
      readonly assistantText: string;
      readonly assistantSegments?: readonly AssistantTextSegmentView[];
      readonly toolOutputs: readonly ToolOutputView[];
    })
  | (SessionWireFrameBase & {
      readonly type: "approval.requested";
      readonly turnId: string;
      readonly requestId: string;
      readonly toolName: string;
      readonly toolCallId: string;
      readonly subject: string;
      readonly detail?: string;
    })
  | (SessionWireFrameBase & {
      readonly type: "approval.decided";
      readonly turnId: string;
      readonly requestId: string;
      readonly decision: "approved" | "rejected";
      readonly actor?: string;
      readonly reason?: string;
    })
  | (SessionWireFrameBase & {
      readonly type: "session.closed";
      readonly reason?: string;
    });

export type SessionWireAttemptReason =
  | "initial"
  | "output_budget_escalation"
  | "compaction_retry"
  | "provider_fallback_retry"
  | "max_output_recovery";

export type SessionWireCommittedStatus = "completed" | "failed" | "cancelled";

export type SessionWireTransitionFamily = string;

export type SessionWireTransitionStatus = string;

export type SessionWireTurnTrigger = string;

export function compileSessionWireFrames(
  events: readonly BrewvaEventRecord[],
  ..._rest: unknown[]
): readonly SessionWireFrame[] {
  return events.flatMap((entry) => {
    if (entry.type !== TURN_INPUT_RECORDED_EVENT_TYPE) {
      return [];
    }
    return [
      Object.freeze({
        schema: SESSION_WIRE_SCHEMA,
        sessionId: entry.sessionId,
        frameId: `event:${entry.id}`,
        ts: entry.timestamp,
        source: "replay",
        durability: "durable",
        sourceEventId: entry.id,
        sourceEventType: entry.type,
        type: "turn.input" as const,
        turnId: entry.turnId ?? entry.id,
        promptText: typeof entry.payload === "string" ? entry.payload : "",
        trigger: "recovery" as const,
      }),
    ];
  });
}
