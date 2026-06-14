import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { readNonEmptyString } from "@brewva/brewva-std/text";
import { isRecord } from "@brewva/brewva-std/unknown";

// Gateway control tape: an append-only JSONL ledger of consequence-bearing
// control-plane commitments. It is the gateway analogue of the runtime event
// tape — append-only, dedupe-by-id, and restart-safe via incremental re-read of
// a grown file — and it is the authority for public-session replay binding.
export const GATEWAY_CONTROL_TAPE_SCHEMA = "brewva.gateway-control.v3";
export const GATEWAY_CONTROL_TAPE_FILENAME = "gateway-control.jsonl";

// Only `gateway_prompt_admitted` receipts are per-turn and grow without bound;
// their value is purely recency (a long-finished turn is never retried). The
// tape retains the most recent admissions and compacts the rest. Bindings
// (replay authority) and operator receipts (audit) are never compacted.
export const GATEWAY_CONTROL_TAPE_ADMISSION_RETENTION = 2000;
// Amortize: rewrite once every ~retention appends rather than on every append
// past the cap.
const ADMISSION_COMPACT_HIGH_WATER = GATEWAY_CONTROL_TAPE_ADMISSION_RETENTION * 2;

export type GatewayControlReceiptType =
  | "gateway_session_bound"
  | "gateway_prompt_admitted"
  | "gateway_token_rotated"
  | "gateway_stopped"
  | "gateway_scheduler_paused"
  | "gateway_scheduler_resumed";

interface GatewayControlReceiptBase {
  readonly schema: typeof GATEWAY_CONTROL_TAPE_SCHEMA;
  readonly id: string;
  readonly type: GatewayControlReceiptType;
  readonly timestamp: number;
}

/** Binds a public gateway session id to the agent-session tape it replays from. */
export interface GatewaySessionBoundReceipt extends GatewayControlReceiptBase {
  readonly type: "gateway_session_bound";
  readonly gatewaySessionId: string;
  readonly agentSessionId: string;
  readonly cwd?: string;
}

/**
 * Durable idempotency record for a prompt admission, keyed by the client-supplied
 * turn id. A retry of `sessions.send` with the same turn id replays this receipt
 * instead of admitting the turn twice — retry-safe across the connection drops
 * that token rotation and daemon restart cause. `promptHash` makes the
 * idempotency conditional: the same turn id with a different prompt is a client
 * conflict, not a retry, and the caller can reject it rather than silently drop
 * the new prompt.
 */
export interface GatewayPromptAdmittedReceipt extends GatewayControlReceiptBase {
  readonly type: "gateway_prompt_admitted";
  readonly gatewaySessionId: string;
  readonly turnId: string;
  readonly promptHash: string;
  readonly agentSessionId?: string;
}

export interface GatewayTokenRotatedReceipt extends GatewayControlReceiptBase {
  readonly type: "gateway_token_rotated";
  readonly revokedConnections: number;
  readonly connId?: string;
}

export interface GatewayStoppedReceipt extends GatewayControlReceiptBase {
  readonly type: "gateway_stopped";
  readonly reason: string;
}

export interface GatewaySchedulerPausedReceipt extends GatewayControlReceiptBase {
  readonly type: "gateway_scheduler_paused";
  readonly reason?: string;
}

export interface GatewaySchedulerResumedReceipt extends GatewayControlReceiptBase {
  readonly type: "gateway_scheduler_resumed";
}

export type GatewayControlReceipt =
  | GatewaySessionBoundReceipt
  | GatewayPromptAdmittedReceipt
  | GatewayTokenRotatedReceipt
  | GatewayStoppedReceipt
  | GatewaySchedulerPausedReceipt
  | GatewaySchedulerResumedReceipt;

export type GatewayControlReceiptInput =
  | {
      type: "gateway_session_bound";
      gatewaySessionId: string;
      agentSessionId: string;
      cwd?: string;
      timestamp?: number;
    }
  | {
      type: "gateway_prompt_admitted";
      gatewaySessionId: string;
      turnId: string;
      promptHash: string;
      agentSessionId?: string;
      timestamp?: number;
    }
  | {
      type: "gateway_token_rotated";
      revokedConnections: number;
      connId?: string;
      timestamp?: number;
    }
  | { type: "gateway_stopped"; reason: string; timestamp?: number }
  | { type: "gateway_scheduler_paused"; reason?: string; timestamp?: number }
  | { type: "gateway_scheduler_resumed"; timestamp?: number };

