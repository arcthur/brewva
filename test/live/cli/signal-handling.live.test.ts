import { describe, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { hasProviderRateLimitText, skipLiveForProviderRateLimit } from "../../helpers/cli.js";
import { writeMinimalConfig } from "../../helpers/config.js";
import { parseEventFile, requireLatestEventFile } from "../../helpers/events.js";
import { runLive } from "../../helpers/live.js";
import { cleanupWorkspace, createWorkspace, repoRoot } from "../../helpers/workspace.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForEventType(
  workspace: string,
  eventType: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const eventFile = requireLatestEventFile(workspace, `wait for ${eventType}`);
      const events = parseEventFile(eventFile);
      if (events.some((event) => event.type === eventType)) {
        return eventFile;
      }
    } catch {
      // Event file persistence is asynchronous; keep polling until timeout.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for event type: ${eventType}`);
}

function assertInterruptedExit(exit: { code: number | null; signal: NodeJS.Signals | null }): void {
  if (exit.code === 130 || exit.signal === "SIGINT") {
    return;
  }
  throw new Error(`Expected SIGINT exit, received code=${exit.code} signal=${exit.signal}.`);
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for child process exit after ${timeoutMs}ms`));
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

describe("live: signal handling", () => {
  runLive("SIGINT emits session_interrupted and exits with code 130", async () => {
    const workspace = createWorkspace("signal");
    writeMinimalConfig(workspace);

    const child = spawn(
      "bun",
      [
        "run",
        "start",
        "--cwd",
        workspace,
        "--print",
        "Read every file in the current directory recursively and list all filenames.",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    try {
      await waitForEventType(workspace, "session_start", 30_000);
      await delay(500);

      if (child.exitCode !== null && hasProviderRateLimitText(stdout, stderr)) {
        console.warn(
          "[signal.live] skipped because child exited early due upstream model quota/rate-limit.",
        );
        return;
      }

      const killed = child.kill("SIGINT");
      expect(killed).toBe(true);

      const exit = await waitForExit(child, 60_000);
      assertInterruptedExit(exit);

      const eventFile = requireLatestEventFile(workspace, "signal live session");
      const events = parseEventFile(eventFile, { strict: true });
      expect(events.map((event) => event.type)).toContain("session_interrupted");
    } catch (error) {
      if (skipLiveForProviderRateLimit("signal.live", stdout, stderr)) {
        return;
      }
      const message = [
        error instanceof Error ? error.message : String(error),
        "[signal.live] stdout:",
        stdout.trim(),
        "[signal.live] stderr:",
        stderr.trim(),
      ].join("\n");
      throw new Error(message, { cause: error });
    } finally {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
      cleanupWorkspace(workspace);
    }
  });

  runLive("SIGINT in json mode does not emit final bundle", async () => {
    const workspace = createWorkspace("signal-json");
    writeMinimalConfig(workspace);

    const child = spawn(
      "bun",
      [
        "run",
        "start",
        "--cwd",
        workspace,
        "--mode",
        "json",
        "Read every file in the current directory recursively and list all filenames.",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    try {
      await waitForEventType(workspace, "session_start", 30_000);
      await delay(500);

      if (child.exitCode !== null && hasProviderRateLimitText(stdout, stderr)) {
        console.warn(
          "[signal-json.live] skipped because child exited early due upstream model quota/rate-limit.",
        );
        return;
      }

      const killed = child.kill("SIGINT");
      expect(killed).toBe(true);

      const exit = await waitForExit(child, 60_000);
      assertInterruptedExit(exit);

      expect(stdout).not.toContain('"type":"brewva_event_bundle"');
      expect(stdout).not.toContain('"schema":"brewva.stream.v1"');

      const eventFile = requireLatestEventFile(workspace, "signal json session");
      const events = parseEventFile(eventFile, { strict: true });
      expect(events.map((event) => event.type)).toContain("session_interrupted");
    } catch (error) {
      if (skipLiveForProviderRateLimit("signal-json.live", stdout, stderr)) {
        return;
      }
      const message = [
        error instanceof Error ? error.message : String(error),
        "[signal-json.live] stdout:",
        stdout.trim(),
        "[signal-json.live] stderr:",
        stderr.trim(),
      ].join("\n");
      throw new Error(message, { cause: error });
    } finally {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
      cleanupWorkspace(workspace);
    }
  });
});
