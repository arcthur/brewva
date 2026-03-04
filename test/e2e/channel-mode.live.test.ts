import { describe, expect } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  cleanupWorkspace,
  createWorkspace,
  repoRoot,
  runLive,
  writeMinimalConfig,
} from "./helpers.js";

interface TelegramRequestRecord {
  method: string;
  params: Record<string, unknown>;
}

interface TelegramApiCapture {
  getUpdatesCalls: number;
  requests: TelegramRequestRecord[];
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  onTimeout: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(onTimeout());
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body.trim()) {
    return {};
  }
  const decoded = JSON.parse(body) as unknown;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return {};
  }
  return decoded as Record<string, unknown>;
}

function writeJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

function createFakeTelegramApiServer(token: string): {
  server: Server;
  capture: TelegramApiCapture;
} {
  const capture: TelegramApiCapture = {
    getUpdatesCalls: 0,
    requests: [],
  };
  let delivered = false;
  const update = {
    update_id: 7001,
    message: {
      message_id: 71,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 12345, type: "private" },
      from: { id: 42, is_bot: false, first_name: "E2E" },
      text: "/agents",
    },
  };
  const methodPrefix = `/bot${token}/`;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.startsWith(methodPrefix)) {
      writeJson(res, 404, { ok: false, error: "not_found" });
      return;
    }
    const method = url.pathname.slice(methodPrefix.length);
    const params = await readJsonBody(req);

    if (method === "getUpdates") {
      capture.getUpdatesCalls += 1;
      const offset = typeof params.offset === "number" ? params.offset : 0;
      const shouldDeliver = !delivered && offset <= update.update_id;
      if (shouldDeliver) {
        delivered = true;
        writeJson(res, 200, { ok: true, result: [update] });
        return;
      }
      writeJson(res, 200, { ok: true, result: [] });
      return;
    }

    if (method === "sendMessage") {
      capture.requests.push({
        method,
        params,
      });
      writeJson(res, 200, {
        ok: true,
        result: {
          message_id: 9001,
        },
      });
      return;
    }

    if (method === "answerCallbackQuery") {
      capture.requests.push({
        method,
        params,
      });
      writeJson(res, 200, {
        ok: true,
        result: true,
      });
      return;
    }

    writeJson(res, 404, { ok: false, error: "method_not_found", method });
  });

  return { server, capture };
}

function listenServer(server: Server): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("fake telegram api address unavailable"));
        return;
      }
      resolve(address);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function spawnChannelProcess(input: { workspace: string; token: string; apiBaseUrl: string }): {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
} {
  const child = spawn(
    "bun",
    [
      "run",
      "start",
      "--cwd",
      input.workspace,
      "--channel",
      "telegram",
      "--telegram-token",
      input.token,
      "--telegram-poll-timeout",
      "1",
      "--telegram-poll-retry-ms",
      "50",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        BREWVA_TELEGRAM_API_BASE_URL: input.apiBaseUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function stopChildProcess(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return {
      code: child.exitCode,
      signal: child.signalCode,
    };
  }

  child.kill("SIGTERM");
  const exitPromise = once(child, "exit").then(
    ([code, signal]) =>
      ({
        code: typeof code === "number" ? code : null,
        signal: (signal as NodeJS.Signals | null) ?? null,
      }) as { code: number | null; signal: NodeJS.Signals | null },
  );
  const timeoutPromise = sleep(timeoutMs).then(async () => {
    child.kill("SIGKILL");
    throw new Error("channel process did not exit before timeout");
  });
  return await Promise.race([exitPromise, timeoutPromise]);
}

describe("e2e: channel mode live", () => {
  runLive(
    "polling channel mode processes /agents command through fake telegram api and emits outbound reply",
    async () => {
      const workspace = createWorkspace("channel-mode-live");
      writeMinimalConfig(workspace);

      const token = "bot-token";
      const fakeApi = createFakeTelegramApiServer(token);
      const address = await listenServer(fakeApi.server);
      const apiBaseUrl = `http://127.0.0.1:${address.port}`;
      const processHandle = spawnChannelProcess({
        workspace,
        token,
        apiBaseUrl,
      });

      try {
        await waitUntil(
          () => fakeApi.capture.requests.some((entry) => entry.method === "sendMessage"),
          20_000,
          () =>
            [
              "timed out waiting for sendMessage from channel mode",
              `getUpdatesCalls=${fakeApi.capture.getUpdatesCalls}`,
              `requests=${JSON.stringify(fakeApi.capture.requests)}`,
              `stdout=${processHandle.stdout().slice(-2000)}`,
              `stderr=${processHandle.stderr().slice(-2000)}`,
            ].join("\n"),
        );

        const sendRequest = fakeApi.capture.requests.find(
          (entry) => entry.method === "sendMessage",
        );
        expect(sendRequest).toBeDefined();
        const chatId = sendRequest?.params.chat_id;
        expect(typeof chatId === "string" || typeof chatId === "number").toBe(true);
        expect(Number(chatId)).toBe(12345);
        const text = sendRequest?.params.text;
        expect(typeof text).toBe("string");
        const outboundText = typeof text === "string" ? text : "";
        expect(outboundText).toContain("Focus:");
        expect(outboundText).toContain("Agents:");
        expect(outboundText).toContain("@default");

        const stop = await stopChildProcess(processHandle.child, 10_000);
        expect(stop.signal).toBeNull();
        expect(stop.code).toBe(0);
      } finally {
        processHandle.child.kill("SIGKILL");
        await closeServer(fakeApi.server);
        cleanupWorkspace(workspace);
      }
    },
  );
});