/** Replay-lookup projection of `gateway_session_bound` receipts. */
export interface GatewaySessionBinding {
  readonly gatewaySessionId: string;
  readonly agentSessionId: string;
  readonly cwd?: string;
  readonly openedAt: number;
}

/** Idempotency-lookup projection of `gateway_prompt_admitted` receipts. */
export interface GatewayPromptAdmission {
  readonly gatewaySessionId: string;
  readonly turnId: string;
  readonly promptHash: string;
  readonly agentSessionId?: string;
  readonly admittedAt: number;
}

// Keys join client-controlled segments, so each is percent-encoded: that
// escapes the `:` delimiter, making distinct segment tuples impossible to
// alias onto the same key (e.g. session "a:b"+turn "c" vs session "a"+turn
// "b:c").
function key(...segments: string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join(":");
}

function admissionKey(gatewaySessionId: string, turnId: string): string {
  return key(gatewaySessionId, turnId);
}

interface ControlTapeIndex {
  readonly receipts: GatewayControlReceipt[];
  readonly ids: Set<string>;
  readonly bindingsByGatewaySessionId: Map<string, GatewaySessionBinding[]>;
  readonly admissionsByKey: Map<string, GatewayPromptAdmission>;
  fd: number | undefined;
  parsedSize: number;
}

const indexByPath = new Map<string, ControlTapeIndex>();

export function resolveGatewayControlTapePath(stateDir: string): string {
  return resolve(stateDir, GATEWAY_CONTROL_TAPE_FILENAME);
}

function corruptTapeError(tapePath: string): Error {
  return new Error(
    `unsupported_gateway_control_tape: ${tapePath} contains a malformed receipt line. ` +
      `Archive or remove the file, then restart the gateway daemon.`,
  );
}

function compareBindings(left: GatewaySessionBinding, right: GatewaySessionBinding): number {
  return (
    left.openedAt - right.openedAt ||
    left.agentSessionId.localeCompare(right.agentSessionId) ||
    (left.cwd ?? "").localeCompare(right.cwd ?? "")
  );
}

// Deterministic ids so re-recording the same fact is idempotent across live
// appends and restart re-reads: a binding by (session, agent, cwd) and a prompt
// admission by (session, turn). Segments are encoded (see `key`) so distinct
// tuples never alias. Event-like receipts always get a fresh id.
function bindingReceiptId(gatewaySessionId: string, agentSessionId: string, cwd?: string): string {
  return `gateway_session_bound:${key(gatewaySessionId, agentSessionId, cwd ?? "")}`;
}

