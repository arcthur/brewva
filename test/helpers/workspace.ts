import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BrewvaConfig } from "@brewva/brewva-runtime";

export const repoRoot = resolve(import.meta.dir, "../..");
export const keepTestWorkspace =
  process.env.BREWVA_TEST_KEEP_WORKSPACE === "1" || process.env.BREWVA_E2E_KEEP_WORKSPACE === "1";

export function createTestWorkspace(name: string, options?: { configDir?: string }): string {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-${name}-`));
  const configDir = options?.configDir ?? ".brewva";
  mkdirSync(join(workspace, configDir), { recursive: true });
  return workspace;
}

export function createWorkspace(name: string, options?: { configDir?: string }): string {
  return createTestWorkspace(name, options);
}

export function writeTestConfig(
  workspace: string,
  config: BrewvaConfig,
  configPath?: string,
): void {
  const resolved = configPath ?? ".brewva/brewva.json";
  writeFileSync(join(workspace, resolved), JSON.stringify(config, null, 2), "utf8");
}

export function cleanupTestWorkspace(workspace: string, keep = false): void {
  if (keep) return;
  rmSync(workspace, { recursive: true, force: true });
}

export function cleanupWorkspace(workspace: string): void {
  cleanupTestWorkspace(workspace, keepTestWorkspace);
}
