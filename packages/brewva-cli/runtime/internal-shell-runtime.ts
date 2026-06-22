import { runEdgeOperation } from "@brewva/brewva-effect";
import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import type { BrewvaManagedPromptSession } from "@brewva/brewva-substrate/session";
import {
  runCliInteractiveShellEffect,
  runCliInteractiveSessionOperation as runCliInteractiveSessionBaseOperation,
  type CliInteractiveSessionOptions,
  type CliInteractiveShellLauncher,
  type CliInteractiveSmokeResult,
} from "../src/session/cli-runtime.js";
import { renderCliInteractiveOpenTuiShell } from "./opentui-shell-renderer.js";

// Bun-only implementation for the documented internal runtime export. The
// package root stays Node-safe; this path is selected by Bun source execution
// and by packaged Brewva binaries that can load OpenTUI native bindings.
const BREWVA_SHELL_SMOKE_ENV = "BREWVA_SHELL_SMOKE";

// The interactive shell renders the transcript, composer, and overlays live in
// a full-screen alternate-screen renderer.
const launchCliShell: CliInteractiveShellLauncher = async (bundle, shellOptions) => {
  await renderCliInteractiveOpenTuiShell(bundle, shellOptions);
};

export const CLI_INTERNAL_SHELL_RUNTIME_KIND = "bun-runtime";

export function isCliInteractiveRuntimeAvailable(): boolean {
  return true;
}

export async function runCliInteractiveSmoke(): Promise<CliInteractiveSmokeResult> {
  const { runOpenTuiSmoke } = await import("./internal-opentui-runtime.js");
  return await runOpenTuiSmoke({
    label: "Brewva OpenTUI smoke",
    screenMode: "alternate-screen",
  });
}

export async function runCliInteractiveSessionOperation(
  session: BrewvaManagedPromptSession,
  options: CliInteractiveSessionOptions,
): Promise<void> {
  if (process.env[BREWVA_SHELL_SMOKE_ENV] === "1") {
    await runCliInteractiveSmoke();
    return;
  }

  await runCliInteractiveSessionBaseOperation(session, options, launchCliShell);
}

export function runCliInteractiveSessionEffect(
  session: BrewvaManagedPromptSession,
  options: CliInteractiveSessionOptions,
): BrewvaEffect.Effect<void, unknown> {
  if (process.env[BREWVA_SHELL_SMOKE_ENV] === "1") {
    return BrewvaEffect.promise(() => runCliInteractiveSmoke());
  }
  return runCliInteractiveShellEffect(session, options, launchCliShell);
}

export async function runCliInteractiveSession(
  session: BrewvaManagedPromptSession,
  options: CliInteractiveSessionOptions,
): Promise<void> {
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
