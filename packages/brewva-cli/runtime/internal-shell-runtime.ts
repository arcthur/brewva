import { BrewvaEffect, runEdgeOperation } from "@brewva/brewva-effect";
import type { BrewvaManagedPromptSession } from "@brewva/brewva-substrate/session";
import {
  runCliInteractiveShellEffect,
  runCliInteractiveSessionOperation as runCliInteractiveSessionBaseOperation,
  type CliInteractiveSessionOptions,
  type CliInteractiveSmokeResult,
} from "../src/cli-runtime.js";
import { renderCliInteractiveOpenTuiShell } from "./opentui-shell-renderer.js";

const BREWVA_SHELL_SMOKE_ENV = "BREWVA_SHELL_SMOKE";

export const CLI_INTERNAL_SHELL_RUNTIME_KIND = "bun-runtime";

export function isCliInteractiveRuntimeAvailable(): boolean {
  return true;
}

export async function runCliInteractiveSmoke(): Promise<CliInteractiveSmokeResult> {
  const { runOpenTuiSmoke } = await import("@brewva/brewva-tui/internal-opentui-runtime");
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

  await runCliInteractiveSessionBaseOperation(session, options, async (bundle, shellOptions) => {
    await renderCliInteractiveOpenTuiShell(bundle, shellOptions);
  });
}

export function runCliInteractiveSessionEffect(
  session: BrewvaManagedPromptSession,
  options: CliInteractiveSessionOptions,
): BrewvaEffect.Effect<void, unknown> {
  if (process.env[BREWVA_SHELL_SMOKE_ENV] === "1") {
    return BrewvaEffect.promise(() => runCliInteractiveSmoke());
  }
  return runCliInteractiveShellEffect(session, options, async (bundle, shellOptions) => {
    await renderCliInteractiveOpenTuiShell(bundle, shellOptions);
  });
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
