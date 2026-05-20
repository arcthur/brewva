import { isIP } from "node:net";
import { relative, resolve } from "node:path";
import type { BrewvaConfig } from "../config/types.js";
import type { DeepReadonly } from "../core/deep-readonly.js";
import { normalizeToolName } from "../utils/tool-name.js";
import {
  analyzeShellCommand,
  collectCommandPolicyNetworkTargets,
  type ShellCommandAnalysis,
} from "./command-policy.js";

export interface ToolBoundaryClassification {
  detectedCommands: string[];
  requestedCwd?: string;
  targetHosts: Array<{
    host: string;
    port?: number;
  }>;
  commandPolicy?: ShellCommandAnalysis;
}

export interface ResolvedBoundaryPolicy {
  commandDenyList: Set<string>;
  filesystem: DeepReadonly<BrewvaConfig["security"]["boundaryPolicy"]["filesystem"]>;
  network: {
    mode: "off" | "deny" | "allowlist";
    allowLoopback: boolean;
    outbound: DeepReadonly<BrewvaConfig["security"]["boundaryPolicy"]["network"]["outbound"]>;
  };
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeHost(host: string): string {
  const normalized = host.trim().toLowerCase().replace(/\.$/u, "");
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
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
    return normalizedHost.startsWith("127.") || normalizedHost === "0.0.0.0";
  }
  if (ipVersion === 6) {
    if (normalizedHost === "::1" || normalizedHost === "::") {
      return true;
    }
    const mappedIpv4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(normalizedHost);
    if (mappedIpv4) {
      const high = Number.parseInt(mappedIpv4[1]!, 16);
      return Number.isFinite(high) && high >> 8 === 127;
    }
    if (normalizedHost.startsWith("::ffff:127.")) {
      return true;
    }
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
  return collectCommandPolicyNetworkTargets(command).map((target) => ({
    host: target.host,
    port: target.port,
  }));
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
    const commandPolicy = command ? analyzeShellCommand(command) : undefined;
    const baseCwd =
      normalizeOptionalString(input.cwd) ?? normalizeOptionalString(input.workspaceRoot);
    const workdir = normalizeOptionalString(args.workdir);
    const requestedCwd =
      baseCwd && workdir ? resolve(baseCwd, workdir) : baseCwd ? resolve(baseCwd) : undefined;
    return {
      detectedCommands: commandPolicy
        ? [...new Set(commandPolicy.commands.map((entry) => entry.name))]
        : [],
      requestedCwd,
      targetHosts: commandPolicy
        ? commandPolicy.networkTargets.map((target) => ({
            host: target.host,
            port: target.port,
          }))
        : [],
      commandPolicy,
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

export function resolveBoundaryPolicy(
  security: DeepReadonly<BrewvaConfig["security"]>,
): ResolvedBoundaryPolicy {
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
