import {
  BrewvaCancelled,
  BrewvaDuration,
  BrewvaEffect,
  BrewvaTimeout,
  fromAbortableBoundaryPromise,
  runEdgeOperation,
  type BrewvaBoundaryError,
} from "@brewva/brewva-effect";
import { stableJsonStringify } from "@brewva/brewva-std/json";
import {
  createToolCatalog,
  type JsonSchema,
  type ToolCatalog,
  type ToolDescriptor,
} from "@brewva/brewva-substrate/tools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

export interface McpToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpToolCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface McpToolCallResult {
  isError: boolean;
  structuredContent?: unknown;
  content: readonly unknown[];
}

export type McpTransportConfig =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      envAllowlist?: string[];
      inheritEnv?: false;
    }
  | {
      type: "streamable_http";
      url: string;
      requestInit?: RequestInit;
    };

export interface McpClientLike {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  listTools(input?: { cursor?: string }): Promise<{ tools: McpTool[]; nextCursor?: string }>;
  callTool(input: McpToolCall, options?: McpToolCallOptions): Promise<McpToolCallResult>;
}

export type McpAdapterEvent =
  | { type: "server_connected"; serverId?: string }
  | { type: "server_disconnected"; serverId?: string }
  | { type: "tool_list_refreshed"; serverId?: string; toolCount: number }
  | { type: "tool_call_failed"; serverId?: string; toolName: string; error: string };

export type McpAdapterRuntimeError = BrewvaBoundaryError | BrewvaTimeout;

type McpAdapterEventWithoutServerId =
  | { type: "server_connected" }
  | { type: "server_disconnected" }
  | { type: "tool_list_refreshed"; toolCount: number }
  | { type: "tool_call_failed"; toolName: string; error: string };

export interface McpToolCatalogAdapterOptions {
  transport: McpTransportConfig;
  clientInfo?: {
    name: string;
    version: string;
  };
  serverId?: string;
  timeoutMs?: number;
  onEvent?: (event: McpAdapterEvent) => void | Promise<void>;
  createClient?: () => McpClientLike;
}

function isFunction(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

function assertMcpClientLike(value: unknown): asserts value is McpClientLike {
  if (!value || typeof value !== "object") {
    throw new Error("MCP client factory returned a non-object client");
  }
  const record = value as Record<string, unknown>;
  for (const method of ["connect", "close", "listTools", "callTool"] as const) {
    if (!isFunction(record[method])) {
      throw new Error(`MCP client is missing required method: ${method}`);
    }
  }
}

function createMcpClient(clientInfo?: { name: string; version: string }): McpClientLike {
  const client = new Client(clientInfo ?? { name: "brewva-mcp", version: "0.1.0" });
  assertMcpClientLike(client);
  return client;
}

function createMcpTransport(config: McpTransportConfig): unknown {
  if (config.type === "stdio") {
    const inheritEnv = (config as { inheritEnv?: boolean }).inheritEnv;
    if (inheritEnv) {
      throw new Error("MCP stdio inheritEnv must be false; use envAllowlist for explicit keys.");
    }
    const inherited = Object.fromEntries(
      (config.envAllowlist ?? []).flatMap((key): Array<[string, string]> => {
        const value = process.env[key];
        return typeof value === "string" ? [[key, value]] : [];
      }),
    );
    const env = Object.fromEntries(
      Object.entries({
        ...inherited,
        ...config.env,
      }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
    return new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env,
    });
  }
  if (config.type === "streamable_http") {
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.requestInit,
    });
  }
  throw new Error(`Unsupported MCP transport: ${(config as { type?: string }).type ?? "unknown"}`);
}

export function mcpToolToDescriptor(tool: McpTool): ToolDescriptor {
  const title =
    "title" in tool && typeof tool.title === "string" && tool.title.trim().length > 0
      ? tool.title
      : undefined;
  const outputSchema =
    "outputSchema" in tool && tool.outputSchema && typeof tool.outputSchema === "object"
      ? (tool.outputSchema as JsonSchema)
      : undefined;
  const annotations =
    "annotations" in tool && tool.annotations && typeof tool.annotations === "object"
      ? (tool.annotations as Record<string, unknown>)
      : undefined;
  return {
    name: tool.name,
    label: title ?? tool.name,
    title,
    description: tool.description ?? "",
    parameters: (tool.inputSchema ?? {
      type: "object",
      properties: {},
      additionalProperties: true,
    }) as JsonSchema,
    outputSchema,
    annotations,
  };
}

export class McpToolCatalogAdapter {
  readonly #client: McpClientLike;
  readonly #transportConfig: McpTransportConfig;
  readonly #serverId: string | undefined;
  readonly #timeoutMs: number | undefined;
  readonly #onEvent: ((event: McpAdapterEvent) => void | Promise<void>) | undefined;
  #connected = false;
  #connectPromise: Promise<void> | null = null;

