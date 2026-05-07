import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { BrewvaEffect, startScopedTimeout, type ScopedTimeoutHandle } from "@brewva/brewva-effect";

function writeOsc52ToStdout(text: string): boolean {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  const sequence = process.env.TMUX
    ? `\x1bPtmux;\x1b\x1b]52;c;${encoded}\x07\x1b\\`
    : `\x1b]52;c;${encoded}\x07`;
  return process.stdout.write(sequence);
}

function runClipboardCommand(command: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let settled = false;
    let timeout: ScopedTimeoutHandle | undefined;
    const settle = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      void timeout?.close();
      complete();
    };
    timeout = startScopedTimeout({
      delayMs: 2_000,
      run: () =>
        BrewvaEffect.sync(() => {
          settle(() => {
            child.kill("SIGTERM");
            reject(new Error(`${command} clipboard command timed out.`));
          });
        }),
    });
    child.on("error", (error) => {
      settle(() => reject(error));
    });
    child.on("close", (code) => {
      if (code === 0) {
        settle(resolve);
        return;
      }
      settle(() =>
        reject(new Error(`${command} clipboard command exited with code ${code ?? -1}.`)),
      );
    });
    child.stdin.end(text);
  });
}

async function copyWithNativeClipboard(text: string): Promise<void> {
  if (process.platform === "darwin") {
    await runClipboardCommand("pbcopy", [], text);
    return;
  }
  if (process.platform === "win32") {
    await runClipboardCommand(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard"],
      text,
    );
    return;
  }

  const candidates: Array<[command: string, args: string[]]> = process.env.WAYLAND_DISPLAY
    ? [["wl-copy", []]]
    : [];
  candidates.push(["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]);

  let lastError: unknown;
  for (const [command, args] of candidates) {
    try {
      await runClipboardCommand(command, args, text);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("No native clipboard command succeeded.");
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (!text) {
    throw new Error("No clipboard text to copy.");
  }
  let copiedWithOsc52 = false;
  try {
    copiedWithOsc52 = writeOsc52ToStdout(text);
  } catch {
    copiedWithOsc52 = false;
  }
  try {
    await copyWithNativeClipboard(text);
  } catch (error) {
    if (copiedWithOsc52) {
      return;
    }
    throw error instanceof Error ? error : new Error("Failed to copy text to clipboard.");
  }
}
