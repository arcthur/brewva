import type { BrewvaConfig } from "@brewva/brewva-runtime";
import { writeTestConfig } from "./workspace.js";

export function writeMinimalConfig(
  workspace: string,
  overrides?: Record<string, unknown>,
  configPath?: string,
): void {
  writeTestConfig(workspace, (overrides ?? {}) as unknown as BrewvaConfig, configPath);
}