  constructor(options: McpToolCatalogAdapterOptions) {
    const client = options.createClient?.() ?? createMcpClient(options.clientInfo);
    assertMcpClientLike(client);
    this.#client = client;
    this.#transportConfig = options.transport;
    this.#serverId = options.serverId;
    this.#timeoutMs = options.timeoutMs;
    this.#onEvent = options.onEvent;
  }

  #emit(event: McpAdapterEventWithoutServerId): void {
    void this.#onEvent?.({ ...event, serverId: this.#serverId } as McpAdapterEvent);
  }

  #operationTimeoutMs(timeoutMs?: number): number | undefined {
    const resolved = timeoutMs ?? this.#timeoutMs;
    return typeof resolved === "number" && Number.isFinite(resolved) && resolved > 0
      ? Math.floor(resolved)
      : undefined;
  }

  #withMcpOperationGuardEffect<T>(
    _operation: "connect" | "list_tools" | "call_tool" | "close",
    run: (signal: AbortSignal) => Promise<T>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): BrewvaEffect.Effect<T, McpAdapterRuntimeError> {
    if (options.signal?.aborted) {
      return BrewvaEffect.fail(
        new BrewvaCancelled({
          message: "MCP operation was aborted",
        }),
      );
    }
    const timeoutMs = this.#operationTimeoutMs(options.timeoutMs);
    const guarded = fromAbortableBoundaryPromise(run, options.signal);
    const abortable = options.signal
      ? BrewvaEffect.raceFirst(
          guarded,
          fromAbortableBoundaryPromise<never>(
            (signal) =>
              new Promise<never>((_resolve, reject) => {
                const rejectAborted = () =>
                  reject(
                    new BrewvaCancelled({
                      message: "MCP operation was aborted",
                    }),
                  );
                if (signal.aborted) {
                  rejectAborted();
                  return;
                }
                signal.addEventListener("abort", rejectAborted, { once: true });
              }),
            options.signal,
          ),
        )
      : guarded;
    if (!timeoutMs) {
      return abortable;
    }
    const timedOut = BrewvaEffect.sleep(BrewvaDuration.millis(timeoutMs)).pipe(
      BrewvaEffect.andThen(
        BrewvaEffect.fail(
          new BrewvaTimeout({
            message: `MCP operation timed out after ${timeoutMs}ms`,
            timeoutMs,
          }),
        ),
      ),
    );
    return BrewvaEffect.raceFirst(abortable, timedOut);
  }

  async #withOperationGuard<T>(
    operation: "connect" | "list_tools" | "call_tool" | "close",
    run: (signal: AbortSignal) => Promise<T>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    return await runEdgeOperation(
      `brewva.mcp.adapter.${operation}`,
      this.#withMcpOperationGuardEffect(operation, run, options),
      {
        fields: {
          operation,
          serverId: this.#serverId,
        },
      },
    );
  }

  async connect(): Promise<void> {
    if (this.#connected) {
      return;
    }
    if (!this.#connectPromise) {
      this.#connectPromise = (async () => {
        await this.#withOperationGuard("connect", () =>
          this.#client.connect(createMcpTransport(this.#transportConfig)),
        );
        this.#connected = true;
        this.#emit({ type: "server_connected" });
      })();
    }
    try {
      await this.#connectPromise;
    } finally {
      this.#connectPromise = null;
    }
  }

  async refresh(): Promise<ToolCatalog> {
    await this.connect();
    const catalog = createToolCatalog();
    const seenNames = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.#withOperationGuard("list_tools", () =>
        this.#client.listTools(cursor ? { cursor } : undefined),
      );
      for (const tool of page.tools) {
        if (seenNames.has(tool.name)) {
          throw new Error(
            `Duplicate MCP tool name from server${this.#serverId ? ` ${this.#serverId}` : ""}: ${tool.name}`,
          );
        }
        seenNames.add(tool.name);
        catalog.upsert({
          descriptor: mcpToolToDescriptor(tool),
          origin: "mcp",
          definition: tool,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    this.#emit({ type: "tool_list_refreshed", toolCount: seenNames.size });
    return catalog;
  }

  async callTool(input: McpToolCall, options: McpToolCallOptions = {}): Promise<McpToolCallResult> {
    await this.connect();
    try {
      return await this.#withOperationGuard(
        "call_tool",
        (signal) => this.#client.callTool(input, { ...options, signal }),
        options,
      );
    } catch (error) {
      this.#emit({
        type: "tool_call_failed",
        toolName: input.name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.#connected) {
      return;
    }
    try {
      await this.#withOperationGuard("close", () => this.#client.close());
    } finally {
      this.#connected = false;
      this.#emit({ type: "server_disconnected" });
    }
  }
}

export interface PooledMcpAdapter {
  refresh(): Promise<ToolCatalog>;
  callTool(input: McpToolCall, options?: McpToolCallOptions): Promise<McpToolCallResult>;
  close(): Promise<void>;
}

export interface McpAdapterPoolStats {
  size: number;
  entries: Array<{
    serverId?: string;
    refCount: number;
  }>;
}

interface PoolEntry {
  adapter: McpToolCatalogAdapter;
  refCount: number;
  serverId: string | undefined;
  listeners: Set<(event: McpAdapterEvent) => void | Promise<void>>;
}

function normalizeRequestInitForKey(init: RequestInit | undefined): unknown {
  if (!init) {
    return undefined;
  }
  let headers: Record<string, string> | undefined;
  if (init.headers) {
    headers = {};
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => {
        headers![key.toLowerCase()] = value;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [key, value] of init.headers) {
        headers[key.toLowerCase()] = value;
      }
    } else {
      for (const [key, value] of Object.entries(init.headers)) {
        if (typeof value === "string") {
          headers[key.toLowerCase()] = value;
        }
      }
    }
  }
  return { method: init.method, headers };
}

