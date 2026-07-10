import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { stableJsonSha256Hex } from "@brewva/brewva-std/hash";
import { isRecord } from "@brewva/brewva-std/unknown";
import { parse as parseYaml } from "yaml";

export type CapabilityRiskLevel = "read" | "draft" | "write" | "destructive" | "cross_system";
export type CapabilitySelectionTrigger =
  | "user_message"
  | "explicit_capability"
  | "policy_change"
  | "registry_change"
  | "carried";
export type CapabilitySelectorDecisionSource =
  | "explicit"
  | "policy"
  | "deterministic"
  | "embedding"
  | "llm_last_resort"
  | "none";

export interface CapabilitySelectionFields {
  whenToUse?: string;
  triggers?: string[];
  pathGlobs?: string[];
}

export interface CapabilityManifest {
  name: string;
  provider: string;
  domain: string;
  action: string;
  toolNames: string[];
  resourceTypes: string[];
  riskLevel: CapabilityRiskLevel;
  requiresExplicitAccount: boolean;
  requiresConfirmation: boolean;
  agentScope: string[];
  workspaceScope: string[];
  conflictsWith: string[];
  authProfile?: string;
  sideEffects: string[];
  selection?: CapabilitySelectionFields;
  envAllowlist: string[];
  inheritEnv: false;
  filePath?: string;
}

export interface CapabilityPolicy {
  agentScope?: readonly string[];
  workspaceScope?: readonly string[];
  allowedAccounts?: readonly string[];
  defaults?: Readonly<Record<string, string>>;
}

export interface CapabilityRegistryRoot {
  rootDir: string;
  manifestDir: string;
}

export interface CapabilityRegistry {
  roots: CapabilityRegistryRoot[];
  manifests: CapabilityManifest[];
  registryVersion: string;
}

export interface CapabilitySelectionCandidate {
  name: string;
  source: CapabilitySelectorDecisionSource;
  score: number;
  reason: string;
  /**
   * Content hash of the manifest this entry was selected against. Authority
   * and carry both revalidate against it, so a selection never outlives the
   * manifest terms it was granted under. Absent only on receipts recorded
   * before manifest hashing existed; such entries revalidate as stale.
   */
  manifestHash?: string;
}

export interface CapabilitySelectionFilteredOut {
  name: string;
  reason:
    | "agent_scope"
    | "workspace_scope"
    | "account_restriction"
    | "risk_mismatch"
    | "conflict"
    | "not_ranked";
}

export interface CapabilitySelectionConflict {
  group: string;
  candidates: string[];
  reason: string;
}

export interface CapabilitySelectionReceipt {
  selection_id: string;
  trigger: CapabilitySelectionTrigger;
  input_intent_hash: string;
  selected_capabilities: CapabilitySelectionCandidate[];
  filtered_out: CapabilitySelectionFilteredOut[];
  policy_decisions: string[];
  conflicts: CapabilitySelectionConflict[];
  carried_from?: string;
  created_at: string;
  registry_version: string;
}

export interface SelectCapabilitiesInput {
  manifests: readonly CapabilityManifest[];
  intentText?: string;
  explicitCapability?: string;
  policy?: CapabilityPolicy;
  trigger: Exclude<CapabilitySelectionTrigger, "carried">;
  registryVersion?: string;
  maxCandidates?: number;
  createdAt?: string;
}

export interface CarryCapabilitySelectionInput {
  previous: CapabilitySelectionReceipt;
  createdAt?: string;
}

const RISK_LEVELS = new Set<CapabilityRiskLevel>([
  "read",
  "draft",
  "write",
  "destructive",
  "cross_system",
]);

function failCapabilityManifest(filePath: string, message: string): never {
  throw new Error(`[capability_manifest] ${filePath}: ${message}`);
}

function readString(data: Record<string, unknown>, key: string, filePath: string): string {
  const value = data[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    failCapabilityManifest(filePath, `${key} must be a non-empty string.`);
  }
  return value.trim();
}

