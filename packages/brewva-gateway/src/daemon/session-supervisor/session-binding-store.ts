import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readNonEmptyString } from "@brewva/brewva-std/text";
import { isRecord } from "@brewva/brewva-std/unknown";

export interface GatewaySessionBindingReceipt {
  gatewaySessionId: string;
  agentSessionId: string;
  cwd?: string;
  openedAt: number;
}

interface GatewaySessionBindingFile {
  schema: "brewva.gateway-session-bindings.v2";
  receipts: GatewaySessionBindingReceipt[];
}

interface GatewaySessionBindingIndex {
  readonly receipts: GatewaySessionBindingReceipt[];
  readonly receiptsByGatewaySessionId: Map<string, GatewaySessionBindingReceipt[]>;
  readonly dedupeKeys: Set<string>;
}

const bindingIndexByPath = new Map<string, GatewaySessionBindingIndex>();

function compareReceipts(
  left: GatewaySessionBindingReceipt,
  right: GatewaySessionBindingReceipt,
): number {
  return (
    left.openedAt - right.openedAt ||
    left.agentSessionId.localeCompare(right.agentSessionId) ||
    (left.cwd ?? "").localeCompare(right.cwd ?? "")
  );
}

function buildDedupeKey(input: {
  gatewaySessionId: string;
  agentSessionId: string;
  cwd?: string;
}): string {
  return `${input.gatewaySessionId}::${input.agentSessionId}::${input.cwd ?? ""}`;
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

function readReceipt(value: unknown): GatewaySessionBindingReceipt | null {
  if (!isRecord(value)) {
    return null;
  }
  const gatewaySessionId = readNonEmptyString(value.gatewaySessionId);
  const agentSessionId = readNonEmptyString(value.agentSessionId);
  const openedAt =
    typeof value.openedAt === "number" && Number.isFinite(value.openedAt) ? value.openedAt : null;
  if (!gatewaySessionId || !agentSessionId || openedAt === null) {
    return null;
  }
  return {
    gatewaySessionId,
    agentSessionId,
    cwd: readNonEmptyString(value.cwd),
    openedAt,
  };
}

function readBindingFile(path: string): GatewaySessionBindingFile {
  if (!existsSync(path)) {
    return {
      schema: "brewva.gateway-session-bindings.v2",
      receipts: [],
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.schema !== "brewva.gateway-session-bindings.v2") {
      return {
        schema: "brewva.gateway-session-bindings.v2",
        receipts: [],
      };
    }
    const receipts = Array.isArray(parsed.receipts)
      ? parsed.receipts.flatMap((entry) => {
          const receipt = readReceipt(entry);
          return receipt ? [receipt] : [];
        })
      : [];
    return {
      schema: "brewva.gateway-session-bindings.v2",
      receipts,
    };
  } catch {
    return {
      schema: "brewva.gateway-session-bindings.v2",
      receipts: [],
    };
  }
}

function writeBindingFile(path: string, file: GatewaySessionBindingFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

function loadBindingIndex(path: string): GatewaySessionBindingIndex {
  const existing = bindingIndexByPath.get(path);
  if (existing) {
    return existing;
  }

  const index: GatewaySessionBindingIndex = {
    receipts: [],
    receiptsByGatewaySessionId: new Map(),
    dedupeKeys: new Set(),
  };
  for (const receipt of readBindingFile(path).receipts) {
    addReceiptToIndex(index, receipt);
  }
  bindingIndexByPath.set(path, index);
  return index;
}

export function resolveGatewaySessionBindingStorePath(stateDir: string): string {
  return resolve(stateDir, "session-bindings.json");
}

export function listGatewaySessionBindings(
  storePath: string,
  gatewaySessionId?: string,
): GatewaySessionBindingReceipt[] {
  const index = loadBindingIndex(storePath);
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
  storePath: string,
  input: {
    gatewaySessionId: string;
    agentSessionId: string;
    cwd?: string;
    timestamp?: number;
  },
): void {
  const index = loadBindingIndex(storePath);
  const gatewaySessionId = input.gatewaySessionId.trim();
  const agentSessionId = input.agentSessionId.trim();
  const cwd = readNonEmptyString(input.cwd);
  if (!gatewaySessionId || !agentSessionId) {
    throw new Error("gateway session binding receipt requires session and agent session");
  }

  const receipt: GatewaySessionBindingReceipt = {
    gatewaySessionId,
    agentSessionId,
    cwd,
    openedAt: input.timestamp ?? Date.now(),
  };
  if (index.dedupeKeys.has(buildDedupeKey(receipt))) {
    return;
  }

  addReceiptToIndex(index, receipt);
  writeBindingFile(storePath, {
    schema: "brewva.gateway-session-bindings.v2",
    receipts: index.receipts.toSorted(compareReceipts),
  });
}