export function computeMcpTransportPoolKey(transport: McpTransportConfig): string {
  if (transport.type === "stdio") {
    return stableJsonStringify({
      type: "stdio",
      command: transport.command,
      args: transport.args ?? [],
      env: transport.env ?? {},
      envAllowlist: transport.envAllowlist ?? [],
    });
  }
  return stableJsonStringify({
    type: "streamable_http",
    url: transport.url,
    requestInit: normalizeRequestInitForKey(transport.requestInit),
  });
}

export class McpAdapterPool {
  readonly #entries = new Map<string, PoolEntry>();

  acquire(options: McpToolCatalogAdapterOptions): PooledMcpAdapter {
    const key = computeMcpTransportPoolKey(options.transport);
    let entry = this.#entries.get(key);
    if (!entry) {
      const listeners = new Set<(event: McpAdapterEvent) => void | Promise<void>>();
      const adapter = new McpToolCatalogAdapter({
        ...options,
        onEvent: (event) => {
          for (const listener of listeners) {
            try {
              void listener(event);
            } catch {
              // Listener errors must not break other consumers.
            }
          }
        },
      });
      entry = {
        adapter,
        refCount: 0,
        serverId: options.serverId,
        listeners,
      };
      this.#entries.set(key, entry);
    }
    if (options.onEvent) {
      entry.listeners.add(options.onEvent);
    }
    entry.refCount += 1;
    const ownEntry = entry;
    let released = false;
    return {
      refresh: () => ownEntry.adapter.refresh(),
      callTool: (input, callOptions) => ownEntry.adapter.callTool(input, callOptions),
      close: async () => {
        if (released) {
          return;
        }
        released = true;
        ownEntry.refCount -= 1;
        const isFinalLease = ownEntry.refCount <= 0 && this.#entries.get(key) === ownEntry;
        if (isFinalLease) {
          this.#entries.delete(key);
          try {
            // Keep the listener attached during close so consumers receive their own
            // server_disconnected event before the lease falls silent.
            await ownEntry.adapter.close();
          } finally {
            if (options.onEvent) {
              ownEntry.listeners.delete(options.onEvent);
            }
          }
        } else if (options.onEvent) {
          ownEntry.listeners.delete(options.onEvent);
        }
      },
    };
  }

  stats(): McpAdapterPoolStats {
    return {
      size: this.#entries.size,
      entries: [...this.#entries.values()].map((entry) => ({
        serverId: entry.serverId,
        refCount: entry.refCount,
      })),
    };
  }

  async closeAll(): Promise<void> {
    const adapters = [...this.#entries.values()].map((entry) => entry.adapter);
    this.#entries.clear();
    const results = await Promise.allSettled(adapters.map((adapter) => adapter.close()));
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to close one or more pooled MCP adapters");
    }
  }
}

let DEFAULT_MCP_ADAPTER_POOL: McpAdapterPool | undefined;

export function getDefaultMcpAdapterPool(): McpAdapterPool {
  if (!DEFAULT_MCP_ADAPTER_POOL) {
    DEFAULT_MCP_ADAPTER_POOL = new McpAdapterPool();
  }
  return DEFAULT_MCP_ADAPTER_POOL;
}

export function resetDefaultMcpAdapterPoolForTests(): void {
  DEFAULT_MCP_ADAPTER_POOL = undefined;
}
