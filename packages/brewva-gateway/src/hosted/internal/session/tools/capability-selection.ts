import { basename, resolve } from "node:path";
import type { ToolActionClass } from "@brewva/brewva-runtime/security";
import { compactWhitespace, truncateText } from "@brewva/brewva-std/text";
import { isRecord } from "@brewva/brewva-std/unknown";
import {
  buildBrewvaCapabilitySelectionPromptBlock,
  type BrewvaSystemPromptCapabilitySelection,
} from "@brewva/brewva-substrate/prompt";
import type { ProtocolRecord } from "@brewva/brewva-vocabulary/events";
import { recordRuntimeToolCapabilitySelection } from "../runtime-ports.js";
import {
  computeCapabilityManifestHash,
  loadCapabilityRegistry,
  resolveCarriedCapabilityReceipt,
  selectCapabilities,
  type CapabilityManifest,
  type CapabilityPolicy,
  type CapabilityRegistry,
  type CapabilitySelectionReceipt,
  type CapabilitySelectorDecisionSource,
} from "./capability-registry.js";

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
  receiptId?: string;
  source?: string;
  selectedCapabilityNames?: readonly string[];
  /**
   * True only when a gated surface was authorized by an authority-granting
   * receipt entry — the structured signal exposure logic keys off, instead of
   * parsing the human-readable advisory.
   */
  selectionAuthorized?: boolean;
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

function runtimeCapabilityPolicy(runtime: CapabilitySelectionRuntimeView): CapabilityPolicy {
  return {
    agentScope: runtime.config.capabilities.policy.agentScope,
    workspaceScope: runtime.config.capabilities.policy.workspaceScope,
    allowedAccounts: runtime.config.capabilities.policy.allowedAccounts,
    defaults: runtime.config.capabilities.defaults,
  };
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
    policy: runtimeCapabilityPolicy(input.runtime),
    trigger: explicitCapability ? "explicit_capability" : "user_message",
    registryVersion: registry.registryVersion,
    createdAt: input.createdAt,
  });
  return { registry, receipt };
}

export function carryCapabilitySelectionReceiptForTurn(input: {
  runtime: CapabilitySelectionRuntimeView;
  previous: CapabilitySelectionReceipt;
  createdAt?: string;
}): { registry: CapabilityRegistry; receipt: CapabilitySelectionReceipt } {
  const registry = loadRuntimeCapabilityRegistry(input.runtime);
  return {
    registry,
    receipt: resolveCarriedCapabilityReceipt({
      registry,
      policy: runtimeCapabilityPolicy(input.runtime),
      previous: input.previous,
      createdAt: input.createdAt,
    }),
  };
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
  if (!isRecord(payload)) {
    return undefined;
  }
  const receipt = payload as Partial<CapabilitySelectionReceipt>;
  if (
    typeof receipt.selection_id !== "string" ||
    !Array.isArray(receipt.selected_capabilities) ||
    typeof receipt.registry_version !== "string"
  ) {
    return undefined;
  }
  // Older persisted payloads may omit the list fields the carry path
  // dereferences; normalize them so a legacy receipt degrades to reselection
  // instead of a turn-start TypeError.
  return {
    ...(receipt as CapabilitySelectionReceipt),
    filtered_out: Array.isArray(receipt.filtered_out) ? receipt.filtered_out : [],
    conflicts: Array.isArray(receipt.conflicts) ? receipt.conflicts : [],
    policy_decisions: Array.isArray(receipt.policy_decisions) ? receipt.policy_decisions : [],
  };
}

// Axiom 18: only accountable selection sources grant authority. Deterministic
// (and any future similarity-derived) matches stay views — rendered, carried,
// never authorizing.
const AUTHORITY_GRANTING_SELECTION_SOURCES: ReadonlySet<CapabilitySelectorDecisionSource> = new Set(
  ["explicit", "policy"],
);

function isAuthorityGrantingCandidate(candidate: {
  source: CapabilitySelectorDecisionSource;
}): boolean {
  return AUTHORITY_GRANTING_SELECTION_SOURCES.has(candidate.source);
}

