import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrewvaConfig } from "@brewva/brewva-runtime";
import { createTestConfig, type DeepPartial } from "../../fixtures/config.js";
import { createTestWorkspace, writeTestConfig } from "../../helpers/workspace.js";

export const GAP_REMEDIATION_CONFIG_PATH = ".config/brewva/brewva.json";

export function createGapRemediationWorkspace(name: string): string {
  return createTestWorkspace(name, { configDir: ".config/brewva" });
}

export function writeGapRemediationConfig(workspace: string, config: BrewvaConfig): void {
  writeTestConfig(workspace, config, GAP_REMEDIATION_CONFIG_PATH);
}

export function createGapRemediationConfig(overrides: DeepPartial<BrewvaConfig>): BrewvaConfig {
  return createTestConfig(overrides);
}

export function findGapRemediationEventFilePath(
  workspace: string,
  eventsDir: string,
  sessionId: string,
): string {
  const root = join(workspace, eventsDir);
  const files = readdirSync(root).filter((name) => name.endsWith(".jsonl"));
  for (const name of files) {
    const filePath = join(root, name);
    try {
      const content = readFileSync(filePath, "utf8");
      if (content.includes(`"sessionId":"${sessionId}"`)) {
        return filePath;
      }
    } catch {
      continue;
    }
  }
  throw new Error(`event_file_not_found:${sessionId}`);
}
