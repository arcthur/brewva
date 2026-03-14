import { test } from "bun:test";
import { resolve } from "node:path";
import { cleanupTestWorkspace, createTestWorkspace } from "./workspace.js";

export const repoRoot = resolve(import.meta.dir, "../..");
export const runLive: typeof test = process.env.BREWVA_E2E_LIVE === "1" ? test : test.skip;
export const keepWorkspace = process.env.BREWVA_E2E_KEEP_WORKSPACE === "1";

export function createWorkspace(prefix: string): string {
  return createTestWorkspace(`e2e-${prefix}`);
}

export function cleanupWorkspace(workspace: string): void {
  cleanupTestWorkspace(workspace, keepWorkspace);
}
