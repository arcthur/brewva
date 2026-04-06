import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GatewayDaemon,
  PROTOCOL_VERSION,
  readGatewayToken,
  type SessionBackend,
} from "@brewva/brewva-gateway";
import WebSocket, { type RawData } from "ws";

export interface PolicyRule {
  id: string;
  intervalMinutes: number;
  prompt: string;
  sessionId?: string;
}

export interface RawEventFrame {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
}

export interface RawResponseFrame {
  type: "res";
  id: string;
  traceId?: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code?: string;
    message?: string;
  };
}

export interface DaemonHarness {
  root: string;
  policyPath: string;
  token: string;
  tokenFilePath: string;
  daemon: GatewayDaemon;
  host: string;
  port: number;
  healthHttpPort?: number;
  healthHttpPath?: string;
  dispose: () => Promise<void>;
}

export function writeHeartbeatPolicy(policyPath: string, rules: PolicyRule[]): void {
  writeFileSync(
    policyPath,
    ["# HEARTBEAT", "", "```heartbeat", JSON.stringify({ rules }), "```", ""].join("\n"),
    "utf8",
  );
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => {
        rejectPromise(new Error(message));
      },
      Math.max(100, timeoutMs),
    );
    timer.unref?.();

    promise
      .then((value) => {
        clearTimeout(timer);
        resolvePromise(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        rejectPromise(error);
      });
  });
}

function rawToText(raw: RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  return raw.toString("utf8");
}

function parseRawFrame(raw: RawData): unknown {
  try {
    return JSON.parse(rawToText(raw)) as unknown;
  } catch {
    return undefined;
  }
}

export async function waitForRawFrame<T>(
  ws: WebSocket,
  predicate: (frame: unknown) => frame is T,
  timeoutMs = 3_000,
): Promise<T> {
  return await withTimeout(
    new Promise<T>((resolveFrame, rejectFrame) => {
      const onMessage = (raw: RawData): void => {
        const frame = parseRawFrame(raw);
        if (!predicate(frame)) {
          return;
        }
        ws.off("message", onMessage);
        ws.off("close", onClose);
        resolveFrame(frame);
      };
      const onClose = (): void => {
        ws.off("message", onMessage);
        ws.off("close", onClose);
        rejectFrame(new Error("socket closed before expected frame"));
      };

      ws.on("message", onMessage);
      ws.once("close", onClose);
    }),
    timeoutMs,
    "timed out waiting for websocket frame",
  );
}

export async function waitForNoRawFrame<T>(
  ws: WebSocket,
  predicate: (frame: unknown) => frame is T,
  timeoutMs = 700,
): Promise<void> {
  await withTimeout(
    new Promise<void>((resolveNoFrame, rejectNoFrame) => {
      const timer = setTimeout(
        () => {
          ws.off("message", onMessage);
          ws.off("close", onClose);
          resolveNoFrame();
        },
        Math.max(100, timeoutMs),
      );
      timer.unref?.();

      const onMessage = (raw: RawData): void => {
        const frame = parseRawFrame(raw);
        if (!predicate(frame)) {
          return;
        }
        clearTimeout(timer);
        ws.off("message", onMessage);
        ws.off("close", onClose);
        rejectNoFrame(new Error("received unexpected websocket frame"));
      };
      const onClose = (): void => {
        clearTimeout(timer);
        ws.off("message", onMessage);
        ws.off("close", onClose);
        resolveNoFrame();
      };

      ws.on("message", onMessage);
      ws.once("close", onClose);
    }),
    timeoutMs + 200,
    "timed out waiting for no-frame assertion",
  );
}

export async function sendRawRequest(
  ws: WebSocket,
  method: string,
  params: unknown,
  timeoutMs = 3_000,
  options: {
    traceId?: string;
  } = {},
): Promise<RawResponseFrame> {
  const id = randomUUID();
  const responsePromise = waitForRawFrame<RawResponseFrame>(
    ws,
    (frame: unknown): frame is RawResponseFrame => {
      if (!frame || typeof frame !== "object") {
        return false;
      }
      const row = frame as Partial<RawResponseFrame>;
      return row.type === "res" && row.id === id;
    },
    timeoutMs,
  );

  await new Promise<void>((resolveSend, rejectSend) => {
    ws.send(
      JSON.stringify({
        type: "req",
        id,
        traceId: options.traceId,
        method,
        params,
      }),
      (error?: Error) => {
        if (error) {
          rejectSend(error);
          return;
        }
        resolveSend();
      },
    );
  });

  return await responsePromise;
}

