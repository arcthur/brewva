import { isIP } from "node:net";
import { basename, relative, resolve } from "node:path";
import type { BrewvaConfig } from "../contracts/index.js";
import { normalizeToolName } from "../utils/tool-name.js";

const ENV_ASSIGNMENT_TOKEN = /^[A-Za-z_][A-Za-z0-9_]*=.*/u;
const COMMAND_PREFIX_TOKENS = new Set(["sudo", "command", "time"]);
const SHELL_WRAPPER_TOKENS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash"]);
const MAX_COMMAND_PARSE_DEPTH = 2;
const URL_TOKEN_PATTERN = /\bhttps?:\/\/[^\s"'`]+/giu;

export interface ToolBoundaryClassification {
  detectedCommands: string[];
  requestedCwd?: string;
  targetHosts: Array<{
    host: string;
    port?: number;
  }>;
}

export interface ResolvedBoundaryPolicy {
  commandDenyList: Set<string>;
  filesystem: BrewvaConfig["security"]["boundaryPolicy"]["filesystem"];
  network: {
    mode: "off" | "deny" | "allowlist";
    allowLoopback: boolean;
    outbound: BrewvaConfig["security"]["boundaryPolicy"]["network"]["outbound"];
  };
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeCommandToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length === 0) return "";
  const withoutQuotes = trimmed.replace(/^["']+|["']+$/gu, "");
  const normalized = withoutQuotes.toLowerCase();
  if (normalized.length === 0) return "";
  return normalized.includes("/") ? basename(normalized) : normalized;
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const input = command.trim();
  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

interface PrimaryCommandDescriptor {
  token: string;
  tokenIndex: number;
  tokens: string[];
}

function resolvePrimaryCommandDescriptor(command: string): PrimaryCommandDescriptor | undefined {
  const tokens = tokenizeCommand(command);
  let envMode = false;

  for (const [tokenIndex, token] of tokens.entries()) {
    const normalizedToken = normalizeCommandToken(token);
    if (!normalizedToken) continue;

    if (ENV_ASSIGNMENT_TOKEN.test(token)) {
      continue;
    }

    if (normalizedToken === "env") {
      envMode = true;
      continue;
    }

    if (envMode && token.startsWith("-")) {
      continue;
    }

    if (COMMAND_PREFIX_TOKENS.has(normalizedToken)) {
      continue;
    }

    return {
      token: normalizedToken,
      tokenIndex,
      tokens,
    };
  }

  return undefined;
}

function resolveShellInlineScript(descriptor: PrimaryCommandDescriptor): string | undefined {
  if (!SHELL_WRAPPER_TOKENS.has(descriptor.token)) {
    return undefined;
  }

  for (let index = descriptor.tokenIndex + 1; index < descriptor.tokens.length; index += 1) {
    const token = descriptor.tokens[index]!;
    if (token === "--") {
      return undefined;
    }

    if (token.startsWith("--")) {
      if (token === "--command") {
        return descriptor.tokens[index + 1];
      }
      if (token.startsWith("--command=")) {
        const inlineScript = token.slice("--command=".length);
        return inlineScript.length > 0 ? inlineScript : undefined;
      }
      continue;
    }

    if (!token.startsWith("-")) {
      return undefined;
    }

    const normalizedFlags = token.replace(/^-+/u, "");
    if (normalizedFlags.length === 0) {
      continue;
    }

    const cIndex = normalizedFlags.indexOf("c");
    if (cIndex === -1) {
      continue;
    }

    const inlineScript = normalizedFlags.slice(cIndex + 1);
    if (inlineScript.length > 0) {
      return inlineScript;
    }

    return descriptor.tokens[index + 1];
  }

  return undefined;
}

function splitShellCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const pushCurrent = () => {
    const normalized = current.trim();
    if (normalized.length > 0) {
      segments.push(normalized);
    }
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === ";" || char === "\n") {
      pushCurrent();
      continue;
    }

    if (char === "&" && command[index + 1] === "&") {
      pushCurrent();
      index += 1;
      continue;
    }

    if (char === "|") {
      pushCurrent();
      if (command[index + 1] === "|") {
        index += 1;
      }
      continue;
    }

    current += char;
  }

  pushCurrent();
  return segments;
}

function collectPrimaryCommandTokens(command: string, depth = 0): string[] {
  if (depth > MAX_COMMAND_PARSE_DEPTH) {
    return [];
  }

  const descriptor = resolvePrimaryCommandDescriptor(command);
  if (!descriptor) {
    return [];
  }

  const tokens = [descriptor.token];
  const inlineScript = resolveShellInlineScript(descriptor);
  if (!inlineScript) {
    return tokens;
  }

  const nestedTokens = collectPrimaryCommandTokens(inlineScript, depth + 1);
  return [...new Set([...tokens, ...nestedTokens])];
}

export function resolvePrimaryCommandTokens(command: string, depth = 0): string[] {
  if (depth > MAX_COMMAND_PARSE_DEPTH) {
    return [];
  }

  const segments = splitShellCommandSegments(command);
  const tokens = segments
    .flatMap((segment) => collectPrimaryCommandTokens(segment, depth))
    .filter((token) => token.length > 0);
  return [...new Set(tokens)];
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/u, "");
}

