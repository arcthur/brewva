import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BrewvaConfig } from "@brewva/brewva-runtime";
import { createTestConfig, type DeepPartial } from "../../fixtures/config.js";
import { createTestWorkspace, writeTestConfig } from "../../helpers/workspace.js";

export const RUNTIME_CONTRACT_CONFIG_PATH = ".config/brewva/brewva.json";

export function createRuntimeContractWorkspace(name: string): string {
  return createTestWorkspace(name, { configDir: ".config/brewva" });
}

export function writeRuntimeContractConfig(workspace: string, config: BrewvaConfig): void {
  writeTestConfig(workspace, config, RUNTIME_CONTRACT_CONFIG_PATH);
}

export function createRuntimeContractConfig(overrides: DeepPartial<BrewvaConfig>): BrewvaConfig {
  return createTestConfig(overrides);
}

export function removeRuntimeContractPatchSnapshot(input: {
  workspace: string;
  sessionId: string;
  path: string;
  snapshotKey: "beforeSnapshotFile" | "afterSnapshotFile";
}): void {
  const snapshotDir = join(input.workspace, ".orchestrator/snapshots", input.sessionId);
  const history = JSON.parse(readFileSync(join(snapshotDir, "patchsets.json"), "utf8")) as {
    patchSets?: Array<{
      changes?: Array<{
        path?: string;
        beforeSnapshotFile?: string;
        afterSnapshotFile?: string;
      }>;
    }>;
  };
  const snapshotFile = history.patchSets
    ?.flatMap((patchSet) => patchSet.changes ?? [])
    .find((change) => change.path === input.path)?.[input.snapshotKey];
  if (!snapshotFile) {
    throw new Error(`Missing ${input.snapshotKey} for ${input.path}`);
  }
  rmSync(join(snapshotDir, snapshotFile), { force: true });
}
