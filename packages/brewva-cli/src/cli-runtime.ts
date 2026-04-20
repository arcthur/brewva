import process from "node:process";
import { runHostedPromptTurn } from "@brewva/brewva-gateway/host";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type {
  BrewvaManagedPromptSession,
  BrewvaPromptSessionEvent,
  BrewvaToolDefinition,
} from "@brewva/brewva-substrate";
import {
  extractMessageError,
  extractVisibleTextFromMessage,
  readMessageRole,
  readMessageStopReason,
} from "./message-content.js";
import type { BrewvaSessionResult } from "./session.js";
import type { CliShellSessionBundle } from "./shell/types.js";

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
  runtime: BrewvaRuntime;
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
  runtime: BrewvaRuntime;
  orchestration?: BrewvaSessionResult["orchestration"];
}): CliShellSessionBundle {
  return {
    session: input.session,
    runtime: input.runtime,
    toolDefinitions: createToolDefinitionMap(input.session),
    orchestration: input.orchestration,
  };
}

async function runCliTurn(
  session: BrewvaManagedPromptSession,
  prompt: string,
  options: {
    printText: boolean;
    runtime?: BrewvaRuntime;
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
    const output = await runHostedPromptTurn({
      session,
      parts: [{ type: "text", text: prompt }],
      source: "print",
      runtime: options.runtime,
      sessionId: session.sessionManager?.getSessionId?.(),
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

export async function runCliInteractiveSession(
  session: BrewvaManagedPromptSession,
  options: CliInteractiveSessionOptions,
  launchInteractiveShell: CliInteractiveShellLauncher,
): Promise<void> {
  await launchInteractiveShell(
    toCliShellSessionBundle({
      session,
      runtime: options.runtime,
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
          orchestration: bundle.orchestration,
        });
      },
    },
  );
}

export async function runCliPrintSession(
  session: BrewvaManagedPromptSession,
  options: {
    mode: CliPrintMode;
    initialMessage?: string;
    runtime?: BrewvaRuntime;
  },
): Promise<void> {
  if (typeof options.initialMessage !== "string" || options.initialMessage.trim().length === 0) {
    return;
  }

  await runCliTurn(session, options.initialMessage, {
    printText: options.mode === "text",
    runtime: options.runtime,
  });
}