function readStringArray(
  data: Record<string, unknown>,
  key: string,
  filePath: string,
  fallback: string[] = [],
): string[] {
  const value = data[key];
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value)) {
    failCapabilityManifest(filePath, `${key} must be a string array.`);
  }
  const out: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim().length === 0) {
      failCapabilityManifest(filePath, `${key}[${index}] must be a non-empty string.`);
    }
    out.push(item.trim());
  }
  return [...new Set(out)];
}

function readBoolean(
  data: Record<string, unknown>,
  key: string,
  filePath: string,
  fallback: boolean,
): boolean {
  const value = data[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    failCapabilityManifest(filePath, `${key} must be a boolean.`);
  }
  return value;
}

function readSelection(value: unknown, filePath: string): CapabilitySelectionFields | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    failCapabilityManifest(filePath, "selection must be an object.");
  }
  const allowed = new Set(["when_to_use", "triggers", "path_globs"]);
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
  if (unsupported.length > 0) {
    failCapabilityManifest(
      filePath,
      `selection contains unsupported field(s): ${unsupported.join(", ")}.`,
    );
  }
  const whenToUse =
    typeof value.when_to_use === "string" && value.when_to_use.trim().length > 0
      ? value.when_to_use.trim()
      : undefined;
  const triggers = readStringArray(value, "triggers", filePath);
  const pathGlobs = readStringArray(value, "path_globs", filePath);
  const selection = {
    ...(whenToUse ? { whenToUse } : {}),
    ...(triggers.length > 0 ? { triggers } : {}),
    ...(pathGlobs.length > 0 ? { pathGlobs } : {}),
  } satisfies CapabilitySelectionFields;
  return Object.keys(selection).length > 0 ? selection : undefined;
}

