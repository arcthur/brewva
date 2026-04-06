import { resolve } from "node:path";
import { GATEWAY_SESSION_BOUND_EVENT_TYPE } from "@brewva/brewva-runtime";
import {
  readBrewvaEventRecordsFromLogPath,
  appendBrewvaEventRecordToLog,
  resolveBrewvaEventLogPath,
} from "@brewva/brewva-runtime/internal";

export const GATEWAY_SESSION_BINDING_CONTROL_SESSION_ID = "gateway:session-bindings" as const;

export interface GatewaySessionBindingPayload {
  schema: "brewva.gateway-session-binding.v1";
  gatewaySessionId: string;
  agentSessionId: string;
  agentEventLogPath: string;
  cwd?: string;
}

export interface GatewaySessionBindingReceipt {
  gatewaySessionId: string;
  agentSessionId: string;
  agentEventLogPath: string;
  cwd?: string;
  openedAt: number;
  eventId: string;
}

interface GatewaySessionBindingIndex {
  readonly receipts: GatewaySessionBindingReceipt[];
  readonly receiptsByGatewaySessionId: Map<string, GatewaySessionBindingReceipt[]>;
  readonly dedupeKeys: Set<string>;
}

const bindingIndexByLogPath = new Map<string, GatewaySessionBindingIndex>();
// Process-local index is a performance helper only. The control tape remains
// the durable source of truth for public-session replay lookup.

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readGatewaySessionBindingPayload(value: unknown): GatewaySessionBindingPayload | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.schema !== "brewva.gateway-session-binding.v1") {
    return null;
  }
  const gatewaySessionId = readString(value.gatewaySessionId);
  const agentSessionId = readString(value.agentSessionId);
  const agentEventLogPath = readString(value.agentEventLogPath);
  if (!gatewaySessionId || !agentSessionId || !agentEventLogPath) {
    return null;
  }
  return {
    schema: "brewva.gateway-session-binding.v1",
    gatewaySessionId,
    agentSessionId,
    agentEventLogPath,
    cwd: readString(value.cwd),
  };
}

function compareReceipts(
  left: GatewaySessionBindingReceipt,
  right: GatewaySessionBindingReceipt,
): number {
  return (
    left.openedAt - right.openedAt ||
    left.agentSessionId.localeCompare(right.agentSessionId) ||
    left.agentEventLogPath.localeCompare(right.agentEventLogPath) ||
    left.eventId.localeCompare(right.eventId)
  );
}

function buildDedupeKey(input: {
  gatewaySessionId: string;
  agentSessionId: string;
  agentEventLogPath: string;
}): string {
  return `${input.gatewaySessionId}::${input.agentSessionId}::${input.agentEventLogPath}`;
}

function addReceiptToIndex(
  index: GatewaySessionBindingIndex,
  receipt: GatewaySessionBindingReceipt,
): void {
  const dedupeKey = buildDedupeKey(receipt);
  if (index.dedupeKeys.has(dedupeKey)) {
    return;
  }
  index.dedupeKeys.add(dedupeKey);
  index.receipts.push(receipt);
  const sessionReceipts = index.receiptsByGatewaySessionId.get(receipt.gatewaySessionId) ?? [];
  sessionReceipts.push(receipt);
  index.receiptsByGatewaySessionId.set(receipt.gatewaySessionId, sessionReceipts);
}

function loadBindingIndex(bindingLogPath: string): GatewaySessionBindingIndex {
  const existing = bindingIndexByLogPath.get(bindingLogPath);
  if (existing) {
    return existing;
  }

  const index: GatewaySessionBindingIndex = {
    receipts: [],
    receiptsByGatewaySessionId: new Map(),
    dedupeKeys: new Set(),
  };
  for (const event of readBrewvaEventRecordsFromLogPath(bindingLogPath, {
    sessionId: GATEWAY_SESSION_BINDING_CONTROL_SESSION_ID,
  })) {
    if (event.type !== GATEWAY_SESSION_BOUND_EVENT_TYPE) {
      continue;
    }
    const payload = readGatewaySessionBindingPayload(event.payload);
    if (!payload) {
      continue;
    }
    addReceiptToIndex(index, {
      gatewaySessionId: payload.gatewaySessionId,
      agentSessionId: payload.agentSessionId,
      agentEventLogPath: payload.agentEventLogPath,
      cwd: payload.cwd,
      openedAt: event.timestamp,
      eventId: event.id,
    });
  }
  bindingIndexByLogPath.set(bindingLogPath, index);
  return index;
}

export function resolveGatewaySessionBindingLogPath(stateDir: string): string {
  return resolveBrewvaEventLogPath(
    resolve(stateDir, "event-tape"),
    GATEWAY_SESSION_BINDING_CONTROL_SESSION_ID,
  );
}

export function listGatewaySessionBindings(
  bindingLogPath: string,
  gatewaySessionId?: string,
): GatewaySessionBindingReceipt[] {
  const index = loadBindingIndex(bindingLogPath);
  const requestedGatewaySessionId =
    typeof gatewaySessionId === "string" && gatewaySessionId.trim().length > 0
      ? gatewaySessionId.trim()
      : undefined;

  const receipts = requestedGatewaySessionId
    ? (index.receiptsByGatewaySessionId.get(requestedGatewaySessionId) ?? [])
    : index.receipts;
  return receipts.toSorted(compareReceipts);
}

export function appendGatewaySessionBindingReceipt(
  bindingLogPath: string,
  input: {
    gatewaySessionId: string;
    agentSessionId: string;
    agentEventLogPath: string;
    cwd?: string;
    timestamp?: number;
  },
): void {
  const index = loadBindingIndex(bindingLogPath);
  const gatewaySessionId = input.gatewaySessionId.trim();
  const agentSessionId = input.agentSessionId.trim();
  const agentEventLogPath = input.agentEventLogPath.trim();
  const cwd = readString(input.cwd);
  if (!gatewaySessionId || !agentSessionId || !agentEventLogPath) {
    throw new Error(
      "gateway session binding receipt requires session, agent session, and log path",
    );
  }

  if (
    index.dedupeKeys.has(buildDedupeKey({ gatewaySessionId, agentSessionId, agentEventLogPath }))
  ) {
    return;
  }

  const row = appendBrewvaEventRecordToLog(bindingLogPath, {
    sessionId: GATEWAY_SESSION_BINDING_CONTROL_SESSION_ID,
    type: GATEWAY_SESSION_BOUND_EVENT_TYPE,
    timestamp: input.timestamp,
    payload: {
      schema: "brewva.gateway-session-binding.v1",
      gatewaySessionId,
      agentSessionId,
      agentEventLogPath,
      cwd,
    },
  });
  addReceiptToIndex(index, {
    gatewaySessionId,
    agentSessionId,
    agentEventLogPath,
    cwd,
    openedAt: row.timestamp,
    eventId: row.id,
  });
}