function admissionReceiptId(gatewaySessionId: string, turnId: string): string {
  return `gateway_prompt_admitted:${key(gatewaySessionId, turnId)}`;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseReceipt(value: unknown): GatewayControlReceipt | null {
  if (!isRecord(value) || value.schema !== GATEWAY_CONTROL_TAPE_SCHEMA) {
    return null;
  }
  const id = readNonEmptyString(value.id);
  const timestamp = readFiniteNumber(value.timestamp);
  if (!id || timestamp === null) {
    return null;
  }
  switch (value.type) {
    case "gateway_session_bound": {
      const gatewaySessionId = readNonEmptyString(value.gatewaySessionId);
      const agentSessionId = readNonEmptyString(value.agentSessionId);
      if (!gatewaySessionId || !agentSessionId) {
        return null;
      }
      const cwd = readNonEmptyString(value.cwd);
      return {
        schema: GATEWAY_CONTROL_TAPE_SCHEMA,
        id,
        type: "gateway_session_bound",
        timestamp,
        gatewaySessionId,
        agentSessionId,
        ...(cwd ? { cwd } : {}),
      };
    }
    case "gateway_prompt_admitted": {
      const gatewaySessionId = readNonEmptyString(value.gatewaySessionId);
      const turnId = readNonEmptyString(value.turnId);
      const promptHash = readNonEmptyString(value.promptHash);
      if (!gatewaySessionId || !turnId || !promptHash) {
        return null;
      }
      const agentSessionId = readNonEmptyString(value.agentSessionId);
      return {
        schema: GATEWAY_CONTROL_TAPE_SCHEMA,
        id,
        type: "gateway_prompt_admitted",
        timestamp,
        gatewaySessionId,
        turnId,
        promptHash,
        ...(agentSessionId ? { agentSessionId } : {}),
      };
    }
    case "gateway_token_rotated": {
      const revokedConnections = readFiniteNumber(value.revokedConnections);
      const connId = readNonEmptyString(value.connId);
      if (revokedConnections === null) {
        return null;
      }
      return {
        schema: GATEWAY_CONTROL_TAPE_SCHEMA,
        id,
        type: "gateway_token_rotated",
        timestamp,
        revokedConnections,
        ...(connId ? { connId } : {}),
      };
    }
    case "gateway_stopped": {
      const reason = readNonEmptyString(value.reason);
      if (!reason) {
        return null;
      }
      return {
        schema: GATEWAY_CONTROL_TAPE_SCHEMA,
        id,
        type: "gateway_stopped",
        timestamp,
        reason,
      };
    }
    case "gateway_scheduler_paused": {
      const reason = readNonEmptyString(value.reason);
      return {
        schema: GATEWAY_CONTROL_TAPE_SCHEMA,
        id,
        type: "gateway_scheduler_paused",
        timestamp,
        ...(reason ? { reason } : {}),
      };
    }
    case "gateway_scheduler_resumed":
      return {
        schema: GATEWAY_CONTROL_TAPE_SCHEMA,
        id,
        type: "gateway_scheduler_resumed",
        timestamp,
      };
    default:
      return null;
  }
}

function addReceiptToIndex(index: ControlTapeIndex, receipt: GatewayControlReceipt): boolean {
  if (index.ids.has(receipt.id)) {
    return false;
  }
  index.ids.add(receipt.id);
  index.receipts.push(receipt);
  if (receipt.type === "gateway_session_bound") {
    const binding: GatewaySessionBinding = {
      gatewaySessionId: receipt.gatewaySessionId,
      agentSessionId: receipt.agentSessionId,
      ...(receipt.cwd ? { cwd: receipt.cwd } : {}),
      openedAt: receipt.timestamp,
    };
    const list = index.bindingsByGatewaySessionId.get(receipt.gatewaySessionId);
    if (list) {
      list.push(binding);
    } else {
      index.bindingsByGatewaySessionId.set(receipt.gatewaySessionId, [binding]);
    }
  } else if (receipt.type === "gateway_prompt_admitted") {
    index.admissionsByKey.set(admissionKey(receipt.gatewaySessionId, receipt.turnId), {
      gatewaySessionId: receipt.gatewaySessionId,
      turnId: receipt.turnId,
      promptHash: receipt.promptHash,
      ...(receipt.agentSessionId ? { agentSessionId: receipt.agentSessionId } : {}),
      admittedAt: receipt.timestamp,
    });
  }
  return true;
}

// Reconciles the in-memory index with the tape file when it has grown since the
// last read, so a receipt appended after restart becomes visible. Recovery
// discipline for an append-only log:
//   - Only bytes through the final newline are committed records. A non-empty
//     trailing fragment is an interrupted append (crash mid-write); it is
//     truncated so the next append cannot concatenate onto it, and never read
//     as a receipt. A torn tail therefore degrades to nothing, not a brick.
//   - A *complete* line (terminated by a newline) that fails to parse is real
//     corruption: the tape is replay-binding authority, so it fails loud.
function reconcileFromDisk(index: ControlTapeIndex, tapePath: string): void {
  if (!existsSync(tapePath)) {
    return;
  }
  let size: number;
  try {
    size = statSync(tapePath).size;
  } catch {
    return;
  }
  if (size <= index.parsedSize) {
    return;
  }
  const buffer = readFileSync(tapePath);
  const lastNewline = buffer.lastIndexOf(0x0a);
  const committedEnd = lastNewline + 1; // 0 when the file holds no newline yet
  const committed = buffer.toString("utf8", 0, committedEnd);
  for (const line of committed.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw corruptTapeError(tapePath);
    }
    const receipt = parseReceipt(parsed);
    if (!receipt) {
      throw corruptTapeError(tapePath);
    }
    addReceiptToIndex(index, receipt);
  }
  if (committedEnd < size) {
    // Discard the never-committed trailing fragment from an interrupted append.
    truncateSync(tapePath, committedEnd);
  }
  index.parsedSize = committedEnd;
}

