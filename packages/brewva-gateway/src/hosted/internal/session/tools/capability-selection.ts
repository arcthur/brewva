import { basename, resolve } from "node:path";
import {
  loadCapabilityRegistry,
  selectCapabilities,
  type CapabilityManifest,
  type CapabilityRegistry,
  type CapabilitySelectionReceipt,
} from "@brewva/brewva-capabilities";
import type { ToolActionClass } from "@brewva/brewva-runtime/security";
import {
  buildBrewvaCapabilitySelectionPromptBlock,
  type BrewvaSystemPromptCapabilitySelection,
} from "@brewva/brewva-substrate/prompt";
import type { ProtocolRecord } from "@brewva/brewva-vocabulary/events";
import { recordRuntimeToolCapabilitySelection } from "../runtime-ports.js";

export interface CapabilitySelectionRuntimeView {
  identity: {
    cwd: string;
    workspaceRoot: string;
  };
  config: {
    readonly capabilities: {
      readonly roots: readonly string[];
      readonly defaults: Readonly<Record<string, string>>;
      readonly policy: {
        readonly agentScope: readonly string[];
        readonly workspaceScope: readonly string[];
        readonly allowedAccounts: readonly string[];
      };
    };
  };
}

export interface CapabilitySelectionEventRecorder {
  ops: {
    tools: {
      capabilitySelection: {
        record(sessionId: string, receipt: object): unknown;
      };
    };
  };
}

export interface CapabilitySelectionEventQuery {
  ops: {
    tools: {
      capabilitySelection: {
        latest(sessionId: string): object | undefined;
      };
    };
  };
}

export interface CapabilityAuthorityAccessFact extends ProtocolRecord {
  allowed: boolean;
  basis: string;
  reason?: string;
  advisory?: string;
}

const EXPLICIT_CAPABILITY_PATTERN = /(?:^|\s)(?:\/capability:|@capability:)([A-Za-z0-9_.:-]+)/u;

const CAPABILITY_GATED_ACTION_CLASSES = new Set<ToolActionClass>([
  "external_side_effect",
  "schedule_mutation",
  "credential_access",
]);

const EXTERNAL_ACCOUNT_CLI_COMMANDS = new Set([
  "aws",
  "gcloud",
  "gh",
  "heroku",
  "hubspot",
  "kubectl",
  "netlify",
  "notion",
  "railway",
  "slack",
  "supabase",
  "vercel",
  "wrangler",
]);

const EXTERNAL_CREDENTIAL_CLI_COMMANDS = new Set(["op"]);

const EXTERNAL_PUBLISH_CLI_RULES: Array<{
  command: string;
  subcommandPath: readonly string[];
}> = [
  { command: "cargo", subcommandPath: ["publish"] },
  { command: "docker", subcommandPath: ["login"] },
  { command: "docker", subcommandPath: ["push"] },
  { command: "gem", subcommandPath: ["push"] },
  { command: "helm", subcommandPath: ["push"] },
  { command: "npm", subcommandPath: ["publish"] },
  { command: "pnpm", subcommandPath: ["publish"] },
  { command: "twine", subcommandPath: ["upload"] },
  { command: "yarn", subcommandPath: ["npm", "publish"] },
  { command: "yarn", subcommandPath: ["publish"] },
];

const CLI_OPTIONS_WITH_VALUES = new Set([
  "--access",
  "--otp",
  "--registry",
  "--tag",
  "--token",
  "--userconfig",
  "--workspace",
  "-w",
]);

