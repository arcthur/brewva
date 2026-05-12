import { resolve } from "node:path";
import {
  appendBrewvaEventRecordToLog,
  readBrewvaEventRecordsFromLogPath,
  resolveBrewvaEventLogPath,
} from "@brewva/brewva-runtime/event-log";
import { GATEWAY_SESSION_BOUND_EVENT_TYPE } from "@brewva/brewva-runtime/events";
import { readNonEmptyString } from "@brewva/brewva-std/text";
import { isRecord } from "@brewva/brewva-std/unknown";

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

function readGatewaySessionBindingPayload(value: unknown): GatewaySessionBindingPayload | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.schema !== "brewva.gateway-session-binding.v1") {
    return null;
  }
  const gatewaySessionId = readNonEmptyString(value.gatewaySessionId);
  const agentSessionId = readNonEmptyString(value.agentSessionId);
  const agentEventLogPath = readNonEmptyString(value.agentEventLogPath);
  if (!gatewaySessionId || !agentSessionId || !agentEventLogPath) {
    return null;
  }
  return {
    schema: "brewva.gateway-session-binding.v1",
    gatewaySessionId,
    agentSessionId,
    agentEventLogPath,
    cwd: readNonEmptyString(value.cwd),
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
  const cwd = readNonEmptyString(input.cwd);
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