export async function connectRawAuthenticated(input: {
  host: string;
  port: number;
  token: string;
}): Promise<WebSocket> {
  const ws = new WebSocket(`ws://${input.host}:${input.port}`);
  await withTimeout(
    new Promise<void>((resolveOpen, rejectOpen) => {
      ws.once("open", () => resolveOpen());
      ws.once("error", rejectOpen);
    }),
    3_000,
    "websocket open timeout",
  );

  const challengeFrame = await waitForRawFrame<RawEventFrame>(
    ws,
    (frame: unknown): frame is RawEventFrame => {
      if (!frame || typeof frame !== "object") {
        return false;
      }
      const row = frame as Partial<RawEventFrame>;
      return row.type === "event" && row.event === "connect.challenge";
    },
  );
  const challengeNonce =
    challengeFrame.payload &&
    typeof challengeFrame.payload === "object" &&
    typeof (challengeFrame.payload as { nonce?: unknown }).nonce === "string"
      ? ((challengeFrame.payload as { nonce: string }).nonce ?? "")
      : "";
  if (!challengeNonce) {
    throw new Error("missing challenge nonce");
  }

  const connectResult = await sendRawRequest(ws, "connect", {
    protocol: PROTOCOL_VERSION,
    client: {
      id: "integration-raw",
      version: "0.1.0",
    },
    auth: { token: input.token },
    challengeNonce,
  });
  if (!connectResult.ok) {
    await closeRawSocket(ws);
    throw new Error(`raw connect failed: ${connectResult.error?.message ?? "unknown"}`);
  }
  return ws;
}

export async function closeRawSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }

  await withTimeout(
    new Promise<void>((resolveClose) => {
      ws.once("close", () => resolveClose());
      try {
        ws.close();
      } catch {
        ws.terminate();
        resolveClose();
      }
    }),
    2_000,
    "timed out closing raw websocket",
  ).catch(() => {
    ws.terminate();
  });
}

export async function startDaemonHarness(
  initialRules: PolicyRule[],
  options: {
    healthHttpPort?: number;
    healthHttpPath?: string;
    scheduleEnabled?: boolean;
    sessionBackend?: SessionBackend;
  } = {},
): Promise<DaemonHarness> {
  const root = mkdtempSync(join(tmpdir(), "brewva-gateway-integration-"));
  const stateDir = join(root, "state");
  const policyPath = join(root, "HEARTBEAT.md");
  const tokenFilePath = join(stateDir, "gateway.token");

  mkdirSync(join(root, ".brewva"), { recursive: true });
  if (options.scheduleEnabled === true) {
    writeFileSync(
      join(root, ".brewva", "brewva.json"),
      JSON.stringify(
        {
          schedule: {
            enabled: true,
          },
        },
        null,
        2,
      ),
      "utf8",
    );
  }
  writeHeartbeatPolicy(policyPath, initialRules);
  const port = await allocatePort();

  const daemon = new GatewayDaemon({
    host: "127.0.0.1",
    port,
    stateDir,
    pidFilePath: join(stateDir, "gateway.pid.json"),
    logFilePath: join(stateDir, "gateway.log"),
    tokenFilePath,
    heartbeatPolicyPath: policyPath,
    cwd: root,
    tickIntervalMs: 1_000,
    healthHttpPort: options.healthHttpPort,
    healthHttpPath: options.healthHttpPath,
    sessionBackend: options.sessionBackend,
  });
  await daemon.start();
  const runtime = daemon.getRuntimeInfo();
  const token = readGatewayToken(tokenFilePath);
  if (!token) {
    await daemon.stop("missing_token_after_start").catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    throw new Error("gateway token file missing after daemon start");
  }

  return {
    root,
    policyPath,
    token,
    tokenFilePath,
    daemon,
    host: runtime.host,
    port: runtime.port,
    healthHttpPort: runtime.healthHttpPort,
    healthHttpPath: runtime.healthHttpPath,
    dispose: async () => {
      await daemon.stop("test_dispose").catch(() => undefined);
      await daemon.waitForStop().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address !== "object") {
        probe.close(() => {
          rejectPort(new Error("failed to allocate local port"));
        });
        return;
      }
      const resolvedPort = address.port;
      probe.close((error) => {
        if (error) {
          rejectPort(error);
          return;
        }
        resolvePort(resolvedPort);
      });
    });
    probe.unref();
  });
}

export function injectWorkerEvent(daemon: GatewayDaemon, event: string, payload: unknown): void {
  daemon.testHooks.injectWorkerEvent(
    event as Parameters<GatewayDaemon["testHooks"]["injectWorkerEvent"]>[0],
    payload,
  );
}

export async function waitForSocketClose(
  ws: WebSocket,
  timeoutMs = 3_000,
): Promise<{ code: number; reason: string }> {
  return await withTimeout(
    new Promise<{ code: number; reason: string }>((resolveClose) => {
      ws.once("close", (code, reason) => {
        resolveClose({
          code,
          reason: reason.toString("utf8"),
        });
      });
    }),
    timeoutMs,
    "timed out waiting for socket close",
  );
}
