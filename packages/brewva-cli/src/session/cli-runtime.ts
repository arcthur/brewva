import process from "node:process";
import { runEdgeOperation } from "@brewva/brewva-effect";
import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import {
  createProviderConnectionPort,
  createProviderConnectionSeams,
  runHostedPromptTurn,
} from "@brewva/brewva-gateway/hosted";
import type { HostedRuntimeAdapterPort } from "@brewva/brewva-gateway/hosted";
import type {
  BrewvaManagedPromptSession,
  BrewvaPromptSessionEvent,
} from "@brewva/brewva-substrate/session";
import type { BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import type { SessionPromptSnapshot } from "@brewva/brewva-vocabulary/session";
import {
  extractMessageError,
  extractVisibleTextFromMessage,
  readMessageRole,
  readMessageStopReason,
} from "../io/message-content.js";
import { createCliRuntimePorts, type CliOperatorPort } from "../runtime/cli-runtime-ports.js";
import type { CliShellSessionBundle } from "../shell/ports/session-port.js";
import type { BrewvaSessionResult } from "./session.js";

type CliPrintMode = "json" | "text";

export interface CliInteractiveShellOptions {
  cwd: string;
  initialMessage?: string;
  verbose?: boolean;
  openSession(sessionId: string): Promise<BrewvaSessionResult>;
  createSession(): Promise<BrewvaSessionResult>;
  onSessionChange?(result: BrewvaSessionResult): void;
}

export interface CliInteractiveSessionOptions extends CliInteractiveShellOptions {
  runtime: HostedRuntimeAdapterPort;
  providerConnections?: BrewvaSessionResult["providerConnections"];
  initPhases: BrewvaSessionResult["initPhases"];
  phase: BrewvaSessionResult["phase"];
  orchestration?: BrewvaSessionResult["orchestration"];
}

export interface CliInteractiveSmokeResult {
  backend: "opentui";
  screenMode: "alternate-screen";
  label?: string;
}

export type CliInteractiveShellLauncher = (
  bundle: CliShellSessionBundle,
  options: {
    cwd: string;
    initialMessage?: string;
    verbose?: boolean;
    openSession(sessionId: string): Promise<CliShellSessionBundle>;
    createSession(): Promise<CliShellSessionBundle>;
    onBundleChange?(bundle: CliShellSessionBundle): void;
  },
) => Promise<void>;

function writeStdout(text: string): void {
  if (text.length === 0) {
    return;
  }
  process.stdout.write(text);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function createToolDefinitionMap(
  session: BrewvaManagedPromptSession,
): ReadonlyMap<string, BrewvaToolDefinition> {
  return new Map(
    session
      .getRegisteredTools()
      .map((tool) => [tool.name, tool] satisfies [string, BrewvaToolDefinition]),
  );
}

function toCliShellSessionBundle(input: {
  session: BrewvaManagedPromptSession;
  runtime: HostedRuntimeAdapterPort;
  providerConnections?: BrewvaSessionResult["providerConnections"];
  initPhases: BrewvaSessionResult["initPhases"];
  phase: BrewvaSessionResult["phase"];
  orchestration?: BrewvaSessionResult["orchestration"];
}): CliShellSessionBundle {
  const { inspect, operator } = createCliRuntimePorts(input.runtime);
  return {
    session: input.session,
    runtime: input.runtime,
    inspect,
    operator,
    toolDefinitions: createToolDefinitionMap(input.session),
    providerConnections:
      input.providerConnections ??
      (input.session.modelRegistry
        ? createProviderConnectionSeams(
            createProviderConnectionPort({
              runtime: input.runtime,
              modelRegistry: input.session.modelRegistry,
            }),
          )
        : undefined),
    initPhases: input.initPhases,
    phase: input.phase,
    orchestration: input.orchestration,
  };
}

async function runCliTurn(
  session: BrewvaManagedPromptSession,
  prompt: string,
  options: {
    printText: boolean;
    runtime: HostedRuntimeAdapterPort;
    operator: CliOperatorPort;
  },
): Promise<string> {
  let emittedText = "";
  let streamedText = false;
  let terminalAssistantError: string | undefined;

  const unsubscribe = session.subscribe((event: BrewvaPromptSessionEvent) => {
    if (event.type === "message_update") {
      const deltaEvent = asRecord(event.assistantMessageEvent);
      if (
        deltaEvent?.type === "text_delta" &&
        typeof deltaEvent.delta === "string" &&
        deltaEvent.delta.length > 0
      ) {
        emittedText += deltaEvent.delta;
        if (options.printText) {
          streamedText = true;
          writeStdout(deltaEvent.delta);
        }
      }
      return;
    }

    if (event.type !== "message_end") {
      return;
    }

    if (readMessageRole(event.message) !== "assistant") {
      return;
    }

    if (readMessageStopReason(event.message) === "error") {
      terminalAssistantError = extractMessageError(event.message) ?? "Assistant turn failed.";
      return;
    }

    const fallbackText = extractVisibleTextFromMessage(event.message);
    if (fallbackText.length === 0 || emittedText.length > 0) {
      return;
    }
    emittedText = fallbackText;
    if (options.printText) {
      streamedText = true;
      writeStdout(fallbackText);
    }
  });

  try {
    const sessionId = session.sessionManager?.getSessionId?.()?.trim();
    if (!sessionId) {
      throw new Error("cli_print_session_missing_session_id");
    }
    const parts = [{ type: "text" as const, text: prompt }];
    options.operator.session.recordCheckpoint(sessionId, {
      turnId: `print:${Date.now()}`,
      prompt: {
        text: prompt,
        parts: structuredClone(parts) as unknown as SessionPromptSnapshot["parts"],
      },
    });
    const output = await runHostedPromptTurn({
      session,
      parts,
      source: "print",
      runtime: options.runtime,
      sessionId,
    });
    if (output.status === "failed") {
      throw output.error instanceof Error ? output.error : new Error(String(output.error));
    }
    if (output.status === "completed" && emittedText.length === 0) {
      emittedText = output.assistantText;
      if (options.printText) {
        streamedText = true;
        writeStdout(output.assistantText);
      }
    }
    await session.waitForIdle();
  } finally {
    unsubscribe();
  }

  if (terminalAssistantError) {
    throw new Error(terminalAssistantError);
  }

  if (options.printText && streamedText && !emittedText.endsWith("\n")) {
    writeStdout("\n");
  }

  return emittedText;
}

export async function runCliInteractiveSessionOperation(
  session: BrewvaManagedPromptSession,
  options: CliInteractiveSessionOptions,
  launchInteractiveShell: CliInteractiveShellLauncher,
): Promise<void> {
  await launchInteractiveShell(
    toCliShellSessionBundle({
      session,
      runtime: options.runtime,
      providerConnections: options.providerConnections,
      initPhases: options.initPhases,
      phase: options.phase,
      orchestration: options.orchestration,
    }),
    {
      cwd: options.cwd,
      initialMessage: options.initialMessage,
      verbose: options.verbose,
      async openSession(sessionId) {
        const result = await options.openSession(sessionId);
        options.onSessionChange?.(result);
        return toCliShellSessionBundle(result);
      },
      async createSession() {
        const result = await options.createSession();
        options.onSessionChange?.(result);
        return toCliShellSessionBundle(result);
      },
      onBundleChange(bundle) {
        options.onSessionChange?.({
          session: bundle.session,
          runtime: bundle.runtime,
          initPhases: bundle.initPhases,
          phase: bundle.phase,
          orchestration: bundle.orchestration,
        });
      },
    },
  );
}

export function runCliInteractiveShellEffect(
  session: BrewvaManagedPromptSession,
  options: CliInteractiveSessionOptions,
  launchInteractiveShell: CliInteractiveShellLauncher,
): BrewvaEffect.Effect<void, unknown> {
  return BrewvaEffect.promise(() =>
    runCliInteractiveSessionOperation(session, options, launchInteractiveShell),
  );
}

export async function runCliInteractiveSession(
  session: BrewvaManagedPromptSession,
  options: CliInteractiveSessionOptions,
  launchInteractiveShell: CliInteractiveShellLauncher,
): Promise<void> {
  return await runEdgeOperation(
    "brewva.cli.interactive",
    runCliInteractiveShellEffect(session, options, launchInteractiveShell),
    {
      fields: {
        cwd: options.cwd,
      },
    },
  );
}

export async function runCliPrintSession(
  session: BrewvaManagedPromptSession,
  options: {
    mode: CliPrintMode;
    initialMessage?: string;
    runtime: HostedRuntimeAdapterPort;
    operator: CliOperatorPort;
  },
): Promise<void> {
  if (typeof options.initialMessage !== "string" || options.initialMessage.trim().length === 0) {
    return;
  }

  await runCliTurn(session, options.initialMessage, {
    printText: options.mode === "text",
    runtime: options.runtime,
    operator: options.operator,
  });
}
