import type { BrewvaManagedPromptSession } from "@brewva/brewva-substrate";
import type { CliInteractiveSessionOptions, CliInteractiveSmokeResult } from "./cli-runtime.js";

const UNSUPPORTED_RUNTIME_MESSAGE =
  "OpenTUI-backed interactive shell runtime is only available from Bun source execution or packaged Brewva binaries; direct Node.js dist execution cannot load it.";

function createUnsupportedRuntimeError(): Error {
  return new Error(UNSUPPORTED_RUNTIME_MESSAGE);
}

export const CLI_INTERNAL_SHELL_RUNTIME_KIND = "node-stub";

export function isCliInteractiveRuntimeAvailable(): boolean {
  return false;
}

export async function runCliInteractiveSmoke(): Promise<CliInteractiveSmokeResult> {
  throw createUnsupportedRuntimeError();
}

export async function runCliInteractiveSession(
  _session: BrewvaManagedPromptSession,
  _options: CliInteractiveSessionOptions,
): Promise<never> {
  throw createUnsupportedRuntimeError();
}
