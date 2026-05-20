import { runEdgeOperation } from "@brewva/brewva-effect";
import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import type { BrewvaManagedPromptSession } from "@brewva/brewva-substrate/session";
import type {
  CliInteractiveSessionOptions,
  CliInteractiveSmokeResult,
} from "./session/cli-runtime.js";

// Node-safe package export used by dist verification and external Node importers.
// The Bun/OpenTUI implementation is intentionally exposed only through
// runtime/internal-shell-runtime.ts and packaged binaries.
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

export async function runCliInteractiveSessionOperation(
  _session: BrewvaManagedPromptSession,
  _options: CliInteractiveSessionOptions,
): Promise<never> {
  throw createUnsupportedRuntimeError();
}

export function runCliInteractiveSessionEffect(
  session: BrewvaManagedPromptSession,
  options: CliInteractiveSessionOptions,
): BrewvaEffect.Effect<never, unknown> {
  return BrewvaEffect.promise(() => runCliInteractiveSessionOperation(session, options));
}

export async function runCliInteractiveSession(
  session: BrewvaManagedPromptSession,
  options: CliInteractiveSessionOptions,
): Promise<never> {
  return await runEdgeOperation(
    "brewva.cli.interactive",
    runCliInteractiveSessionEffect(session, options),
    {
      fields: {
        cwd: options.cwd,
      },
    },
  );
}
