import { createHash } from "node:crypto";
import {
  getDefaultMcpAdapterPool,
  type McpAdapterEvent,
  type McpAdapterPool,
  type McpToolCallResult,
  type McpTransportConfig,
} from "@brewva/brewva-mcp-adapter";
import type {
  BrewvaMcpIntegrationConfig,
  BrewvaMcpServerConfig,
  DeepReadonly,
  ToolActionClass,
} from "@brewva/brewva-runtime";
import type { BrewvaToolContentPart } from "@brewva/brewva-substrate";
import type { ToolCatalog, ToolDescriptor } from "@brewva/brewva-tool-protocol";
import {
  defineBrewvaTool,
  type BrewvaToolRequiredCapability,
  type BrewvaToolSurface,
} from "@brewva/brewva-tools";
import type { HostedSessionCustomTool } from "./hosted-session-driver.js";

const HOSTED_MCP_TOOL_NAME_PREFIX = "mcp";
const MAX_PROVIDER_TOOL_NAME_LENGTH = 64;
const DEFAULT_MCP_ACTION_CLASS: ToolActionClass = "external_side_effect";

export interface HostedSessionMcpToolPolicy {
  actionClass?: ToolActionClass;
  surface?: BrewvaToolSurface;
  requiredCapabilities?: readonly BrewvaToolRequiredCapability[];
}

export interface HostedSessionMcpToolAdapterLike {
  refresh(): Promise<ToolCatalog>;
  callTool(
    input: {
      name: string;
      arguments?: Record<string, unknown>;
    },
    options?: { signal?: AbortSignal },
  ): Promise<McpToolCallResult>;
  close?(): Promise<void>;
}

export interface HostedSessionMcpToolSource {
  serverId: string;
  adapter: HostedSessionMcpToolAdapterLike;
  catalog?: ToolCatalog;
  includeToolNames?: readonly string[];
  toolPolicies?: Record<string, HostedSessionMcpToolPolicy>;
}

export interface HostedMcpOperationalEvent {
  type:
    | "mcp_server_connected"
    | "mcp_server_disconnected"
    | "mcp_tool_list_refreshed"
    | "mcp_tool_call_failed";
  payload: Record<string, unknown>;
}

export interface HostedMcpToolBundle {
  tools: HostedSessionCustomTool[];
  dispose(): Promise<void>;
}

export interface CreateHostedMcpToolBundleOptions {
  recordEvent?: (event: HostedMcpOperationalEvent) => void | Promise<void>;
}

function normalizeHostedToolNamePart(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .replace(/_{2,}/gu, "_");
  return normalized.length > 0 ? normalized : fallback;
}

