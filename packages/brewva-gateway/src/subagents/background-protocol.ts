import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { DelegationRunRecord, SkillRoutingScope } from "@brewva/brewva-runtime";
import type { DelegationPacket, SubagentRunRequest } from "@brewva/brewva-tools";

export interface DetachedSubagentRunSpec {
  schema: "brewva.subagent-run-spec.v1";
  runId: string;
  parentSessionId: string;
  workspaceRoot: string;
  configPath?: string;
  routingScopes?: SkillRoutingScope[];
  profileName: string;
  label?: string;
  packet: DelegationPacket;
  timeoutMs?: number;
  delivery?: NonNullable<SubagentRunRequest["delivery"]>;
  createdAt: number;
}

export interface DetachedSubagentLiveState {
  schema: "brewva.subagent-run-live.v1";
  runId: string;
  parentSessionId: string;
  profile: string;
  pid: number;
  createdAt: number;
  updatedAt: number;
  status: Extract<DelegationRunRecord["status"], "pending" | "running">;
  label?: string;
  workerSessionId?: string;
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
    writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf8");
    renameSync(tmpPath, resolvedPath);
  } catch (error) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // best effort cleanup
    }
    throw error;
  }
}

function readJsonFile<T>(filePath: string): T | undefined {
  const resolvedPath = resolve(filePath);
  if (!existsSync(resolvedPath)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(resolvedPath, "utf8")) as T;
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

export function writeDetachedSubagentSpec(
  workspaceRoot: string,
  runId: string,
  spec: DetachedSubagentRunSpec,
): void {
  writeJsonFile(resolveDetachedSubagentSpecPath(workspaceRoot, runId), spec);
}

export function readDetachedSubagentSpec(
  workspaceRoot: string,
  runId: string,
): DetachedSubagentRunSpec | undefined {
  return readJsonFile<DetachedSubagentRunSpec>(
    resolveDetachedSubagentSpecPath(workspaceRoot, runId),
  );
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
