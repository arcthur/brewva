import process from "node:process";
import readline from "node:readline/promises";
import type {
  BrewvaManagedPromptSession,
  BrewvaPromptSessionEvent,
} from "@brewva/brewva-substrate";

type CliPrintMode = "json" | "text";

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

function extractVisibleTextFromMessage(message: unknown): string {
  const record = asRecord(message);
  if (!record) {
    return "";
  }

  const directContent = record.content;
  if (typeof directContent === "string") {
    return directContent;
  }
  if (typeof record.text === "string") {
    return record.text;
  }
  if (!Array.isArray(directContent)) {
    return "";
  }

  const segments: string[] = [];
  for (const part of directContent) {
    if (typeof part === "string") {
      segments.push(part);
      continue;
    }
    const contentPart = asRecord(part);
    if (!contentPart) {
      continue;
    }
    if (typeof contentPart.text === "string") {
      segments.push(contentPart.text);
      continue;
    }
    const nested = asRecord(contentPart.content);
    if (nested && typeof nested.text === "string") {
      segments.push(nested.text);
    }
  }
  return segments.join("");
}

async function runCliTurn(
  session: BrewvaManagedPromptSession,
  prompt: string,
  options: {
    printText: boolean;
  },
): Promise<string> {
  let emittedText = "";
  let streamedText = false;

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
    await session.prompt(prompt, { source: "interactive" });
    await session.waitForIdle();
  } finally {
    unsubscribe();
  }

  if (options.printText && streamedText && !emittedText.endsWith("\n")) {
    writeStdout("\n");
  }

  return emittedText;
}

function printInteractiveBanner(session: BrewvaManagedPromptSession): void {
  const sessionId = session.sessionManager.getSessionId();
  const model =
    session.model && session.model.provider && session.model.id
      ? `${session.model.provider}/${session.model.id}`
      : "unresolved-model";
  writeStdout(`Session ${sessionId} (${model})\n`);
}

export async function runCliInteractiveSession(
  session: BrewvaManagedPromptSession,
  options: {
    initialMessage?: string;
    verbose?: boolean;
  },
): Promise<void> {
  if (options.verbose) {
    printInteractiveBanner(session);
  }

  if (typeof options.initialMessage === "string" && options.initialMessage.trim().length > 0) {
    await runCliTurn(session, options.initialMessage, { printText: true });
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 1_000,
  });

  try {
    rl.setPrompt("> ");
    rl.prompt();
    for await (const line of rl) {
      const prompt = line.trim();
      if (prompt.length === 0) {
        rl.prompt();
        continue;
      }
      if (prompt === "/exit" || prompt === "/quit") {
        break;
      }
      await runCliTurn(session, prompt, { printText: true });
      rl.prompt();
    }
  } finally {
    rl.close();
  }
}

export async function runCliPrintSession(
  session: BrewvaManagedPromptSession,
  options: {
    mode: CliPrintMode;
    initialMessage?: string;
  },
): Promise<void> {
  if (typeof options.initialMessage !== "string" || options.initialMessage.trim().length === 0) {
    return;
  }

  await runCliTurn(session, options.initialMessage, {
    printText: options.mode === "text",
  });
}