export function parseCapabilityManifestContent(
  content: string,
  filePath = "<capability>",
): CapabilityManifest {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (error) {
    failCapabilityManifest(filePath, error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(parsed)) {
    failCapabilityManifest(filePath, "manifest must parse to an object.");
  }

  const unsupported = Object.keys(parsed).filter(
    (key) =>
      ![
        "name",
        "provider",
        "domain",
        "action",
        "tool_names",
        "resource_types",
        "risk_level",
        "requires_explicit_account",
        "requires_confirmation",
        "agent_scope",
        "workspace_scope",
        "conflicts_with",
        "auth_profile",
        "side_effects",
        "selection",
        "env_allowlist",
        "inherit_env",
      ].includes(key),
  );
  if (unsupported.length > 0) {
    failCapabilityManifest(filePath, `unsupported field(s): ${unsupported.join(", ")}.`);
  }

  const riskLevel = readString(parsed, "risk_level", filePath);
  if (!RISK_LEVELS.has(riskLevel as CapabilityRiskLevel)) {
    failCapabilityManifest(filePath, `risk_level must be one of: ${[...RISK_LEVELS].join(" | ")}.`);
  }
  const inheritEnv = readBoolean(parsed, "inherit_env", filePath, false);
  if (inheritEnv) {
    failCapabilityManifest(filePath, "inherit_env must be false; use env_allowlist instead.");
  }

  const authProfile =
    typeof parsed.auth_profile === "string" && parsed.auth_profile.trim().length > 0
      ? parsed.auth_profile.trim()
      : undefined;

  return {
    name: readString(parsed, "name", filePath),
    provider: readString(parsed, "provider", filePath),
    domain: readString(parsed, "domain", filePath),
    action: readString(parsed, "action", filePath),
    toolNames: readStringArray(parsed, "tool_names", filePath),
    resourceTypes: readStringArray(parsed, "resource_types", filePath),
    riskLevel: riskLevel as CapabilityRiskLevel,
    requiresExplicitAccount: readBoolean(parsed, "requires_explicit_account", filePath, false),
    requiresConfirmation: readBoolean(parsed, "requires_confirmation", filePath, false),
    agentScope: readStringArray(parsed, "agent_scope", filePath),
    workspaceScope: readStringArray(parsed, "workspace_scope", filePath),
    conflictsWith: readStringArray(parsed, "conflicts_with", filePath),
    ...(authProfile ? { authProfile } : {}),
    sideEffects: readStringArray(parsed, "side_effects", filePath),
    selection: readSelection(parsed.selection, filePath),
    envAllowlist: readStringArray(parsed, "env_allowlist", filePath),
    inheritEnv: false,
    filePath,
  };
}

export function parseCapabilityManifestFile(filePath: string): CapabilityManifest {
  return parseCapabilityManifestContent(readFileSync(filePath, "utf8"), filePath);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listCapabilityManifestFiles(rootDir: string): string[] {
  if (!isDirectory(rootDir)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile() && /\.(?:ya?ml)$/iu.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(rootDir);
  return out.toSorted((left, right) => left.localeCompare(right));
}

function resolveCapabilityManifestDir(rootDir: string): CapabilityRegistryRoot {
  const resolved = resolve(rootDir);
  const nested = join(resolved, "capabilities");
  return {
    rootDir: resolved,
    manifestDir: isDirectory(nested) ? nested : resolved,
  };
}

export function loadCapabilityRegistry(input: { roots: readonly string[] }): CapabilityRegistry {
  const roots = input.roots.map(resolveCapabilityManifestDir);
  const manifests: CapabilityManifest[] = [];
  const byName = new Map<string, string>();
  for (const root of roots) {
    for (const filePath of listCapabilityManifestFiles(root.manifestDir)) {
      const manifest = parseCapabilityManifestFile(filePath);
      const existing = byName.get(manifest.name);
      if (existing) {
        failCapabilityManifest(
          filePath,
          `duplicate capability '${manifest.name}' conflicts with '${existing}'.`,
        );
      }
      byName.set(manifest.name, filePath);
      manifests.push(manifest);
    }
  }
  return {
    roots,
    manifests: manifests.toSorted((left, right) => left.name.localeCompare(right.name)),
    registryVersion: computeCapabilityRegistryVersion(manifests),
  };
}

/** Exported for the eval harness premise gate's token-overlap diagnostics. */
export function textTokens(value: string | undefined): Set<string> {
  return new Set((value ?? "").toLowerCase().match(/[a-z0-9_-]+/gu) ?? []);
}

function intersects(left: readonly string[] | undefined, right: ReadonlySet<string>): boolean {
  if (!left || left.length === 0) return true;
  return left.some((entry) => right.has(entry));
}

const manifestTokenCache = new WeakMap<CapabilityManifest, Set<string>>();

/** Exported for the eval harness premise gate's token-overlap diagnostics. */
export function manifestTokens(manifest: CapabilityManifest): Set<string> {
  const cached = manifestTokenCache.get(manifest);
  if (cached) {
    return cached;
  }
  const haystack = [
    manifest.name,
    manifest.provider,
    manifest.domain,
    manifest.action,
    ...manifest.toolNames,
    ...manifest.resourceTypes,
    manifest.selection?.whenToUse,
    ...(manifest.selection?.triggers ?? []),
    ...(manifest.selection?.pathGlobs ?? []),
  ]
    .filter((entry): entry is string => Boolean(entry))
    .join(" ");
  const tokens = textTokens(haystack);
  manifestTokenCache.set(manifest, tokens);
  return tokens;
}

function scoreManifestTokens(
  manifest: CapabilityManifest,
  intentTokens: ReadonlySet<string>,
): number {
  if (intentTokens.size === 0) return 0;
  const tokens = manifestTokens(manifest);
  let score = 0;
  for (const token of intentTokens) {
    if (tokens.has(token)) {
      score += 1;
    }
  }
  return score;
}

// Policy authority binds ONLY through the structured default key: the key's
// tokens must appear in the intent. There is deliberately no fallback to
// manifest description tokens — descriptive matching may rank views
// (`deterministic`), never mint `policy` authority (axiom 18).
function policyDefaultMatchesIntent(input: {
  defaultKeyTokens: ReadonlySet<string>;
  intentTokens: ReadonlySet<string>;
}): boolean {
  if (input.intentTokens.size === 0) return false;
  for (const token of input.defaultKeyTokens) {
    if (input.intentTokens.has(token)) return true;
  }
  return false;
}

function manifestPolicyExclusion(
  manifest: CapabilityManifest,
  policy: {
    agentScope: ReadonlySet<string>;
    workspaceScope: ReadonlySet<string>;
    allowedAccounts?: readonly string[];
  },
): CapabilitySelectionFilteredOut["reason"] | undefined {
  if (!intersects(manifest.agentScope, policy.agentScope)) {
    return "agent_scope";
  }
  if (!intersects(manifest.workspaceScope, policy.workspaceScope)) {
    return "workspace_scope";
  }
  if (
    manifest.authProfile &&
    policy.allowedAccounts &&
    policy.allowedAccounts.length > 0 &&
    !policy.allowedAccounts.includes(manifest.authProfile)
  ) {
    return "account_restriction";
  }
  return undefined;
}

const manifestHashCache = new WeakMap<CapabilityManifest, string>();

// Content identity for one manifest: every authored field, no filePath — a
// pure file rename must not change a manifest's identity or revoke selections
// pinned to it.
export function computeCapabilityManifestHash(manifest: CapabilityManifest): string {
  const cached = manifestHashCache.get(manifest);
  if (cached) return cached;
  const { filePath: _filePath, ...content } = manifest;
  const hash = stableJsonSha256Hex(content);
  manifestHashCache.set(manifest, hash);
  return hash;
}

// The registry version derives from the full content identity of every
// manifest. Sorted byte-wise (not localeCompare) so the version is identical
// across process locales and ICU versions.
export function computeCapabilityRegistryVersion(manifests: readonly CapabilityManifest[]): string {
  return stableJsonSha256Hex(
    manifests.map((manifest) => computeCapabilityManifestHash(manifest)).toSorted(),
  );
}

function buildSelectionId(input: Omit<CapabilitySelectionReceipt, "selection_id">): string {
  return `cap_sel_${stableJsonSha256Hex({
    trigger: input.trigger,
    input_intent_hash: input.input_intent_hash,
    selected_capabilities: input.selected_capabilities,
    filtered_out: input.filtered_out,
    policy_decisions: input.policy_decisions,
    conflicts: input.conflicts,
    carried_from: input.carried_from,
    registry_version: input.registry_version,
  }).slice(0, 24)}`;
}

export function selectCapabilities(input: SelectCapabilitiesInput): CapabilitySelectionReceipt {
  const maxCandidates = Math.max(0, Math.min(3, input.maxCandidates ?? 3));
  const policy = input.policy ?? {};
  const intentTokens = textTokens(input.intentText);
  const agentScope = new Set(policy.agentScope ?? []);
  const workspaceScope = new Set(policy.workspaceScope ?? []);
  const filteredOut: CapabilitySelectionFilteredOut[] = [];
  const policyDecisions: string[] = [];

  const scoped = input.manifests.filter((manifest) => {
    const exclusion = manifestPolicyExclusion(manifest, {
      agentScope,
      workspaceScope,
      allowedAccounts: policy.allowedAccounts,
    });
    if (exclusion) {
      filteredOut.push({ name: manifest.name, reason: exclusion });
      return false;
    }
    return true;
  });

  const selected: CapabilitySelectionCandidate[] = [];
  const conflicts: CapabilitySelectionConflict[] = [];
  const explicitName = input.explicitCapability?.trim();
  if (explicitName) {
    const manifest = scoped.find((entry) => entry.name === explicitName);
    if (manifest) {
      selected.push({
        name: manifest.name,
        source: "explicit",
        score: 1_000,
        reason: "explicit capability target",
        manifestHash: computeCapabilityManifestHash(manifest),
      });
    } else {
      policyDecisions.push(`explicit capability '${explicitName}' was not allowed by policy`);
    }
  }

  if (selected.length === 0 && policy.defaults) {
    const defaultEntries = Object.entries(policy.defaults);
    const defaultKeyTokens = new Map(
      defaultEntries.map(([key]) => [key, textTokens(key)] as const),
    );
    const defaultMatches = scoped.filter((manifest) =>
      defaultEntries.some(
        ([key, capabilityName]) =>
          capabilityName === manifest.name &&
          policyDefaultMatchesIntent({
            defaultKeyTokens: defaultKeyTokens.get(key) ?? new Set<string>(),
            intentTokens,
          }),
      ),
    );
    const defaultManifest = defaultMatches[0];
    if (defaultMatches.length === 1 && defaultManifest) {
      selected.push({
        name: defaultManifest.name,
        source: "policy",
        score: 900,
        reason: "policy default",
        manifestHash: computeCapabilityManifestHash(defaultManifest),
      });
    } else if (defaultMatches.length > 1) {
      conflicts.push({
        group: "policy_defaults",
        candidates: defaultMatches.map((manifest) => manifest.name).toSorted(),
        reason: "multiple workspace or user defaults matched",
      });
    }
  }

  if (selected.length === 0 && conflicts.length === 0) {
    const ranked = scoped
      .map((manifest) => ({
        manifest,
        score: scoreManifestTokens(manifest, intentTokens),
      }))
      .filter((entry) => entry.score > 0)
      .toSorted(
        (left, right) =>
          right.score - left.score || left.manifest.name.localeCompare(right.manifest.name),
      );
    const top = ranked.slice(0, maxCandidates);
    selected.push(
      ...top.map((entry) => ({
        name: entry.manifest.name,
        source: "deterministic" as const,
        score: entry.score,
        reason: "selection fields matched intent text",
        manifestHash: computeCapabilityManifestHash(entry.manifest),
      })),
    );
    for (const entry of ranked.slice(maxCandidates)) {
      filteredOut.push({ name: entry.manifest.name, reason: "not_ranked" });
    }
  }

  if (selected.length > 1) {
    const selectedSet = new Set(selected.map((entry) => entry.name));
    for (const manifest of scoped) {
      if (!selectedSet.has(manifest.name)) continue;
      const conflictNames = manifest.conflictsWith.filter((name) => selectedSet.has(name));
      if (conflictNames.length === 0) continue;
      conflicts.push({
        group: manifest.name,
        candidates: [manifest.name, ...conflictNames].toSorted(),
        reason: "selected capabilities declare conflicts_with",
      });
    }
    if (conflicts.length > 0) {
      for (const entry of selected) {
        filteredOut.push({ name: entry.name, reason: "conflict" });
      }
      selected.length = 0;
      policyDecisions.push("conflicting capabilities were not exposed");
    }
  }

  const event = {
    trigger: input.trigger,
    input_intent_hash: stableJsonSha256Hex({
      intentText: input.intentText ?? "",
      explicitCapability: explicitName ?? "",
    }),
    selected_capabilities: selected.filter((entry) => entry.name),
    filtered_out: filteredOut,
    policy_decisions: policyDecisions,
    conflicts,
    created_at: input.createdAt ?? new Date().toISOString(),
    registry_version: input.registryVersion ?? computeCapabilityRegistryVersion(input.manifests),
  } satisfies Omit<CapabilitySelectionReceipt, "selection_id">;

  return {
    selection_id: buildSelectionId(event),
    ...event,
  };
}

export interface ResolveCarriedCapabilityReceiptInput {
  registry: Pick<CapabilityRegistry, "manifests" | "registryVersion">;
  policy: CapabilityPolicy;
  previous: CapabilitySelectionReceipt;
  createdAt?: string;
}

/**
 * Carried selections are revalidated per entry, every carried turn: an entry
 * survives only while its manifest still exists with identical content
 * (`manifestHash`) and still passes the current policy scope. Registry churn
 * that leaves a selected manifest untouched therefore never revokes it, while
 * a policy narrowed mid-session or an edited manifest drops exactly the
 * affected entries. Entries from receipts predating manifest hashing cannot
 * be revalidated and drop as stale.
 */
export function resolveCarriedCapabilityReceipt(
  input: ResolveCarriedCapabilityReceiptInput,
): CapabilitySelectionReceipt {
  const agentScope = new Set(input.policy.agentScope ?? []);
  const workspaceScope = new Set(input.policy.workspaceScope ?? []);
  const manifestsByName = new Map(
    input.registry.manifests.map((manifest) => [manifest.name, manifest]),
  );
  const kept: CapabilitySelectionCandidate[] = [];
  const droppedFilteredOut: CapabilitySelectionFilteredOut[] = [];
  const policyDecisions: string[] = [];
  let staleDrops = 0;

  for (const entry of input.previous.selected_capabilities) {
    const manifest = manifestsByName.get(entry.name);
    if (!manifest) {
      staleDrops += 1;
      policyDecisions.push(`carried_selection_dropped: ${entry.name} manifest_missing`);
      continue;
    }
    if (!entry.manifestHash || entry.manifestHash !== computeCapabilityManifestHash(manifest)) {
      staleDrops += 1;
      policyDecisions.push(
        `carried_selection_dropped: ${entry.name} ${
          entry.manifestHash ? "manifest_changed" : "manifest_hash_unavailable"
        }`,
      );
      continue;
    }
    const exclusion = manifestPolicyExclusion(manifest, {
      agentScope,
      workspaceScope,
      allowedAccounts: input.policy.allowedAccounts,
    });
    if (exclusion) {
      droppedFilteredOut.push({ name: entry.name, reason: exclusion });
      policyDecisions.push(`carried_selection_dropped: ${entry.name} ${exclusion}`);
      continue;
    }
    // A policy grant only outlives its rule: when the administrator removes
    // or remaps the default that minted this entry, the carried authority
    // dies with it instead of persisting as an orphaned grant.
    if (
      entry.source === "policy" &&
      !Object.values(input.policy.defaults ?? {}).includes(entry.name)
    ) {
      policyDecisions.push(`carried_selection_dropped: ${entry.name} policy_default_removed`);
      continue;
    }
    kept.push(Object.assign({}, entry));
  }

  const versionMatches = input.previous.registry_version === input.registry.registryVersion;
  if (versionMatches && kept.length === input.previous.selected_capabilities.length) {
    return carryCapabilitySelection({ previous: input.previous, createdAt: input.createdAt });
  }

  // Same policy-exclusion carry rule as carryCapabilitySelection, extended
  // with the exclusions discovered by this revalidation (deduped by name).
  const droppedNames = new Set(droppedFilteredOut.map((entry) => entry.name));
  const filteredOut = [
    ...input.previous.filtered_out
      .filter((entry) => entry.reason !== "not_ranked" && !droppedNames.has(entry.name))
      .map((entry) => Object.assign({}, entry)),
    ...droppedFilteredOut,
  ];
  // Stale entries (missing/changed/unhashed manifests) are registry-relative
  // staleness even when the aggregate version happens to match; pure policy
  // drops under a matching version are the only policy_change shape.
  const event = {
    trigger: (!versionMatches || staleDrops > 0
      ? "registry_change"
      : "policy_change") as CapabilitySelectionTrigger,
    input_intent_hash: input.previous.input_intent_hash,
    selected_capabilities: kept,
    filtered_out: filteredOut,
    policy_decisions: [
      `carried selection ${input.previous.selection_id} revalidated against the current registry and policy`,
      ...policyDecisions,
    ],
    conflicts: input.previous.conflicts.map((entry) => Object.assign({}, entry)),
    carried_from: input.previous.selection_id,
    created_at: input.createdAt ?? new Date().toISOString(),
    registry_version: input.registry.registryVersion,
  } satisfies Omit<CapabilitySelectionReceipt, "selection_id">;
  return {
    selection_id: buildSelectionId(event),
    ...event,
  };
}

export function carryCapabilitySelection(
  input: CarryCapabilitySelectionInput,
): CapabilitySelectionReceipt {
  const event = {
    trigger: "carried" as const,
    input_intent_hash: input.previous.input_intent_hash,
    selected_capabilities: input.previous.selected_capabilities.map((entry) =>
      Object.assign({}, entry),
    ),
    // Policy exclusions are prompt-independent, so they carry; `not_ranked` is
    // intent-relative and does not (a carried turn has no intent to rank against).
    // Dropping them entirely would flip policy-forbidden manifests into the
    // selectable catalog on every carried turn.
    filtered_out: input.previous.filtered_out
      .filter((entry) => entry.reason !== "not_ranked")
      .map((entry) => Object.assign({}, entry)),
    policy_decisions: ["carried from previous capability selection receipt"],
    conflicts: input.previous.conflicts.map((entry) => Object.assign({}, entry)),
    carried_from: input.previous.selection_id,
    created_at: input.createdAt ?? new Date().toISOString(),
    registry_version: input.previous.registry_version,
  } satisfies Omit<CapabilitySelectionReceipt, "selection_id">;
  return {
    selection_id: buildSelectionId(event),
    ...event,
  };
}