// An entry authorizes only against the manifest content it was selected
// under (`manifestHash`): a manifest edited after selection — including
// mid-turn — never inherits the old grant. Entries without a hash (legacy
// receipts) are stale by definition and re-earn authority via reselection.
function authorityGrantingSelectedManifests(input: {
  receipt: CapabilitySelectionReceipt | undefined;
  manifests: readonly CapabilityManifest[];
}): CapabilityManifest[] {
  const grantingEntries =
    input.receipt?.selected_capabilities.filter(
      (candidate) => isAuthorityGrantingCandidate(candidate) && candidate.manifestHash,
    ) ?? [];
  if (grantingEntries.length === 0) return [];
  const manifestsByName = new Map(input.manifests.map((manifest) => [manifest.name, manifest]));
  const granted: CapabilityManifest[] = [];
  for (const entry of grantingEntries) {
    const manifest = manifestsByName.get(entry.name);
    if (!manifest || entry.manifestHash !== computeCapabilityManifestHash(manifest)) {
      continue;
    }
    granted.push(manifest);
  }
  return granted;
}

function selectedCapabilityNames(receipt: CapabilitySelectionReceipt | undefined): string[] {
  return [
    ...new Set(
      receipt?.selected_capabilities
        .map((candidate) => candidate.name.trim())
        .filter((name) => name.length > 0) ?? [],
    ),
  ].toSorted((left, right) => left.localeCompare(right));
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
  for (const manifest of authorityGrantingSelectedManifests(input)) {
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
  const receiptId = input.receipt?.selection_id;
  const source = "capability_selection";
  const selectedCapabilityNamesValue = selectedCapabilityNames(input.receipt);
  if (!isCapabilityAuthorityGated(input)) {
    return {
      allowed: true,
      basis: "capability_selection_scope",
      ...(receiptId ? { receiptId } : {}),
      source,
      selectedCapabilityNames: selectedCapabilityNamesValue,
    };
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
      ...(receiptId ? { receiptId } : {}),
      source,
      selectedCapabilityNames: selectedCapabilityNamesValue,
      selectionAuthorized: true,
      advisory: `selected_capability_authorized:${input.receipt?.selection_id ?? "unknown"}`,
    };
  }

  const target = commandName ? `CLI '${commandName}'` : `tool '${input.toolName}'`;
  return {
    allowed: false,
    basis: "capability_selection_scope",
    ...(receiptId ? { receiptId } : {}),
    source,
    selectedCapabilityNames: selectedCapabilityNamesValue,
    reason: "missing_selected_capability",
    advisory: buildCapabilityDenialAdvisory({
      target,
      receipt: input.receipt,
      manifests: input.manifests,
      toolName: input.toolName,
      commandName,
    }),
  };
}

function buildCapabilityDenialAdvisory(input: {
  target: string;
  receipt: CapabilitySelectionReceipt | undefined;
  manifests: readonly CapabilityManifest[];
  toolName: string;
  commandName?: string;
}): string {
  const namesToCheck = [input.toolName, input.commandName].map(normalizeName).filter(Boolean);
  // Never point the model at a capability its own receipt marks policy-forbidden:
  // that request path is a dead loop (`selectCapabilities` re-filters it by scope).
  const forbidden = input.receipt ? policyForbiddenNames(input.receipt) : new Set<string>();
  const covering = input.manifests
    .filter((manifest) => {
      if (forbidden.has(manifest.name)) return false;
      const authorityNames = manifestAuthorityNames(manifest);
      return namesToCheck.some((name) => authorityNames.has(name));
    })
    .map((manifest) => manifest.name)
    .toSorted((left, right) => left.localeCompare(right));
  if (covering.length === 0) {
    return `${input.target} requires a selected capability, and no selectable capability manifest covers it; authoring a manifest (or lifting its policy restriction) is the only path to authorization.`;
  }
  const named = covering.slice(0, 3);
  const suffix = covering.length > named.length ? ` (+${covering.length - named.length} more)` : "";
  const requestPath = `'/capability:${named[0]}'`;
  return `${input.target} requires a selected capability. Covered by: ${named.join(", ")}${suffix} — request selection with ${requestPath} in the turn prompt; the selection receipt remains the only authority.`;
}

const SELECTABLE_CAPABILITY_LIMIT = 8;
const SELECTABLE_WHEN_TO_USE_MAX_CHARS = 140;

/**
 * Authored YAML content rendered into the system prompt: collapse whitespace
 * first (a multi-line block scalar must not break the one-entry-per-line block
 * format) then truncate — the same discipline SkillCard `whenToUse` uses.
 */
function renderWhenToUse(value: string | undefined): string | undefined {
  const compact = compactWhitespace(value ?? "");
  if (!compact) return undefined;
  return truncateText(compact, SELECTABLE_WHEN_TO_USE_MAX_CHARS, { marker: "…" });
}