function hydrate(tapePath: string): ControlTapeIndex {
  const existing = indexByPath.get(tapePath);
  if (existing) {
    reconcileFromDisk(existing, tapePath);
    return existing;
  }
  const index: ControlTapeIndex = {
    receipts: [],
    ids: new Set(),
    bindingsByGatewaySessionId: new Map(),
    admissionsByKey: new Map(),
    fd: undefined,
    parsedSize: 0,
  };
  indexByPath.set(tapePath, index);
  reconcileFromDisk(index, tapePath);
  return index;
}

function appendFd(index: ControlTapeIndex, tapePath: string): number {
  if (index.fd !== undefined) {
    return index.fd;
  }
  mkdirSync(dirname(tapePath), { recursive: true });
  const fd = openSync(tapePath, "a");
  index.fd = fd;
  return fd;
}

function buildReceipt(input: GatewayControlReceiptInput): GatewayControlReceipt {
  const timestamp = input.timestamp ?? Date.now();
  switch (input.type) {
    case "gateway_session_bound": {
      const gatewaySessionId = input.gatewaySessionId.trim();
      const agentSessionId = input.agentSessionId.trim();
      if (!gatewaySessionId || !agentSessionId) {
        throw new Error("gateway_session_bound receipt requires session and agent session ids");
      }
      const cwd = readNonEmptyString(input.cwd);
      return {
        schema: GATEWAY_CONTROL_TAPE_SCHEMA,
        id: bindingReceiptId(gatewaySessionId, agentSessionId, cwd),
        type: "gateway_session_bound",
        timestamp,
        gatewaySessionId,
        agentSessionId,
        ...(cwd ? { cwd } : {}),
      };
    }
    case "gateway_prompt_admitted": {
      const gatewaySessionId = input.gatewaySessionId.trim();
      const turnId = input.turnId.trim();
      const promptHash = input.promptHash.trim();
      if (!gatewaySessionId || !turnId || !promptHash) {
        throw new Error("gateway_prompt_admitted receipt requires session, turn, and prompt hash");
      }
      const agentSessionId = readNonEmptyString(input.agentSessionId);
      return {
        schema: GATEWAY_CONTROL_TAPE_SCHEMA,
        id: admissionReceiptId(gatewaySessionId, turnId),
        type: "gateway_prompt_admitted",
        timestamp,
        gatewaySessionId,
        turnId,
        promptHash,
        ...(agentSessionId ? { agentSessionId } : {}),
      };
    }
    case "gateway_token_rotated": {
      const connId = readNonEmptyString(input.connId);
      return {
        schema: GATEWAY_CONTROL_TAPE_SCHEMA,
        id: `gwc_${randomUUID()}`,
        type: "gateway_token_rotated",
        timestamp,
        revokedConnections: Math.max(0, Math.trunc(input.revokedConnections)),
        ...(connId ? { connId } : {}),
      };
    }
    case "gateway_stopped":
      return {
        schema: GATEWAY_CONTROL_TAPE_SCHEMA,
        id: `gwc_${randomUUID()}`,
        type: "gateway_stopped",
        timestamp,
        reason: input.reason.trim() || "shutdown",
      };
    case "gateway_scheduler_paused": {
      const reason = readNonEmptyString(input.reason);
      return {
        schema: GATEWAY_CONTROL_TAPE_SCHEMA,
        id: `gwc_${randomUUID()}`,
        type: "gateway_scheduler_paused",
        timestamp,
        ...(reason ? { reason } : {}),
      };
    }
    case "gateway_scheduler_resumed":
      return {
        schema: GATEWAY_CONTROL_TAPE_SCHEMA,
        id: `gwc_${randomUUID()}`,
        type: "gateway_scheduler_resumed",
        timestamp,
      };
    default: {
      const unreachable: never = input;
      throw new Error(`unsupported gateway control receipt input: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Appends a control-plane receipt to the tape. Returns the persisted receipt, or
 * `null` when a deterministic-id receipt (a `gateway_session_bound` binding or a
 * `gateway_prompt_admitted` admission) is already recorded.
 */
export function appendGatewayControlReceipt(
  tapePath: string,
  input: GatewayControlReceiptInput,
): GatewayControlReceipt | null {
  const index = hydrate(tapePath);
  const receipt = buildReceipt(input);
  if (!addReceiptToIndex(index, receipt)) {
    return null;
  }
  const line = `${JSON.stringify(receipt)}\n`;
  writeSync(appendFd(index, tapePath), line);
  // Account for our own write so the next reconcile does not re-read it.
  index.parsedSize += Buffer.byteLength(line, "utf8");
  if (
    receipt.type === "gateway_prompt_admitted" &&
    index.admissionsByKey.size > ADMISSION_COMPACT_HIGH_WATER
  ) {
    compactGatewayControlTapeAdmissions(tapePath);
  }
  return receipt;
}

// Atomically replaces the tape with `retained`: close the append descriptor
// (it points at the current inode), write a sibling temp file, rename it over
// the tape, then rebuild the in-memory index. A crash before the rename leaves
// the original tape intact; the rename itself is atomic.
function rewriteTape(index: ControlTapeIndex, tapePath: string, retained: GatewayControlReceipt[]) {
  if (index.fd !== undefined) {
    closeSync(index.fd);
    index.fd = undefined;
  }
  const body = retained.map((receipt) => `${JSON.stringify(receipt)}\n`).join("");
  const tmpPath = `${tapePath}.compact`;
  mkdirSync(dirname(tapePath), { recursive: true });
  writeFileSync(tmpPath, body, "utf8");
  renameSync(tmpPath, tapePath);
  index.receipts.length = 0;
  index.ids.clear();
  index.bindingsByGatewaySessionId.clear();
  index.admissionsByKey.clear();
  for (const receipt of retained) {
    addReceiptToIndex(index, receipt);
  }
  index.parsedSize = Buffer.byteLength(body, "utf8");
}

/**
 * Compacts the tape to the most recent `retention` `gateway_prompt_admitted`
 * receipts, preserving every binding and operator receipt. Returns the number
 * of admissions dropped. Older admissions lose retry idempotency — acceptable,
 * since a long-finished turn is never retried.
 */
export function compactGatewayControlTapeAdmissions(
  tapePath: string,
  retention: number = GATEWAY_CONTROL_TAPE_ADMISSION_RETENTION,
): number {
  const index = hydrate(tapePath);
  const admissions = index.receipts.filter((receipt) => receipt.type === "gateway_prompt_admitted");
  if (admissions.length <= retention) {
    return 0;
  }
  const keptAdmissionIds = new Set(
    admissions.slice(admissions.length - retention).map((receipt) => receipt.id),
  );
  const retained = index.receipts.filter(
    (receipt) => receipt.type !== "gateway_prompt_admitted" || keptAdmissionIds.has(receipt.id),
  );
  const dropped = index.receipts.length - retained.length;
  rewriteTape(index, tapePath, retained);
  return dropped;
}

/** Lists replay bindings, oldest first, optionally scoped to one gateway session. */
export function listGatewaySessionBindings(
  tapePath: string,
  gatewaySessionId?: string,
): GatewaySessionBinding[] {
  const index = hydrate(tapePath);
  const scoped = gatewaySessionId?.trim();
  const bindings = scoped
    ? (index.bindingsByGatewaySessionId.get(scoped) ?? [])
    : [...index.bindingsByGatewaySessionId.values()].flat();
  return bindings.toSorted(compareBindings);
}

/** Resolves a prior prompt admission for idempotent `sessions.send` retries. */
export function findGatewayPromptAdmission(
  tapePath: string,
  gatewaySessionId: string,
  turnId: string,
): GatewayPromptAdmission | null {
  const session = gatewaySessionId.trim();
  const turn = turnId.trim();
  if (!session || !turn) {
    return null;
  }
  return hydrate(tapePath).admissionsByKey.get(admissionKey(session, turn)) ?? null;
}

/** Reads control receipts, oldest first, optionally filtered by type. */
export function readGatewayControlReceipts(
  tapePath: string,
  filter?: { type?: GatewayControlReceiptType },
): readonly GatewayControlReceipt[] {
  const index = hydrate(tapePath);
  const receipts = filter?.type
    ? index.receipts.filter((receipt) => receipt.type === filter.type)
    : [...index.receipts];
  return receipts.toSorted(
    (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id),
  );
}

/** Releases the append descriptor and drops the in-memory index. */
export function closeGatewayControlTape(tapePath: string): void {
  const index = indexByPath.get(tapePath);
  if (!index) {
    return;
  }
  if (index.fd !== undefined) {
    try {
      closeSync(index.fd);
    } catch {
      // best effort
    }
  }
  indexByPath.delete(tapePath);
}
