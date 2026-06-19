import { randomUUID } from "node:crypto";
import process from "node:process";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Agent,
  type CancelNotification,
  type InitializeResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionNotification,
  type StopReason,
  type ToolCallStatus,
} from "@agentclientprotocol/sdk";
import {
  connectGatewayClient,
  queryGatewayStatus,
  readGatewayToken,
  resolveGatewayPaths,
} from "@brewva/brewva-gateway/ingress";
import {
  validateSessionWireFramePayload,
  type GatewayMethod,
  type GatewayParamsByMethod,
} from "@brewva/brewva-gateway/protocol";
import { readNonEmptyString } from "@brewva/brewva-std/text";
import { isRecord, toErrorMessage } from "@brewva/brewva-std/unknown";
import type { ManagedToolMode } from "@brewva/brewva-vocabulary/session";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";

type SessionsAbortParams = GatewayParamsByMethod["sessions.abort"];
type SessionsCloseParams = GatewayParamsByMethod["sessions.close"];
type SessionsOpenParams = GatewayParamsByMethod["sessions.open"];
type SessionsSendParams = GatewayParamsByMethod["sessions.send"];
type SessionsSubscribeParams = GatewayParamsByMethod["sessions.subscribe"];

export type AcpPromptRequestLike = Pick<Partial<PromptRequest>, "sessionId"> & {
  readonly prompt: readonly unknown[];
};

export interface AcpSessionOpenInput {
  readonly sessionId?: unknown;
  readonly cwd?: unknown;
  readonly configPath?: unknown;
  readonly model?: unknown;
  readonly agentId?: unknown;
  readonly managedToolMode?: unknown;
}

export interface AcpSessionSendInput {
  readonly sessionId?: unknown;
  readonly request: AcpPromptRequestLike;
  readonly turnId?: unknown;
}

export interface AcpSessionAbortInput {
  readonly sessionId?: unknown;
  readonly notification?: Partial<CancelNotification>;
  readonly reason?: unknown;
}

export interface AcpSessionCloseInput {
  readonly sessionId?: unknown;
}

export interface AcpGatewayConnection {
  readonly sessionUpdate: (params: SessionNotification) => Promise<void>;
}

export interface AcpGatewayClientEventLike {
  readonly event: string;
  readonly payload?: unknown;
}

export interface AcpGatewayClientLike {
  readonly request: <K extends GatewayMethod>(
    method: K,
    params: GatewayParamsByMethod[K],
    options?: { readonly traceId?: string },
  ) => Promise<unknown>;
  readonly onEvent: (listener: (event: AcpGatewayClientEventLike) => void) => () => void;
}

export type AcpGatewaySessionWireFrame = SessionWireFrame;

export type AcpGatewaySessionWireListener = (frame: AcpGatewaySessionWireFrame) => void;

export interface AcpGatewaySessionPort {
  readonly onSessionWireFrame: (listener: AcpGatewaySessionWireListener) => () => void;
  readonly openSession: (input: AcpSessionOpenInput) => Promise<unknown>;
  readonly subscribeSession: (sessionId: string) => Promise<unknown>;
  readonly sendPrompt: (input: AcpSessionSendInput) => Promise<unknown>;
  readonly abortSession: (input: AcpSessionAbortInput) => Promise<unknown>;
  readonly closeSession: (input: AcpSessionCloseInput) => Promise<unknown>;
}

export interface AcpGatewayClientSessionPortOptions {
  readonly sessionDefaults?: AcpSessionOpenInput;
}

export interface AcpGatewayAgentOptions {
  readonly connection: AcpGatewayConnection;
  readonly sessions: AcpGatewaySessionPort;
  readonly agentName?: string;
  readonly agentVersion?: string;
  readonly promptTimeoutMs?: number;
  readonly shutdownSignal?: AbortSignal;
}

export interface AcpGatewayStdioOptions {
  readonly cwd?: string;
  readonly configPath?: string;
  readonly model?: string;
  readonly agentId?: string;
  readonly managedToolMode?: ManagedToolMode;
  readonly env?: Record<string, string | undefined>;
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly agentVersion?: string;
}

export interface AcpGatewaySessionPortFromEnv {
  readonly sessions: AcpGatewaySessionPort;
  readonly close: () => Promise<void>;
}