function isPathInsideRoot(path: string, root: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  const rel = relative(normalizedRoot, normalizedPath).replaceAll("\\", "/");
  return rel === "" || rel === "." || (!rel.startsWith("../") && rel !== "..");
}

function matchHostPattern(host: string, pattern: string): boolean {
  const normalizedHost = normalizeHost(host);
  const normalizedPattern = normalizeHost(pattern);
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(1);
    return normalizedHost.endsWith(suffix) && normalizedHost.length > suffix.length;
  }
  return normalizedHost === normalizedPattern;
}

function isLoopbackHost(host: string): boolean {
  const normalizedHost = normalizeHost(host);
  if (normalizedHost === "localhost") {
    return true;
  }
  const ipVersion = isIP(normalizedHost);
  if (ipVersion === 4) {
    return normalizedHost.startsWith("127.");
  }
  if (ipVersion === 6) {
    return normalizedHost === "::1";
  }
  return false;
}

function resolveUrlTarget(urlValue: string): { host: string; port?: number } | undefined {
  try {
    const parsed = new URL(urlValue);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") {
      return undefined;
    }
    const port =
      parsed.port.length > 0
        ? Number(parsed.port)
        : protocol === "https:"
          ? 443
          : protocol === "http:"
            ? 80
            : undefined;
    return {
      host: normalizeHost(parsed.hostname),
      port: typeof port === "number" && Number.isFinite(port) ? port : undefined,
    };
  } catch {
    return undefined;
  }
}

export function collectExplicitUrlTargets(command: string): Array<{ host: string; port?: number }> {
  const results: Array<{ host: string; port?: number }> = [];
  for (const match of command.matchAll(URL_TOKEN_PATTERN)) {
    const target = resolveUrlTarget(match[0]);
    if (!target) continue;
    if (results.some((entry) => entry.host === target.host && entry.port === target.port)) {
      continue;
    }
    results.push(target);
  }
  return results;
}

export function classifyToolBoundaryRequest(input: {
  toolName: string;
  args?: Record<string, unknown>;
  cwd?: string;
  workspaceRoot?: string;
}): ToolBoundaryClassification {
  const normalizedToolName = normalizeToolName(input.toolName);
  const args = input.args ?? {};

  if (normalizedToolName === "exec") {
    const command = normalizeOptionalString(args.command);
    const baseCwd =
      normalizeOptionalString(input.cwd) ?? normalizeOptionalString(input.workspaceRoot);
    const workdir = normalizeOptionalString(args.workdir);
    const requestedCwd =
      baseCwd && workdir ? resolve(baseCwd, workdir) : baseCwd ? resolve(baseCwd) : undefined;
    return {
      detectedCommands: command ? resolvePrimaryCommandTokens(command) : [],
      requestedCwd,
      targetHosts: command ? collectExplicitUrlTargets(command) : [],
    };
  }

  if (normalizedToolName === "browser_open") {
    const url = normalizeOptionalString(args.url);
    const target = url ? resolveUrlTarget(url) : undefined;
    return {
      detectedCommands: [],
      targetHosts: target ? [target] : [],
    };
  }

  return {
    detectedCommands: [],
    targetHosts: [],
  };
}