export function buildHostedMcpToolName(serverId: string, toolName: string): string {
  const normalizedServerId = normalizeHostedToolNamePart(serverId, "server");
  const normalizedToolName = normalizeHostedToolNamePart(toolName, "tool");
  const base = `${HOSTED_MCP_TOOL_NAME_PREFIX}__${normalizedServerId}__${normalizedToolName}`;
  if (base.length <= MAX_PROVIDER_TOOL_NAME_LENGTH) {
    return base;
  }
  const digest = createHash("sha256").update(base).digest("hex").slice(0, 8);
  const suffix = `__${digest}`;
  return `${base.slice(0, MAX_PROVIDER_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
}

function dataBytesFromBase64(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  return Math.floor((value.length * 3) / 4);
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function describeMcpContentRecord(record: Record<string, unknown>): string {
  const type = readString(record, "type") ?? "unknown";
  if (type === "audio") {
    const mimeType = readString(record, "mimeType", "mime_type") ?? "unknown";
    return `[MCP audio content: mimeType=${mimeType} dataBytes=${
      dataBytesFromBase64(readString(record, "data")) ?? "unknown"
    }]`;
  }
  if (type === "resource_link") {
    const uri = readString(record, "uri") ?? "unknown";
    const mimeType = readString(record, "mimeType", "mime_type") ?? "unknown";
    const name = readString(record, "name") ?? "unnamed";
    return `[MCP resource link: uri=${uri} name=${name} mimeType=${mimeType}]`;
  }
  if (type === "resource") {
    const resource = record.resource;
    if (resource && typeof resource === "object" && !Array.isArray(resource)) {
      const resourceRecord = resource as Record<string, unknown>;
      const uri = readString(resourceRecord, "uri") ?? "unknown";
      const mimeType = readString(resourceRecord, "mimeType", "mime_type") ?? "unknown";
      const name = readString(resourceRecord, "name") ?? "unnamed";
      return `[MCP resource: uri=${uri} name=${name} mimeType=${mimeType}]`;
    }
    return "[MCP resource: uri=unknown name=unnamed mimeType=unknown]";
  }
  return `[MCP ${type} content: omitted unsupported structured payload]`;
}

const RECEIPT_BINARY_DATA_BYTE_THRESHOLD = 1024;
const RECEIPT_RESOURCE_TEXT_CAP = 4096;

function summarizeReceiptBinary(record: Record<string, unknown>): Record<string, unknown> {
  const type = readString(record, "type") ?? "unknown";
  const mimeType =
    readString(record, "mimeType", "mime_type") ?? readString(record, "media_type") ?? "unknown";
  const dataValue = readString(record, "data");
  return {
    type,
    mimeType,
    dataBytes: dataBytesFromBase64(dataValue) ?? 0,
    dataOmitted: true,
  };
}

function summarizeReceiptResource(record: Record<string, unknown>): Record<string, unknown> {
  const resource = record.resource;
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
    return { type: "resource" };
  }
  const resourceRecord = resource as Record<string, unknown>;
  const summary: Record<string, unknown> = { type: "resource" };
  const uri = readString(resourceRecord, "uri");
  if (uri) summary.uri = uri;
  const mimeType = readString(resourceRecord, "mimeType", "mime_type");
  if (mimeType) summary.mimeType = mimeType;
  const name = readString(resourceRecord, "name");
  if (name) summary.name = name;
  const text = resourceRecord.text;
  if (typeof text === "string") {
    summary.text =
      text.length > RECEIPT_RESOURCE_TEXT_CAP ? text.slice(0, RECEIPT_RESOURCE_TEXT_CAP) : text;
    if (text.length > RECEIPT_RESOURCE_TEXT_CAP) {
      summary.textTruncated = true;
      summary.originalTextLength = text.length;
    }
  }
  const blob = readString(resourceRecord, "blob");
  if (blob) {
    summary.blobBytes = dataBytesFromBase64(blob) ?? 0;
    summary.blobOmitted = true;
  }
  return summary;
}

function summarizeMcpContentForReceipt(content: readonly unknown[]): unknown[] {
  return content.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }
    const record = item as Record<string, unknown>;
    const type = readString(record, "type");
    if (type === "text" && typeof record.text === "string") {
      return { type: "text", text: record.text };
    }
    if (type === "image" || type === "audio") {
      const dataValue = readString(record, "data");
      const dataBytes = dataBytesFromBase64(dataValue) ?? 0;
      if (dataBytes <= RECEIPT_BINARY_DATA_BYTE_THRESHOLD) {
        return record;
      }
      return summarizeReceiptBinary(record);
    }
    if (type === "resource") {
      return summarizeReceiptResource(record);
    }
    return record;
  });
}

function normalizeMcpToolContent(result: McpToolCallResult): BrewvaToolContentPart[] {
  const content = Array.isArray(result.content) ? result.content : [];
  const normalized = content.flatMap((item): BrewvaToolContentPart[] => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      return [{ type: "text", text: record.text }];
    }
    if (record.type === "image" && typeof record.data === "string") {
      return [
        {
          type: "image",
          data: record.data,
          mimeType: readString(record, "mimeType", "mime_type") ?? "application/octet-stream",
        },
      ];
    }
    return [{ type: "text", text: describeMcpContentRecord(record) }];
  });
  if (normalized.length > 0) {
    return normalized;
  }
  if (result.structuredContent !== undefined) {
    return [
      {
        type: "text",
        text: JSON.stringify(result.structuredContent, null, 2),
      },
    ];
  }
  return [{ type: "text", text: "" }];
}

function resolveMcpToolPolicy(
  source: HostedSessionMcpToolSource,
  descriptor: ToolDescriptor,
  hostedToolName: string,
): HostedSessionMcpToolPolicy {
  return (
    source.toolPolicies?.[descriptor.name] ??
    source.toolPolicies?.[hostedToolName] ??
    source.toolPolicies?.["*"] ??
    {}
  );
}

function resolveMcpActionClass(policy: HostedSessionMcpToolPolicy): ToolActionClass {
  return policy.actionClass ?? DEFAULT_MCP_ACTION_CLASS;
}

function recordEvent(
  options: CreateHostedMcpToolBundleOptions,
  event: HostedMcpOperationalEvent,
): void {
  void options.recordEvent?.(event);
}

function validateSource(source: HostedSessionMcpToolSource): string {
  const serverId = source.serverId.trim();
  if (!serverId) {
    throw new Error("MCP tool source is missing serverId");
  }
  return serverId;
}

export async function createHostedMcpToolBundle(
  sources: readonly HostedSessionMcpToolSource[] | undefined,
  options: CreateHostedMcpToolBundleOptions = {},
): Promise<HostedMcpToolBundle | undefined> {
  if (!sources || sources.length === 0) {
    return undefined;
  }

  const definitions: HostedSessionCustomTool[] = [];
  const hostedNames = new Set<string>();

  for (const source of sources) {
    const serverId = validateSource(source);
    const catalog = source.catalog ?? (await source.adapter.refresh());
    const includeToolNames = source.includeToolNames ? new Set(source.includeToolNames) : null;
    for (const entry of catalog.list()) {
      const descriptor = entry.descriptor;
      if (includeToolNames && !includeToolNames.has(descriptor.name)) {
        continue;
      }
      const hostedToolName = buildHostedMcpToolName(serverId, descriptor.name);
      if (hostedNames.has(hostedToolName)) {
        throw new Error(`Duplicate hosted MCP tool name: ${hostedToolName}`);
      }
      hostedNames.add(hostedToolName);
      const policy = resolveMcpToolPolicy(source, descriptor, hostedToolName);
      definitions.push(
        defineBrewvaTool(
          {
            name: hostedToolName,
            label: descriptor.label,
            description: descriptor.description,
            parameters: descriptor.parameters as never,
            async execute(_toolCallId, params, signal) {
              try {
                const result = await source.adapter.callTool(
                  {
                    name: descriptor.name,
                    arguments:
                      params && typeof params === "object"
                        ? (params as Record<string, unknown>)
                        : undefined,
                  },
                  { signal },
                );
                return {
                  content: normalizeMcpToolContent(result),
                  details: {
                    serverId,
                    mcpToolName: descriptor.name,
                    hostedToolName,
                    structuredContent: result.structuredContent,
                    content: summarizeMcpContentForReceipt(result.content ?? []),
                  },
                  isError: result.isError,
                };
              } catch (error) {
                recordEvent(options, {
                  type: "mcp_tool_call_failed",
                  payload: {
                    serverId,
                    toolName: descriptor.name,
                    hostedToolName,
                    error: error instanceof Error ? error.message : String(error),
                  },
                });
                throw error;
              }
            },
          },
          {
            surface: policy.surface ?? "base",
            actionClass: resolveMcpActionClass(policy),
            requiredCapabilities: policy.requiredCapabilities,
          },
        ),
      );
    }
  }

  if (definitions.length === 0) {
    return undefined;
  }

  return {
    tools: definitions,
    async dispose() {
      const results = await Promise.allSettled(
        sources.map(async (source) => await source.adapter.close?.()),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, "Failed to close one or more MCP adapters");
      }
    },
  };
}

function adaptMcpServerConfigTransport(
  server: DeepReadonly<BrewvaMcpServerConfig>,
): McpTransportConfig {
  if (server.transport === "stdio") {
    return {
      type: "stdio",
      command: server.command,
      args: [...server.args],
      env: { ...server.env },
    };
  }
  return {
    type: "streamable_http",
    url: server.url,
    requestInit:
      Object.keys(server.headers).length > 0
        ? {
            headers: { ...server.headers },
          }
        : undefined,
  };
}

function adaptMcpAdapterEvent(event: McpAdapterEvent): HostedMcpOperationalEvent {
  if (event.type === "server_connected") {
    return {
      type: "mcp_server_connected",
      payload: {
        serverId: event.serverId ?? null,
      },
    };
  }
  if (event.type === "server_disconnected") {
    return {
      type: "mcp_server_disconnected",
      payload: {
        serverId: event.serverId ?? null,
      },
    };
  }
  if (event.type === "tool_list_refreshed") {
    return {
      type: "mcp_tool_list_refreshed",
      payload: {
        serverId: event.serverId ?? null,
        toolCount: event.toolCount,
      },
    };
  }
  return {
    type: "mcp_tool_call_failed",
    payload: {
      serverId: event.serverId ?? null,
      toolName: event.toolName,
      error: event.error,
    },
  };
}

export interface CreateHostedMcpToolSourcesOptions extends CreateHostedMcpToolBundleOptions {
  pool?: McpAdapterPool;
}

export function createHostedMcpToolSourcesFromConfig(
  config: DeepReadonly<BrewvaMcpIntegrationConfig>,
  options: CreateHostedMcpToolSourcesOptions = {},
): HostedSessionMcpToolSource[] {
  if (!config.enabled) {
    return [];
  }
  const pool = options.pool ?? getDefaultMcpAdapterPool();
  return config.servers
    .filter((server) => server.enabled)
    .map((server) => ({
      serverId: server.id,
      includeToolNames: [...server.includeToolNames],
      toolPolicies: Object.fromEntries(
        Object.entries(server.toolPolicies).map(([name, policy]) => [
          name,
          { ...policy } as HostedSessionMcpToolPolicy,
        ]),
      ),
      adapter: pool.acquire({
        serverId: server.id,
        timeoutMs: server.timeoutMs,
        transport: adaptMcpServerConfigTransport(server),
        onEvent: (event) => recordEvent(options, adaptMcpAdapterEvent(event)),
      }),
    }));
}