type TextPromptBlock = {
  readonly type: "text";
  readonly text: string;
};
type ToolSessionWireFrame = Extract<
  AcpGatewaySessionWireFrame,
  { readonly type: "tool.started" | "tool.progress" | "tool.finished" }
>;

const DEFAULT_AGENT_VERSION = "0.1.0";
const DEFAULT_PROMPT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60_000;

function requireNonEmptyString(value: unknown, label: string): string {
  const normalized = readNonEmptyString(value);
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function formatPromptBlockType(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return value === undefined ? "unknown" : typeof value;
}

function assignOptionalString<K extends string>(
  target: Partial<Record<K, string>>,
  key: K,
  value: unknown,
): void {
  const normalized = readNonEmptyString(value);
  if (normalized) {
    target[key] = normalized;
  }
}

function readTextPromptBlock(value: unknown): TextPromptBlock {
  if (!isRecord(value)) {
    throw new Error("unsupported ACP prompt block type: unknown");
  }
  const type = value.type;
  if (type !== "text") {
    throw new Error(`unsupported ACP prompt block type: ${formatPromptBlockType(type)}`);
  }
  const text = readNonEmptyString(value.text);
  if (!text) {
    throw new Error("ACP prompt requires non-empty text content");
  }
  return { type, text };
}

function readGatewaySessionId(payload: unknown): string {
  const record = isRecord(payload) ? payload : {};
  return requireNonEmptyString(record.requestedSessionId ?? record.sessionId, "gateway session id");
}

function readGatewayTurnId(payload: unknown): string | undefined {
  return readNonEmptyString(isRecord(payload) ? payload.turnId : undefined);
}

function assertGatewayAccepted(payload: unknown): void {
  if (isRecord(payload) && payload.accepted === false) {
    throw new Error("gateway did not accept the turn");
  }
}

function readSessionWireFrame(payload: unknown): AcpGatewaySessionWireFrame | undefined {
  const result = validateSessionWireFramePayload(payload);
  return result.ok ? result.frame : undefined;
}

function toStopReason(status: unknown): StopReason {
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "refusal";
  return "end_turn";
}

function toToolStatus(frame: ToolSessionWireFrame): ToolCallStatus {
  if (frame.type === "tool.started") return "pending";
  if (frame.type === "tool.progress") return "in_progress";
  if (frame.isError || frame.verdict === "failed") return "failed";
  return "completed";
}

function assertNeverSessionWireFrame(frame: never): never {
  const type = (frame as { readonly type?: unknown }).type;
  throw new Error(`unhandled session wire frame: ${typeof type === "string" ? type : "unknown"}`);
}

function resolveGatewayEnv(input: { readonly env: Record<string, string | undefined> }): {
  readonly paths: ReturnType<typeof resolveGatewayPaths>;
  readonly hostOverride?: string;
  readonly portOverride?: number;
} {
  const env = input.env;
  const paths = resolveGatewayPaths({
    stateDir: readNonEmptyString(env.BREWVA_GATEWAY_STATE_DIR),
    pidFilePath: readNonEmptyString(env.BREWVA_GATEWAY_PID_FILE),
    tokenFilePath: readNonEmptyString(env.BREWVA_GATEWAY_TOKEN_FILE),
  });
  const rawPortOverride = Number(env.BREWVA_GATEWAY_PORT);
  const portOverride =
    Number.isInteger(rawPortOverride) && rawPortOverride > 0 ? rawPortOverride : undefined;
  return {
    paths,
    hostOverride: readNonEmptyString(env.BREWVA_GATEWAY_HOST),
    portOverride,
  };
}

function createTimeoutPromise<T>(timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((_, reject) => {
    const timer = setTimeout(
      () => {
        reject(new Error(message));
      },
      Math.max(100, timeoutMs),
    );
    timer.unref?.();
  });
}

async function emitTextUpdate(input: {
  readonly connection: AcpGatewayConnection;
  readonly sessionId: string;
  readonly sessionUpdate: "agent_message_chunk" | "agent_thought_chunk";
  readonly text: string;
}): Promise<void> {
  if (!input.text) return;
  await input.connection.sessionUpdate({
    sessionId: input.sessionId,
    update: {
      sessionUpdate: input.sessionUpdate,
      content: { type: "text", text: input.text },
    },
  });
}

async function emitToolUpdate(input: {
  readonly connection: AcpGatewayConnection;
  readonly frame: ToolSessionWireFrame;
}): Promise<void> {
  const toolCallId = input.frame.toolCallId.trim();
  if (!toolCallId) return;
  const toolName = input.frame.toolName.trim() || "tool";
  if (input.frame.type === "tool.started") {
    await input.connection.sessionUpdate({
      sessionId: input.frame.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: toolName,
        kind: "other",
        status: "pending",
        rawInput: { toolName },
      },
    });
    return;
  }

  const text = input.frame.text.trim();
  await input.connection.sessionUpdate({
    sessionId: input.frame.sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: toToolStatus(input.frame),
      ...(text
        ? {
            content: [
              {
                type: "content",
                content: { type: "text", text },
              },
            ],
          }
        : {}),
      rawOutput: {
        verdict: input.frame.verdict,
        isError: input.frame.isError,
        text: input.frame.text,
        details: input.frame.details,
        display: input.frame.display,
      },
    },
  });
}

