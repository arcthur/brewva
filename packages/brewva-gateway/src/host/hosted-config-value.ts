import { execSync } from "node:child_process";

const commandResultCache = new Map<string, string | undefined>();

function executeCommandUncached(commandConfig: string): string | undefined {
  const command = commandConfig.slice(1);
  try {
    const output = execSync(command, {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const value = output.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function resolveHostedConfigValue(config: string): string | undefined {
  if (config.startsWith("!")) {
    if (!commandResultCache.has(config)) {
      commandResultCache.set(config, executeCommandUncached(config));
    }
    return commandResultCache.get(config);
  }
  return process.env[config] || config;
}

export function resolveHostedConfigValueUncached(config: string): string | undefined {
  if (config.startsWith("!")) {
    return executeCommandUncached(config);
  }
  return process.env[config] || config;
}

export function resolveHostedConfigValueOrThrow(config: string, description: string): string {
  const resolved = resolveHostedConfigValueUncached(config);
  if (resolved !== undefined) {
    return resolved;
  }

  if (config.startsWith("!")) {
    throw new Error(`Failed to resolve ${description} from shell command: ${config.slice(1)}`);
  }

  throw new Error(`Failed to resolve ${description}`);
}

export function resolveHostedHeaders(
  headers: Record<string, string> | undefined,
  description: string,
): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }

  const resolved = Object.fromEntries(
    Object.entries(headers)
      .map(([key, value]) => [
        key,
        resolveHostedConfigValueOrThrow(value, `${description} header "${key}"`),
      ])
      .filter(([, value]) => value !== undefined),
  );

  return Object.keys(resolved).length > 0 ? resolved : undefined;
}
