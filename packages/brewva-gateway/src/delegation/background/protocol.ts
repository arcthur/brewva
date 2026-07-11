import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { BrewvaConfig } from "@brewva/brewva-runtime";
import { readJsonFileSync } from "@brewva/brewva-std/node/fs";
import type { BrewvaModelRoleAlias } from "@brewva/brewva-substrate/session";
import type {
  DelegationPacket,
  SubagentExecutionShape,
  SubagentRunRequest,
} from "@brewva/brewva-tools/contracts";
import type {
  DelegationModelRouteRecord,
  DelegationRunRecord,
} from "@brewva/brewva-vocabulary/delegation";
import type { HostedDelegationTarget } from "../targets.js";

export interface DetachedSubagentRunSpec {
  schema: "brewva.subagent-run-spec.v8";
  runId: string;
  parentSessionId: string;
  workspaceRoot: string;
  config: BrewvaConfig;
  configPath?: string;
  delegate: string;
  target: HostedDelegationTarget;
  executionShape?: SubagentExecutionShape;
  modelRole?: BrewvaModelRoleAlias;
  modelRoute?: DelegationModelRouteRecord;
  label?: string;
  taskName: string;
  taskPath: string;
  nickname: string;
  depth: number;
  forkTurns: NonNullable<SubagentRunRequest["forkTurns"]>;
  packet: DelegationPacket;
  timeoutMs?: number;
  delivery?: NonNullable<SubagentRunRequest["delivery"]>;
  createdAt: number;
}

export interface DetachedSubagentLiveState {
  schema: "brewva.subagent-run-live.v1";
  runId: string;
  parentSessionId: string;
  delegate: string;
  pid: number;
  createdAt: number;
  updatedAt: number;
  status: Extract<DelegationRunRecord["status"], "pending" | "running">;
  label?: string;
  workerSessionId?: string;
  completionPredicate?: DelegationPacket["completionPredicate"];
  cancelRequestedAt?: number;
  cancelReason?: string;
}

export interface DetachedSubagentCancelRequest {
  schema: "brewva.subagent-cancel-request.v1";
  runId: string;
  requestedAt: number;
  reason?: string;
}