export function extractAcpPromptText(prompt: readonly unknown[]): string {
  if (!Array.isArray(prompt) || prompt.length === 0) {
    throw new Error("ACP prompt requires non-empty text content");
  }
  const text = prompt
    .map(readTextPromptBlock)
    .map((block) => block.text)
    .join("\n\n");
  if (!text.trim()) {
    throw new Error("ACP prompt requires non-empty text content");
  }
  return text;
}

export function toBrewvaSessionOpenParams(input: AcpSessionOpenInput): SessionsOpenParams {
  const params: SessionsOpenParams = {};
  assignOptionalString(params, "sessionId", input.sessionId);
  assignOptionalString(params, "cwd", input.cwd);
  assignOptionalString(params, "configPath", input.configPath);
  assignOptionalString(params, "model", input.model);
  assignOptionalString(params, "agentId", input.agentId);
  if (input.managedToolMode === "hosted" || input.managedToolMode === "direct") {
    params.managedToolMode = input.managedToolMode;
  }
  return params;
}

export function toBrewvaSessionSendParams(input: AcpSessionSendInput): SessionsSendParams {
  const sessionId = requireNonEmptyString(
    input.sessionId ?? input.request.sessionId,
    "ACP sessionId",
  );
  const prompt = extractAcpPromptText(input.request.prompt);
  const turnId = readNonEmptyString(input.turnId);
  return {
    sessionId,
    prompt,
    ...(turnId ? { turnId } : {}),
  };
}

export function toBrewvaSessionAbortParams(input: AcpSessionAbortInput): SessionsAbortParams {
  const sessionId = requireNonEmptyString(
    input.sessionId ?? input.notification?.sessionId,
    "ACP sessionId",
  );
  return {
    sessionId,
    ...(input.reason === "user_submit" ? { reason: input.reason } : {}),
  };
}

export function toBrewvaSessionCloseParams(input: AcpSessionCloseInput): SessionsCloseParams {
  return {
    sessionId: requireNonEmptyString(input.sessionId, "ACP sessionId"),
  };
}

export function createAcpGatewayClientSessionPort(
  client: AcpGatewayClientLike,
  options: AcpGatewayClientSessionPortOptions = {},
): AcpGatewaySessionPort {
  return {
    onSessionWireFrame(listener) {
      return client.onEvent((event) => {
        if (event.event !== "session.wire.frame") {
          return;
        }
        const frame = readSessionWireFrame(event.payload);
        if (frame) {
          listener(frame);
        }
      });
    },
    async openSession(input) {
      const merged = { ...options.sessionDefaults, ...input };
      return await client.request("sessions.open", toBrewvaSessionOpenParams(merged));
    },
    async subscribeSession(sessionId) {
      const params: SessionsSubscribeParams = {
        sessionId: requireNonEmptyString(sessionId, "ACP sessionId"),
      };
      return await client.request("sessions.subscribe", params);
    },
    async sendPrompt(input) {
      return await client.request("sessions.send", toBrewvaSessionSendParams(input));
    },
    async abortSession(input) {
      return await client.request("sessions.abort", toBrewvaSessionAbortParams(input));
    },
    async closeSession(input) {
      return await client.request("sessions.close", toBrewvaSessionCloseParams(input));
    },
  };
}