export function resolveBoundaryPolicy(security: BrewvaConfig["security"]): ResolvedBoundaryPolicy {
  const configuredNetwork = security.boundaryPolicy.network;
  if (configuredNetwork.mode === "allowlist") {
    return {
      commandDenyList: new Set(security.boundaryPolicy.commandDenyList),
      filesystem: security.boundaryPolicy.filesystem,
      network: {
        mode: "allowlist",
        allowLoopback: configuredNetwork.allowLoopback,
        outbound: configuredNetwork.outbound,
      },
    };
  }

  if (configuredNetwork.mode === "deny") {
    return {
      commandDenyList: new Set(security.boundaryPolicy.commandDenyList),
      filesystem: security.boundaryPolicy.filesystem,
      network: {
        mode: "deny",
        allowLoopback: configuredNetwork.allowLoopback,
        outbound: configuredNetwork.outbound,
      },
    };
  }

  if (security.mode === "permissive") {
    return {
      commandDenyList: new Set(security.boundaryPolicy.commandDenyList),
      filesystem: security.boundaryPolicy.filesystem,
      network: {
        mode: "off",
        allowLoopback: true,
        outbound: configuredNetwork.outbound,
      },
    };
  }

  if (security.mode === "strict") {
    return {
      commandDenyList: new Set(security.boundaryPolicy.commandDenyList),
      filesystem: security.boundaryPolicy.filesystem,
      network: {
        mode: "deny",
        allowLoopback: true,
        outbound: configuredNetwork.outbound,
      },
    };
  }

  return {
    commandDenyList: new Set(security.boundaryPolicy.commandDenyList),
    filesystem: security.boundaryPolicy.filesystem,
    network: {
      mode: "allowlist",
      allowLoopback: true,
      outbound: configuredNetwork.outbound,
    },
  };
}

export function evaluateBoundaryClassification(
  policy: ResolvedBoundaryPolicy,
  classification: ToolBoundaryClassification,
): { allowed: true } | { allowed: false; reason: string } {
  for (const command of classification.detectedCommands) {
    if (policy.commandDenyList.has(command)) {
      return {
        allowed: false,
        reason: `Command '${command}' is denied by security.boundaryPolicy.commandDenyList.`,
      };
    }
  }

  if (classification.requestedCwd) {
    for (const deniedRoot of policy.filesystem.writeDeny) {
      if (isPathInsideRoot(classification.requestedCwd, deniedRoot)) {
        return {
          allowed: false,
          reason: `Requested workdir '${classification.requestedCwd}' is denied by security.boundaryPolicy.filesystem.writeDeny.`,
        };
      }
    }

    if (
      policy.filesystem.readAllow.length > 0 &&
      !policy.filesystem.readAllow.some((root) =>
        isPathInsideRoot(classification.requestedCwd as string, root),
      )
    ) {
      return {
        allowed: false,
        reason: `Requested workdir '${classification.requestedCwd}' is outside security.boundaryPolicy.filesystem.readAllow.`,
      };
    }

    if (
      policy.filesystem.writeAllow.length > 0 &&
      !policy.filesystem.writeAllow.some((root) =>
        isPathInsideRoot(classification.requestedCwd as string, root),
      )
    ) {
      return {
        allowed: false,
        reason: `Requested workdir '${classification.requestedCwd}' is outside security.boundaryPolicy.filesystem.writeAllow.`,
      };
    }
  }

  if (policy.network.mode === "off") {
    return { allowed: true };
  }

  for (const target of classification.targetHosts) {
    if (policy.network.allowLoopback && isLoopbackHost(target.host)) {
      continue;
    }
    if (policy.network.mode === "deny") {
      return {
        allowed: false,
        reason: `Outbound host '${target.host}' is denied by security.boundaryPolicy.network.mode=deny.`,
      };
    }
    const allowed = policy.network.outbound.some((rule) => {
      if (!matchHostPattern(target.host, rule.host)) {
        return false;
      }
      if (!target.port || rule.ports.length === 0) {
        return true;
      }
      return rule.ports.includes(target.port);
    });
    if (!allowed) {
      return {
        allowed: false,
        reason: `Outbound host '${target.host}' is outside security.boundaryPolicy.network.allowlist.`,
      };
    }
  }

  return { allowed: true };
}
