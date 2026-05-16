import {
  isRecord,
  normalizeBoolean,
  normalizeNonEmptyString,
  normalizeOptionalNonEmptyString,
  normalizePositiveInteger,
  normalizeStrictStringEnum,
  normalizeStringArray,
  normalizeStringRecord,
} from "./normalization-shared.js";
import type {
  BrewvaConfig,
  BrewvaMcpIntegrationConfig,
  BrewvaMcpServerConfig,
  BrewvaMcpToolPolicyConfig,
  BrewvaMcpToolSurfaceOverride,
} from "./types.js";

const MCP_SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/u;
const MCP_TRANSPORTS = new Set(["stdio", "streamable_http"]);
const MCP_TOOL_SURFACES = new Set(["base", "skill", "control_plane", "operator"]);
const MCP_ACTION_CLASSES = new Set([
  "workspace_read",
  "runtime_observe",
  "workspace_patch",
  "memory_write",
  "control_state_mutation",
  "budget_mutation",
  "local_exec_readonly",
  "local_exec_effectful",
  "external_side_effect",
  "schedule_mutation",
  "delegation",
  "credential_access",
]);

function normalizeMcpToolPolicy(value: unknown, fieldPath: string): BrewvaMcpToolPolicyConfig {
  if (!isRecord(value)) {
    throw new Error(`Invalid config value for ${fieldPath}: expected object.`);
  }
  const actionClass = normalizeOptionalNonEmptyString(value.actionClass);
  const surface = normalizeOptionalNonEmptyString(value.surface);
  return {
    ...(actionClass
      ? {
          actionClass: normalizeStrictStringEnum(
            actionClass,
            "external_side_effect",
            MCP_ACTION_CLASSES,
            `${fieldPath}.actionClass`,
          ),
        }
      : {}),
    ...(surface
      ? {
          surface: normalizeStrictStringEnum(
            surface,
            "base",
            MCP_TOOL_SURFACES,
            `${fieldPath}.surface`,
          ) as BrewvaMcpToolSurfaceOverride,
        }
      : {}),
  };
}

function normalizeMcpToolPolicies(
  value: unknown,
  fieldPath: string,
): Record<string, BrewvaMcpToolPolicyConfig> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error(`Invalid config value for ${fieldPath}: expected object.`);
  }
  const output: Record<string, BrewvaMcpToolPolicyConfig> = {};
  for (const [rawName, rawPolicy] of Object.entries(value)) {
    const name = rawName.trim();
    if (!name) {
      throw new Error(`Invalid config value for ${fieldPath}: tool policy name cannot be empty.`);
    }
    output[name] = normalizeMcpToolPolicy(rawPolicy, `${fieldPath}.${name}`);
  }
  return output;
}

function normalizeMcpServerConfig(value: unknown, index: number): BrewvaMcpServerConfig {
  const fieldPath = `integrations.mcp.servers[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`Invalid config value for ${fieldPath}: expected object.`);
  }

  if (value.transport === undefined) {
    throw new Error(
      `Invalid config value for ${fieldPath}.transport: expected one of [stdio, streamable_http].`,
    );
  }
  const transport = normalizeStrictStringEnum(
    value.transport,
    "stdio",
    MCP_TRANSPORTS,
    `${fieldPath}.transport`,
  );
  const id = normalizeNonEmptyString(value.id, "");
  if (!MCP_SERVER_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid config value for ${fieldPath}.id: expected 1-48 characters matching ${MCP_SERVER_ID_PATTERN.source}.`,
    );
  }
  const base = {
    id,
    enabled: normalizeBoolean(value.enabled, true),
    timeoutMs: normalizePositiveInteger(value.timeoutMs, 30_000),
    includeToolNames: normalizeStringArray(value.includeToolNames, []),
    toolPolicies: normalizeMcpToolPolicies(value.toolPolicies, `${fieldPath}.toolPolicies`),
  };

  if (transport === "stdio") {
    if (value.inheritEnv !== undefined && value.inheritEnv !== false) {
      throw new Error(
        `Invalid config value for ${fieldPath}.inheritEnv: inheritEnv has been removed; stdio integrations must use envAllowlist.`,
      );
    }
    const command = normalizeNonEmptyString(value.command, "");
    if (!command) {
      throw new Error(`Invalid config value for ${fieldPath}.command: expected non-empty string.`);
    }
    return {
      ...base,
      transport,
      command,
      args: normalizeStringArray(value.args, []),
      env: normalizeStringRecord(value.env, {}),
      envAllowlist: normalizeStringArray(value.envAllowlist, []),
      inheritEnv: false,
    };
  }

  const url = normalizeNonEmptyString(value.url, "");
  if (!url) {
    throw new Error(`Invalid config value for ${fieldPath}.url: expected non-empty string.`);
  }
  return {
    ...base,
    transport,
    url,
    headers: normalizeStringRecord(value.headers, {}),
  };
}

function normalizeMcpIntegrationConfig(
  value: unknown,
  fallback: BrewvaMcpIntegrationConfig,
): BrewvaMcpIntegrationConfig {
  const input = isRecord(value) ? value : {};
  const rawServers = Array.isArray(input.servers) ? input.servers : fallback.servers;
  const servers = rawServers.map((server, index) => normalizeMcpServerConfig(server, index));
  const seenIds = new Set<string>();
  for (const server of servers) {
    if (seenIds.has(server.id)) {
      throw new Error(
        `Invalid config value for integrations.mcp.servers: duplicate server id "${server.id}".`,
      );
    }
    seenIds.add(server.id);
  }
  return {
    enabled: normalizeBoolean(input.enabled, fallback.enabled),
    servers,
  };
}

export function normalizeIntegrationsConfig(
  value: unknown,
  fallback: BrewvaConfig["integrations"],
): BrewvaConfig["integrations"] {
  const input = isRecord(value) ? value : {};
  return {
    mcp: normalizeMcpIntegrationConfig(input.mcp, fallback.mcp),
  };
}