export function createAcpGatewayAgent(options: AcpGatewayAgentOptions): Agent {
  const promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
  const openSessionIds = new Set<string>();
  const pendingPrompts = new Set<{
    readonly sessionId: string;
    readonly reject: (error: unknown) => void;
  }>();
  let shutdownStarted = false;

  const shutdownOpenSessions = async (): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;

    const error = new Error("ACP connection closed");
    const prompts = [...pendingPrompts];
    for (const prompt of prompts) {
      prompt.reject(error);
    }

    await Promise.allSettled(
      prompts.map((prompt) =>
        options.sessions.abortSession({ sessionId: prompt.sessionId, reason: "user_submit" }),
      ),
    );
    await Promise.allSettled(
      [...openSessionIds].map((sessionId) => options.sessions.closeSession({ sessionId })),
    );
    openSessionIds.clear();
  };

  if (options.shutdownSignal) {
    if (options.shutdownSignal.aborted) {
      void shutdownOpenSessions();
    } else {
      options.shutdownSignal.addEventListener(
        "abort",
        () => {
          void shutdownOpenSessions();
        },
        { once: true },
      );
    }
  }

  return {
    async initialize(): Promise<InitializeResponse> {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: {
          name: options.agentName ?? "Brewva",
          title: "Brewva",
          version: options.agentVersion ?? DEFAULT_AGENT_VERSION,
        },
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: {},
        },
      };
    },
    async authenticate() {
      return {};
    },
    async newSession(params) {
      if (shutdownStarted || options.shutdownSignal?.aborted) {
        throw new Error("ACP connection closed");
      }
      if (params.mcpServers.length > 0) {
        throw new Error("ACP MCP servers are not supported by Brewva gateway sessions");
      }
      const payload = await options.sessions.openSession({ cwd: params.cwd });
      const sessionId = readGatewaySessionId(payload);
      await options.sessions.subscribeSession(sessionId);
      openSessionIds.add(sessionId);
      return { sessionId };
    },
    async prompt(params): Promise<PromptResponse> {
      if (shutdownStarted || options.shutdownSignal?.aborted) {
        throw new Error("ACP connection closed");
      }
      const sessionId = requireNonEmptyString(params.sessionId, "ACP sessionId");
      const requestedTurnId = randomUUID();
      let expectedTurnId: string = requestedTurnId;
      let emittedAnswer = false;
      let settled = false;
      let updateQueue: Promise<void> = Promise.resolve();
      let resolveCompletion: ((response: PromptResponse) => void) | undefined;
      let rejectCompletion: ((error: unknown) => void) | undefined;

      const completion = new Promise<PromptResponse>((resolve, reject) => {
        resolveCompletion = (response) => {
          if (settled) return;
          settled = true;
          resolve(response);
        };
        rejectCompletion = (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        };
      });
      const pendingPrompt = {
        sessionId,
        reject: (error: unknown) => {
          rejectCompletion?.(error);
        },
      };
      pendingPrompts.add(pendingPrompt);

      const handleSessionWireFrame = async (frame: AcpGatewaySessionWireFrame): Promise<void> => {
        if (settled) return;
        switch (frame.type) {
          case "assistant.delta": {
            emittedAnswer = emittedAnswer || frame.lane === "answer";
            await emitTextUpdate({
              connection: options.connection,
              sessionId,
              sessionUpdate:
                frame.lane === "thinking" ? "agent_thought_chunk" : "agent_message_chunk",
              text: frame.delta,
            });
            return;
          }

          case "tool.started":
          case "tool.progress":
          case "tool.finished":
            await emitToolUpdate({ connection: options.connection, frame });
            return;

          case "turn.committed": {
            const assistantText = frame.assistantText.trim();
            if (!emittedAnswer && assistantText) {
              emittedAnswer = true;
              await emitTextUpdate({
                connection: options.connection,
                sessionId,
                sessionUpdate: "agent_message_chunk",
                text: assistantText,
              });
            }
            resolveCompletion?.({ stopReason: toStopReason(frame.status) });
            return;
          }

          case "turn.transition":
            if (frame.status === "cancelled" || frame.status === "failed") {
              resolveCompletion?.({ stopReason: toStopReason(frame.status) });
            }
            return;

          case "session.closed":
            resolveCompletion?.({ stopReason: "cancelled" });
            return;

          case "replay.begin":
          case "replay.complete":
          case "session.status":
          case "turn.input":
          case "attempt.started":
          case "attempt.superseded":
          case "approval.requested":
          case "approval.decided":
            return;

          default:
            assertNeverSessionWireFrame(frame);
        }
      };

      const dispose = options.sessions.onSessionWireFrame((frame) => {
        if (settled || frame.sessionId !== sessionId) return;
        if (frame.turnId && frame.turnId !== expectedTurnId) return;

        updateQueue = updateQueue.then(
          () => handleSessionWireFrame(frame),
          () => handleSessionWireFrame(frame),
        );
        void updateQueue.catch((error) => {
          rejectCompletion?.(error);
        });
      });

      try {
        const sendPayload = await options.sessions.sendPrompt({
          sessionId,
          request: params,
          turnId: requestedTurnId,
        });
        assertGatewayAccepted(sendPayload);
        expectedTurnId = readGatewayTurnId(sendPayload) ?? requestedTurnId;
        return await Promise.race([
          completion,
          createTimeoutPromise<PromptResponse>(promptTimeoutMs, "gateway turn timed out"),
        ]);
      } catch (error) {
        rejectCompletion?.(error);
        throw error;
      } finally {
        pendingPrompts.delete(pendingPrompt);
        dispose();
      }
    },
    async cancel(params) {
      await options.sessions.abortSession({ notification: params, reason: "user_submit" });
    },
    async setSessionMode() {
      return {};
    },
  };
}

