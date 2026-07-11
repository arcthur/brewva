import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { readJsonFileSync } from "@brewva/brewva-std/node/fs";
import { isRecord } from "@brewva/brewva-std/unknown";
import type { ContextBundle } from "../context/api.js";

export interface DelegationContextBundleManifest {
  schema: "brewva.delegation-context-bundle.v1";
  runId: string;
  generatedAt: number;
  bundle: ContextBundle;
  hash: string;
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

export function resolveDelegationRunArtifactDir(workspaceRoot: string, runId: string): string {
  return resolve(workspaceRoot, ".orchestrator", "subagent-runs", runId);
}

export function resolveDelegationContextBundleManifestPath(
  workspaceRoot: string,
  runId: string,
): string {
  return resolve(resolveDelegationRunArtifactDir(workspaceRoot, runId), "context-bundle.json");
}

export function writeDelegationContextBundleManifest(
  workspaceRoot: string,
  runId: string,
  manifest: DelegationContextBundleManifest,
): void {
  writeJsonFile(resolveDelegationContextBundleManifestPath(workspaceRoot, runId), manifest);
}

export function readDelegationContextBundleManifest(
  workspaceRoot: string,
  runId: string,
): DelegationContextBundleManifest | undefined {
  const value = readJsonFileSync(resolveDelegationContextBundleManifestPath(workspaceRoot, runId));
  if (
    !isRecord(value) ||
    value.schema !== "brewva.delegation-context-bundle.v1" ||
    value.runId !== runId
  ) {
    return undefined;
  }
  return value as unknown as DelegationContextBundleManifest;
}