function policyForbiddenNames(receipt: CapabilitySelectionReceipt): Set<string> {
  return new Set<string>([
    ...receipt.filtered_out
      .filter((entry) => entry.reason !== "not_ranked")
      .map((entry) => entry.name),
    ...receipt.conflicts.flatMap((entry) => entry.candidates),
  ]);
}

/**
 * Manifests neither selected nor policy-forbidden, in deterministic order:
 * intent-ranked leftovers (`not_ranked`, receipt order) first, then the
 * remaining registry manifests by name (enforced here, not assumed from the
 * registry). `not_ranked` is requestable, not forbidden — only policy filters
 * (scope/account/risk/conflict) forbid.
 *
 * Exported for the eval harness premise gate, which must certify selectable
 * membership from the SAME code that renders the catalog.
 */
export function selectableCapabilities(input: {
  receipt: CapabilitySelectionReceipt;
  manifests: readonly CapabilityManifest[];
}): Array<{ name: string; whenToUse?: string }> {
  const excluded = new Set<string>([
    ...input.receipt.selected_capabilities
      .filter((candidate) => isAuthorityGrantingCandidate(candidate))
      .map((candidate) => candidate.name),
    ...policyForbiddenNames(input.receipt),
  ]);
  const manifestsByName = new Map(input.manifests.map((manifest) => [manifest.name, manifest]));
  const ordered: CapabilityManifest[] = [];
  const seen = new Set<string>();
  // View-only selections (deterministic matches) lead the requestable list:
  // they are the intent-ranked candidates, and listing them here — instead of
  // under `selected` — is what tells the model they need an explicit
  // `/capability:` request before they authorize anything.
  for (const candidate of input.receipt.selected_capabilities) {
    if (isAuthorityGrantingCandidate(candidate) || excluded.has(candidate.name)) {
      continue;
    }
    const manifest = manifestsByName.get(candidate.name);
    if (!manifest || seen.has(candidate.name)) continue;
    seen.add(candidate.name);
    ordered.push(manifest);
  }
  for (const entry of input.receipt.filtered_out) {
    if (entry.reason !== "not_ranked" || excluded.has(entry.name) || seen.has(entry.name)) {
      continue;
    }
    const manifest = manifestsByName.get(entry.name);
    if (!manifest) continue;
    seen.add(entry.name);
    ordered.push(manifest);
  }
  const remainder = input.manifests
    .filter((manifest) => !excluded.has(manifest.name) && !seen.has(manifest.name))
    .toSorted((left, right) => left.name.localeCompare(right.name));
  ordered.push(...remainder);
  return ordered.slice(0, SELECTABLE_CAPABILITY_LIMIT).map((manifest) => {
    const whenToUse = renderWhenToUse(manifest.selection?.whenToUse);
    const entry: { name: string; whenToUse?: string } = { name: manifest.name };
    if (whenToUse) {
      entry.whenToUse = whenToUse;
    }
    return entry;
  });
}

export function formatCapabilitySelectionSection(input: {
  receipt: CapabilitySelectionReceipt;
  manifests: readonly CapabilityManifest[];
}): string {
  const selectable = selectableCapabilities(input);
  const shouldRender =
    input.receipt.selected_capabilities.length > 0 ||
    input.receipt.policy_decisions.length > 0 ||
    input.receipt.conflicts.length > 0 ||
    selectable.length > 0;
  if (!shouldRender) {
    return "";
  }
  const manifestsByName = new Map(input.manifests.map((manifest) => [manifest.name, manifest]));
  // Only authority-granting entries render as `selected`; view-only matches
  // surface through `selectableCapabilities` above so the prompt never claims
  // an authority the gate would deny.
  const selection: BrewvaSystemPromptCapabilitySelection = {
    selectedCapabilities: input.receipt.selected_capabilities
      .filter((candidate) => isAuthorityGrantingCandidate(candidate))
      .map((candidate) => {
        const manifest = manifestsByName.get(candidate.name);
        const entry: NonNullable<
          BrewvaSystemPromptCapabilitySelection["selectedCapabilities"]
        >[number] = {
          name: candidate.name,
          reason: candidate.reason,
        };
        if (manifest?.authProfile) {
          entry.profile = manifest.authProfile;
        }
        if (manifest?.riskLevel) {
          entry.mode = manifest.riskLevel;
        }
        return entry;
      }),
    selectableCapabilities: selectable,
    forbiddenCandidates: [
      ...input.receipt.filtered_out
        .filter((entry) => entry.reason !== "not_ranked")
        .slice(0, 8)
        .map((entry) => ({
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