function normalizeName(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function stripShellTokenQuotes(value: string): string {
  return value.replace(/^["']|["']$/gu, "");
}

function isEnvAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(value);
}

function commandTokens(value: string): string[] {
  return value.split(/\s+/u).map(stripShellTokenQuotes).filter(Boolean);
}

function firstCommandIndex(tokens: readonly string[]): number {
  let index = 0;
  if (tokens[index] === "env") {
    index += 1;
  }
  while (tokens[index] && isEnvAssignment(tokens[index] ?? "")) {
    index += 1;
  }
  return index;
}

function subcommandTokens(tokens: readonly string[], commandIndex: number): string[] {
  const out: string[] = [];
  for (let index = commandIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (!token) continue;
    if (token.startsWith("-")) {
      if (!token.includes("=") && CLI_OPTIONS_WITH_VALUES.has(token)) {
        index += 1;
      }
      continue;
    }
    out.push(normalizeName(basename(token)));
  }
  return out;
}

function startsWithPath(tokens: readonly string[], expected: readonly string[]): boolean {
  if (tokens.length < expected.length) return false;
  return expected.every((token, index) => tokens[index] === token);
}

export function extractExplicitCapability(prompt: string): string | undefined {
  const match = EXPLICIT_CAPABILITY_PATTERN.exec(prompt);
  return match?.[1]?.replace(/[,.!?;:]$/u, "").trim() || undefined;
}

export function extractExternalCliCommandName(
  args: Record<string, unknown> | undefined,
): string | undefined {
  const command = typeof args?.command === "string" ? args.command.trim() : "";
  if (!command) return undefined;
  const tokens = commandTokens(command);
  const commandIndex = firstCommandIndex(tokens);
  const normalized = normalizeName(basename(tokens[commandIndex] ?? ""));
  if (EXTERNAL_ACCOUNT_CLI_COMMANDS.has(normalized)) {
    return normalized;
  }
  if (EXTERNAL_CREDENTIAL_CLI_COMMANDS.has(normalized)) {
    return normalized;
  }
  const subcommands = subcommandTokens(tokens, commandIndex);
  const publishRule = EXTERNAL_PUBLISH_CLI_RULES.find(
    (rule) => rule.command === normalized && startsWithPath(subcommands, rule.subcommandPath),
  );
  return publishRule ? [normalized, ...publishRule.subcommandPath].join("-") : undefined;
}

export function loadRuntimeCapabilityRegistry(
  runtime: CapabilitySelectionRuntimeView,
): CapabilityRegistry {
  const roots = runtime.config.capabilities.roots.map((root) =>
    resolve(runtime.identity.cwd, root),
  );
  return loadCapabilityRegistry({ roots });
}

export function selectCapabilityReceiptForPrompt(input: {
  runtime: CapabilitySelectionRuntimeView;
  prompt: string;
  createdAt?: string;
}): { registry: CapabilityRegistry; receipt: CapabilitySelectionReceipt } {
  const registry = loadRuntimeCapabilityRegistry(input.runtime);
  const explicitCapability = extractExplicitCapability(input.prompt);
  const receipt = selectCapabilities({
    manifests: registry.manifests,
    intentText: input.prompt,
    explicitCapability,
    policy: {
      agentScope: input.runtime.config.capabilities.policy.agentScope,
      workspaceScope: input.runtime.config.capabilities.policy.workspaceScope,
      allowedAccounts: input.runtime.config.capabilities.policy.allowedAccounts,
      defaults: input.runtime.config.capabilities.defaults,
    },
    trigger: explicitCapability ? "explicit_capability" : "user_message",
    registryVersion: registry.registryVersion,
    createdAt: input.createdAt,
  });
  return { registry, receipt };
}

export function recordCapabilitySelectionReceipt(input: {
  runtime: CapabilitySelectionEventRecorder;
  sessionId: string;
  receipt: CapabilitySelectionReceipt;
}): void {
  recordRuntimeToolCapabilitySelection(input.runtime, input.sessionId, input.receipt);
}

export function readLatestCapabilitySelectionReceipt(input: {
  runtime: CapabilitySelectionEventQuery;
  sessionId: string;
}): CapabilitySelectionReceipt | undefined {
  const payload = input.runtime.ops.tools.capabilitySelection.latest(input.sessionId);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const receipt = payload as Partial<CapabilitySelectionReceipt>;
  return typeof receipt.selection_id === "string" &&
    Array.isArray(receipt.selected_capabilities) &&
    typeof receipt.registry_version === "string"
    ? (receipt as CapabilitySelectionReceipt)
    : undefined;
}

function selectedManifests(input: {
  receipt: CapabilitySelectionReceipt | undefined;
  manifests: readonly CapabilityManifest[];
}): CapabilityManifest[] {
  const selectedNames = new Set(
    input.receipt?.selected_capabilities.map((candidate) => candidate.name) ?? [],
  );
  if (selectedNames.size === 0) return [];
  return input.manifests.filter((manifest) => selectedNames.has(manifest.name));
}

function manifestAuthorityNames(manifest: CapabilityManifest): Set<string> {
  return new Set(
    [manifest.name, manifest.provider, manifest.domain, manifest.action, ...manifest.toolNames]
      .map(normalizeName)
      .filter(Boolean),
  );
}

function selectedCapabilitiesAuthorize(input: {
  receipt: CapabilitySelectionReceipt | undefined;
  manifests: readonly CapabilityManifest[];
  toolName: string;
  commandName?: string;
}): boolean {
  const namesToCheck = [input.toolName, input.commandName].map(normalizeName).filter(Boolean);
  if (namesToCheck.length === 0) return false;
  for (const manifest of selectedManifests(input)) {
    const authorityNames = manifestAuthorityNames(manifest);
    if (namesToCheck.some((name) => authorityNames.has(name))) {
      return true;
    }
  }
  return false;
}

export function isCapabilityAuthorityGated(input: {
  toolName: string;
  actionClass?: ToolActionClass;
  args?: Record<string, unknown>;
  forceCapabilityGate?: boolean;
}): boolean {
  const commandName =
    normalizeName(input.toolName) === "exec"
      ? extractExternalCliCommandName(input.args)
      : undefined;
  return (
    input.forceCapabilityGate === true ||
    Boolean(commandName) ||
    normalizeName(input.toolName).startsWith("mcp__") ||
    (input.actionClass !== undefined && CAPABILITY_GATED_ACTION_CLASSES.has(input.actionClass))
  );
}

export function resolveCapabilityAuthorityAccess(input: {
  receipt: CapabilitySelectionReceipt | undefined;
  manifests: readonly CapabilityManifest[];
  toolName: string;
  actionClass?: ToolActionClass;
  args?: Record<string, unknown>;
  forceCapabilityGate?: boolean;
}): CapabilityAuthorityAccessFact {
  const commandName =
    normalizeName(input.toolName) === "exec"
      ? extractExternalCliCommandName(input.args)
      : undefined;
  if (!isCapabilityAuthorityGated(input)) {
    return { allowed: true, basis: "capability_selection_scope" };
  }

  if (
    selectedCapabilitiesAuthorize({
      receipt: input.receipt,
      manifests: input.manifests,
      toolName: input.toolName,
      commandName,
    })
  ) {
    return {
      allowed: true,
      basis: "capability_selection_scope",
      advisory: `selected_capability_authorized:${input.receipt?.selection_id ?? "unknown"}`,
    };
  }

  const target = commandName ? `CLI '${commandName}'` : `tool '${input.toolName}'`;
  return {
    allowed: false,
    basis: "capability_selection_scope",
    reason: `${target} requires an explicit selected capability receipt.`,
  };
}

export function formatCapabilitySelectionSection(input: {
  receipt: CapabilitySelectionReceipt;
  manifests: readonly CapabilityManifest[];
}): string {
  const shouldRender =
    input.receipt.selected_capabilities.length > 0 ||
    input.receipt.policy_decisions.length > 0 ||
    input.receipt.conflicts.length > 0;
  if (!shouldRender) {
    return "";
  }
  const manifestsByName = new Map(input.manifests.map((manifest) => [manifest.name, manifest]));
  const selection: BrewvaSystemPromptCapabilitySelection = {
    selectedCapabilities: input.receipt.selected_capabilities.map((candidate) => {
      const manifest = manifestsByName.get(candidate.name);
      return {
        name: candidate.name,
        ...(manifest?.authProfile ? { profile: manifest.authProfile } : {}),
        ...(manifest?.riskLevel ? { mode: manifest.riskLevel } : {}),
        reason: candidate.reason,
      };
    }),
    forbiddenCandidates: [
      ...input.receipt.filtered_out.slice(0, 8).map((entry) => ({
        name: entry.name,
        reason: entry.reason,
      })),
      ...input.receipt.conflicts.slice(0, 4).map((entry) => ({
        name: entry.candidates.join(" | "),
        reason: entry.reason,
      })),
    ],
    selectionReason:
      input.receipt.policy_decisions.length > 0
        ? input.receipt.policy_decisions.join("; ")
        : undefined,
  };
  return buildBrewvaCapabilitySelectionPromptBlock(selection)?.text ?? "";
}