function writeJsonFile(filePath: string, value: unknown): void {
  const resolvedPath = resolve(filePath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  const tmpPath = `${resolvedPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    const fileDescriptor = openSync(tmpPath, "w");
    try {
      writeFileSync(fileDescriptor, JSON.stringify(value, null, 2), "utf8");
      fsyncSync(fileDescriptor);
    } finally {
      closeSync(fileDescriptor);
    }
    renameSync(tmpPath, resolvedPath);
    const directoryDescriptor = openSync(dirname(resolvedPath), "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // best effort cleanup
    }
    throw error;
  }
}

function readJsonFile<T>(
  filePath: string,
  coerce: (value: unknown) => T = (value) => value as T,
): T | undefined {
  const parsed = readJsonFileSync(filePath);
  if (parsed === undefined) {
    return undefined;
  }
  try {
    return coerce(parsed);
  } catch {
    return undefined;
  }
}

export function resolveDetachedSubagentRoot(workspaceRoot: string): string {
  return resolve(workspaceRoot, ".orchestrator", "subagent-runs");
}

export function resolveDetachedSubagentRunDir(workspaceRoot: string, runId: string): string {
  return resolve(resolveDetachedSubagentRoot(workspaceRoot), runId);
}

export function resolveDetachedSubagentSpecPath(workspaceRoot: string, runId: string): string {
  return resolve(resolveDetachedSubagentRunDir(workspaceRoot, runId), "spec.json");
}

export function resolveDetachedSubagentLiveStatePath(workspaceRoot: string, runId: string): string {
  return resolve(resolveDetachedSubagentRunDir(workspaceRoot, runId), "live.json");
}

export function resolveDetachedSubagentCancelPath(workspaceRoot: string, runId: string): string {
  return resolve(resolveDetachedSubagentRunDir(workspaceRoot, runId), "cancel.json");
}

export function resolveDetachedSubagentOutcomePath(workspaceRoot: string, runId: string): string {
  return resolve(resolveDetachedSubagentRunDir(workspaceRoot, runId), "outcome.json");
}

export function resolveDetachedSubagentStderrLogPath(workspaceRoot: string, runId: string): string {
  return resolve(resolveDetachedSubagentRunDir(workspaceRoot, runId), "stderr.log");
}

/**
 * The tail of a detached child's stderr, if any. A masked child crash — an early
 * throw before its try, or its top-level `main().catch` — writes the real reason
 * here; the parent reads it so a `background_registry_missing` reconcile can
 * surface the actual failure instead of the generic marker. Empty/absent → null.
 */
export function readDetachedSubagentStderrTail(
  workspaceRoot: string,
  runId: string,
  maxChars = 600,
): string | null {
  try {
    const content = readFileSync(
      resolveDetachedSubagentStderrLogPath(workspaceRoot, runId),
      "utf8",
    ).trim();
    return content.length > 0 ? content.slice(-maxChars) : null;
  } catch {
    return null;
  }
}

export function writeDetachedSubagentSpec(
  workspaceRoot: string,
  runId: string,
  spec: DetachedSubagentRunSpec,
): void {
  writeJsonFile(resolveDetachedSubagentSpecPath(workspaceRoot, runId), spec);
}

export function writeDetachedSubagentLiveState(
  workspaceRoot: string,
  runId: string,
  state: DetachedSubagentLiveState,
): void {
  writeJsonFile(resolveDetachedSubagentLiveStatePath(workspaceRoot, runId), state);
}

export function readDetachedSubagentLiveState(
  workspaceRoot: string,
  runId: string,
): DetachedSubagentLiveState | undefined {
  return readJsonFile<DetachedSubagentLiveState>(
    resolveDetachedSubagentLiveStatePath(workspaceRoot, runId),
  );
}

export function removeDetachedSubagentLiveState(workspaceRoot: string, runId: string): void {
  rmSync(resolveDetachedSubagentLiveStatePath(workspaceRoot, runId), { force: true });
}

export function listDetachedSubagentLiveStates(workspaceRoot: string): DetachedSubagentLiveState[] {
  const root = resolveDetachedSubagentRoot(workspaceRoot);
  if (!existsSync(root)) {
    return [];
  }
  const runDirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  return runDirs
    .map((runId) => readDetachedSubagentLiveState(workspaceRoot, runId))
    .filter((entry): entry is DetachedSubagentLiveState => !!entry);
}

export function writeDetachedSubagentCancelRequest(
  workspaceRoot: string,
  runId: string,
  request: DetachedSubagentCancelRequest,
): void {
  writeJsonFile(resolveDetachedSubagentCancelPath(workspaceRoot, runId), request);
}

export function readDetachedSubagentCancelRequest(
  workspaceRoot: string,
  runId: string,
): DetachedSubagentCancelRequest | undefined {
  return readJsonFile<DetachedSubagentCancelRequest>(
    resolveDetachedSubagentCancelPath(workspaceRoot, runId),
  );
}

export function removeDetachedSubagentCancelRequest(workspaceRoot: string, runId: string): void {
  rmSync(resolveDetachedSubagentCancelPath(workspaceRoot, runId), { force: true });
}

export function writeDetachedSubagentOutcome(
  workspaceRoot: string,
  runId: string,
  outcome: unknown,
): void {
  writeJsonFile(resolveDetachedSubagentOutcomePath(workspaceRoot, runId), outcome);
}

export function readDetachedSubagentOutcome(workspaceRoot: string, runId: string): unknown {
  return readJsonFile(resolveDetachedSubagentOutcomePath(workspaceRoot, runId));
}