export async function createAcpGatewayClientSessionPortFromEnv(
  options: AcpGatewayStdioOptions = {},
): Promise<AcpGatewaySessionPortFromEnv> {
  const env = options.env ?? process.env;
  const { paths, hostOverride, portOverride } = resolveGatewayEnv({ env });
  const status = await queryGatewayStatus({
    paths,
    deep: false,
    timeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    hostOverride,
    portOverride,
  });
  if (!status.running) {
    throw new Error("gateway daemon is not running");
  }
  if (!status.reachable) {
    throw new Error(status.error ?? "gateway daemon is not reachable");
  }

  const host = readNonEmptyString(status.host);
  const port = typeof status.port === "number" && Number.isInteger(status.port) ? status.port : 0;
  if (!host || port <= 0) {
    throw new Error("gateway status did not return a valid host/port");
  }
  const token = readGatewayToken(paths.tokenFilePath);
  if (!token) {
    throw new Error(`gateway token missing: ${paths.tokenFilePath}`);
  }

  const client = await connectGatewayClient({
    host,
    port,
    token,
    clientId: "brewva-acp",
    clientVersion: options.agentVersion ?? DEFAULT_AGENT_VERSION,
    clientMode: "acp",
    connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  });

  return {
    sessions: createAcpGatewayClientSessionPort(client, {
      sessionDefaults: {
        cwd: options.cwd,
        configPath: options.configPath,
        model: options.model,
        agentId: options.agentId,
        managedToolMode: options.managedToolMode,
      },
    }),
    close: async () => {
      await client.close().catch(() => undefined);
    },
  };
}

export async function runAcpGatewayStdioAgent(options: AcpGatewayStdioOptions = {}): Promise<void> {
  const connected = await createAcpGatewayClientSessionPortFromEnv(options);
  try {
    const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
    // Readable.toWeb yields node's web ReadableStream; the CLI package's DOM lib
    // narrows the global ReadableStream type, so bridge through unknown at this stdio seam.
    const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(output, input);
    const connection = new AgentSideConnection(
      (conn) =>
        createAcpGatewayAgent({
          connection: conn,
          sessions: connected.sessions,
          agentVersion: options.agentVersion,
          shutdownSignal: conn.signal,
        }),
      stream,
    );
    await connection.closed;
  } catch (error) {
    throw new Error(`ACP gateway agent failed: ${toErrorMessage(error)}`, { cause: error });
  } finally {
    await connected.close();
  }
}
