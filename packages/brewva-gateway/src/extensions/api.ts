import { isRecord } from "@brewva/brewva-std/unknown";
import type {
  InternalHostPlugin,
  InternalHostPluginApi,
  RuntimePluginCapability,
} from "@brewva/brewva-substrate/host-api";
import { defineInternalHostPlugin as defineSubstrateHostPlugin } from "@brewva/brewva-substrate/host-api";

export interface HostedExtensionApi extends InternalHostPluginApi {}

export interface HostedExtensionPlugin extends InternalHostPlugin {
  readonly name: string;
  readonly capabilities: readonly HostedExtensionCapability[];
  readonly advisoryManifest?: AdvisoryExtensionManifest;
  readonly advisoryManifestPrecedence?: AdvisoryExtensionPrecedence;
  readonly verificationGateManifests?: readonly VerificationGateManifest[];
  readonly manifestDiagnostics?: readonly AdvisoryExtensionManifestDiagnostic[];
  register(api: HostedExtensionApi): void | Promise<void>;
}

export type HostedExtensionCapability = RuntimePluginCapability;

interface HostedExtensionPluginDefinitionBase {
  readonly name: string;
  readonly capabilities: readonly HostedExtensionCapability[];
  readonly advisoryManifestPrecedence?: AdvisoryExtensionPrecedence;
  readonly verificationGateManifests?: readonly unknown[];
  register(api: HostedExtensionApi): void | Promise<void>;
}

export interface HostedExtensionPluginDefinition extends HostedExtensionPluginDefinitionBase {
  readonly advisoryManifest: unknown;
}

export const ADVISORY_EXTENSION_MANIFEST_SCHEMA_V1 =
  "brewva.advisory-extension.manifest.v1" as const;

export const VERIFICATION_GATE_MANIFEST_SCHEMA_V1 = "brewva.verification-gate.manifest.v1" as const;

export type AdvisoryExtensionSlot =
  | "surface.command"
  | "skill.provider"
  | "context.contributor"
  | "inspect.renderer"
  | "verifier.adapter"
  | "channel.renderer"
  | "capability.manifest_provider";

export type AdvisoryExtensionAmbientCapabilityClass = "pure" | "read_tape" | "read_fs";

export type AdvisoryExtensionPrecedence = "built_in" | "package" | "project" | "user";

export interface AdvisoryExtensionManifest {
  readonly apiVersion: typeof ADVISORY_EXTENSION_MANIFEST_SCHEMA_V1;
  readonly slot: AdvisoryExtensionSlot;
  readonly name: string;
  readonly ambientCapabilityClass: AdvisoryExtensionAmbientCapabilityClass;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
}

export type VerificationGatePosture = "advisory" | "defer" | "abort";

export interface VerificationGateManifest {
  readonly apiVersion: typeof VERIFICATION_GATE_MANIFEST_SCHEMA_V1;
  readonly adapter: string;
  readonly targetRoots: readonly string[];
  readonly patchSetRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly freshness: {
    readonly maxAgeMs: number;
  };
  readonly posture: {
    readonly missing: VerificationGatePosture;
    readonly stale: VerificationGatePosture;
    readonly failed: VerificationGatePosture;
  };
}

export type VerificationGateEvidenceStatus = "passed" | "failed";

export interface VerificationGateEvidence {
  readonly ref: string;
  readonly adapter: string;
  readonly targetRoots: readonly string[];
  readonly patchSetRefs: readonly string[];
  readonly status: VerificationGateEvidenceStatus;
  readonly observedAt: number;
}

export type VerificationGateEvaluationStatus = "ok" | "missing" | "stale" | "failed";

export interface VerificationGatePolicyInput {
  readonly gateId: string;
  readonly adapter: string;
  readonly status: Exclude<VerificationGateEvaluationStatus, "ok">;
  readonly posture: VerificationGatePosture;
  readonly targetRoots: readonly string[];
  readonly patchSetRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly reason: string;
}

export interface VerificationGateEvaluation {
  readonly gateId: string;
  readonly adapter: string;
  readonly status: VerificationGateEvaluationStatus;
  readonly posture: VerificationGatePosture;
  readonly evidenceRefs: readonly string[];
  readonly reason?: string;
  readonly policyInput?: VerificationGatePolicyInput;
}

export interface AdvisoryExtensionManifestDiagnostic {
  readonly code: "unknown_field" | "invalid_manifest" | "shadowed_manifest";
  readonly message: string;
  readonly slot?: string;
  readonly name?: string;
  readonly field?: string;
  readonly precedence?: AdvisoryExtensionPrecedence;
  readonly shadowedBy?: AdvisoryExtensionPrecedence;
}

export type AdvisoryExtensionManifestParseResult =
  | { readonly ok: true; readonly manifest: AdvisoryExtensionManifest }
  | { readonly ok: false; readonly diagnostics: readonly AdvisoryExtensionManifestDiagnostic[] };

export type VerificationGateManifestParseResult =
  | { readonly ok: true; readonly manifest: VerificationGateManifest }
  | { readonly ok: false; readonly diagnostics: readonly AdvisoryExtensionManifestDiagnostic[] };

export interface AdvisoryExtensionManifestCandidate {
  readonly precedence: AdvisoryExtensionPrecedence;
  readonly manifest: unknown;
}

export interface AdvisoryExtensionManifestResolution {
  readonly manifests: readonly AdvisoryExtensionManifest[];
  readonly diagnostics: readonly AdvisoryExtensionManifestDiagnostic[];
}

const ADVISORY_EXTENSION_MANIFEST_FIELDS = new Set([
  "apiVersion",
  "slot",
  "name",
  "ambientCapabilityClass",
  "inputs",
  "outputs",
]);

const VERIFICATION_GATE_MANIFEST_FIELDS = new Set([
  "apiVersion",
  "adapter",
  "targetRoots",
  "patchSetRefs",
  "evidenceRefs",
  "freshness",
  "posture",
]);
const VERIFICATION_GATE_FRESHNESS_FIELDS = new Set(["maxAgeMs"]);
const VERIFICATION_GATE_POSTURE_FIELDS = new Set(["missing", "stale", "failed"]);

const ADVISORY_EXTENSION_SLOTS = new Set<AdvisoryExtensionSlot>([
  "surface.command",
  "skill.provider",
  "context.contributor",
  "inspect.renderer",
  "verifier.adapter",
  "channel.renderer",
  "capability.manifest_provider",
]);

const ADVISORY_EXTENSION_AMBIENT_CLASSES = new Set<AdvisoryExtensionAmbientCapabilityClass>([
  "pure",
  "read_tape",
  "read_fs",
]);

const PRECEDENCE_RANK: Record<AdvisoryExtensionPrecedence, number> = {
  built_in: 0,
  package: 1,
  project: 2,
  user: 3,
};

const ADVISORY_SLOT_CAPABILITIES: Record<
  AdvisoryExtensionSlot,
  readonly RuntimePluginCapability[]
> = {
  "surface.command": [
    "tool_registration.write",
    "user_message.enqueue",
    "assistant_message.enqueue",
  ],
  "skill.provider": ["context_messages.write"],
  "context.contributor": ["context_messages.write"],
  "inspect.renderer": ["context_messages.write"],
  "verifier.adapter": [],
  "channel.renderer": ["assistant_message.enqueue"],
  "capability.manifest_provider": [],
};

const ADVISORY_SLOT_EVENTS: Record<AdvisoryExtensionSlot, readonly string[]> = {
  "surface.command": ["session_start", "session_switch", "session_shutdown"],
  "skill.provider": ["before_agent_start", "context"],
  "context.contributor": ["context", "before_agent_start"],
  "inspect.renderer": ["context", "before_agent_start"],
  "verifier.adapter": ["tool_result", "tool_execution_end", "session_shutdown"],
  "channel.renderer": ["message_end", "turn_end", "session_shutdown"],
  "capability.manifest_provider": ["session_start", "session_shutdown"],
};

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const values = value.flatMap((entry) => {
    const text = readString(entry);
    return text ? [text] : [];
  });
  return values.length === value.length ? values : null;
}

function readPositiveInteger(value: unknown): number | null {
  return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : null;
}

function readVerificationGatePosture(value: unknown): VerificationGateManifest["posture"] | null {
  if (!isRecord(value)) {
    return null;
  }
  const missing = readString(value.missing);
  const stale = readString(value.stale);
  const failed = readString(value.failed);
  if (
    !missing ||
    !stale ||
    !failed ||
    !isVerificationGatePosture(missing) ||
    !isVerificationGatePosture(stale) ||
    !isVerificationGatePosture(failed)
  ) {
    return null;
  }
  return { missing, stale, failed };
}

function isVerificationGatePosture(value: string): value is VerificationGatePosture {
  return value === "advisory" || value === "defer" || value === "abort";
}

function verificationGateIdForManifest(manifest: VerificationGateManifest): string {
  return [
    manifest.adapter,
    manifest.targetRoots.join(","),
    manifest.patchSetRefs.join(","),
    manifest.evidenceRefs.join(","),
  ].join(":");
}

function containsAll(haystack: readonly string[], needles: readonly string[]): boolean {
  return needles.every((needle) => haystack.includes(needle));
}

function matchingVerificationEvidence(
  manifest: VerificationGateManifest,
  evidence: readonly VerificationGateEvidence[],
): VerificationGateEvidence[] {
  return evidence
    .filter(
      (entry) =>
        manifest.evidenceRefs.includes(entry.ref) &&
        entry.adapter === manifest.adapter &&
        containsAll(entry.targetRoots, manifest.targetRoots) &&
        containsAll(entry.patchSetRefs, manifest.patchSetRefs),
    )
    .toSorted((left, right) => right.observedAt - left.observedAt);
}

function buildVerificationGatePolicyInput(input: {
  readonly manifest: VerificationGateManifest;
  readonly gateId: string;
  readonly status: Exclude<VerificationGateEvaluationStatus, "ok">;
  readonly posture: VerificationGatePosture;
  readonly evidenceRefs: readonly string[];
  readonly reason: string;
}): VerificationGatePolicyInput {
  return {
    gateId: input.gateId,
    adapter: input.manifest.adapter,
    status: input.status,
    posture: input.posture,
    targetRoots: input.manifest.targetRoots,
    patchSetRefs: input.manifest.patchSetRefs,
    evidenceRefs: input.evidenceRefs,
    reason: input.reason,
  };
}

export function parseAdvisoryExtensionManifest(
  value: unknown,
): AdvisoryExtensionManifestParseResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      diagnostics: [{ code: "invalid_manifest", message: "Manifest must be an object." }],
    };
  }
  const unknownFields = Object.keys(value).filter(
    (field) => !ADVISORY_EXTENSION_MANIFEST_FIELDS.has(field),
  );
  if (unknownFields.length > 0) {
    return {
      ok: false,
      diagnostics: unknownFields.map((field) => ({
        code: "unknown_field",
        message: `Unknown advisory extension manifest field '${field}'.`,
        field,
      })),
    };
  }
  const apiVersion = value.apiVersion;
  const slot = readString(value.slot);
  const name = readString(value.name);
  const ambientCapabilityClass = readString(value.ambientCapabilityClass);
  const inputs = readStringArray(value.inputs);
  const outputs = readStringArray(value.outputs);
  if (
    apiVersion !== ADVISORY_EXTENSION_MANIFEST_SCHEMA_V1 ||
    !slot ||
    !ADVISORY_EXTENSION_SLOTS.has(slot as AdvisoryExtensionSlot) ||
    !name ||
    !ambientCapabilityClass ||
    !ADVISORY_EXTENSION_AMBIENT_CLASSES.has(
      ambientCapabilityClass as AdvisoryExtensionAmbientCapabilityClass,
    ) ||
    !inputs ||
    !outputs
  ) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "invalid_manifest",
          message: "Manifest fields do not match the advisory extension v1 contract.",
          slot: slot ?? undefined,
          name: name ?? undefined,
        },
      ],
    };
  }

  return {
    ok: true,
    manifest: {
      apiVersion,
      slot: slot as AdvisoryExtensionSlot,
      name,
      ambientCapabilityClass: ambientCapabilityClass as AdvisoryExtensionAmbientCapabilityClass,
      inputs,
      outputs,
    },
  };
}

export function parseVerificationGateManifest(value: unknown): VerificationGateManifestParseResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      diagnostics: [{ code: "invalid_manifest", message: "Manifest must be an object." }],
    };
  }
  const unknownFields = Object.keys(value).filter(
    (field) => !VERIFICATION_GATE_MANIFEST_FIELDS.has(field),
  );
  if (unknownFields.length > 0) {
    return {
      ok: false,
      diagnostics: unknownFields.map((field) => ({
        code: "unknown_field",
        message: `Unknown verification gate manifest field '${field}'.`,
        field,
      })),
    };
  }
  const nestedUnknownFields = [
    ...(isRecord(value.freshness)
      ? Object.keys(value.freshness)
          .filter((field) => !VERIFICATION_GATE_FRESHNESS_FIELDS.has(field))
          .map((field) => `freshness.${field}`)
      : []),
    ...(isRecord(value.posture)
      ? Object.keys(value.posture)
          .filter((field) => !VERIFICATION_GATE_POSTURE_FIELDS.has(field))
          .map((field) => `posture.${field}`)
      : []),
  ];
  if (nestedUnknownFields.length > 0) {
    return {
      ok: false,
      diagnostics: nestedUnknownFields.map((field) => ({
        code: "unknown_field",
        message: `Unknown verification gate manifest field '${field}'.`,
        field,
      })),
    };
  }

  const apiVersion = value.apiVersion;
  const adapter = readString(value.adapter);
  const targetRoots = readStringArray(value.targetRoots);
  const patchSetRefs = readStringArray(value.patchSetRefs);
  const evidenceRefs = readStringArray(value.evidenceRefs);
  const freshness = isRecord(value.freshness)
    ? { maxAgeMs: readPositiveInteger(value.freshness.maxAgeMs) }
    : null;
  const posture = readVerificationGatePosture(value.posture);
  if (
    apiVersion !== VERIFICATION_GATE_MANIFEST_SCHEMA_V1 ||
    !adapter ||
    !targetRoots ||
    targetRoots.length === 0 ||
    !patchSetRefs ||
    patchSetRefs.length === 0 ||
    !evidenceRefs ||
    evidenceRefs.length === 0 ||
    freshness?.maxAgeMs === null ||
    freshness?.maxAgeMs === undefined ||
    !posture
  ) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "invalid_manifest",
          message: "Manifest fields do not match the verification gate v1 contract.",
          name: adapter ?? undefined,
        },
      ],
    };
  }

  return {
    ok: true,
    manifest: {
      apiVersion,
      adapter,
      targetRoots,
      patchSetRefs,
      evidenceRefs,
      freshness: { maxAgeMs: freshness.maxAgeMs },
      posture,
    },
  };
}

export function evaluateVerificationGateManifest(input: {
  readonly manifest: VerificationGateManifest;
  readonly evidence: readonly VerificationGateEvidence[];
  readonly now: number;
}): VerificationGateEvaluation {
  const gateId = verificationGateIdForManifest(input.manifest);
  const matches = matchingVerificationEvidence(input.manifest, input.evidence);
  const latest = matches[0];
  if (!latest) {
    const reason = `verification_gate_missing:${input.manifest.adapter}`;
    return {
      gateId,
      adapter: input.manifest.adapter,
      status: "missing",
      posture: input.manifest.posture.missing,
      evidenceRefs: [],
      reason,
      policyInput: buildVerificationGatePolicyInput({
        manifest: input.manifest,
        gateId,
        status: "missing",
        posture: input.manifest.posture.missing,
        evidenceRefs: [],
        reason,
      }),
    };
  }
  if (input.now - latest.observedAt > input.manifest.freshness.maxAgeMs) {
    const reason = `verification_gate_stale:${input.manifest.adapter}:${latest.ref}`;
    return {
      gateId,
      adapter: input.manifest.adapter,
      status: "stale",
      posture: input.manifest.posture.stale,
      evidenceRefs: [latest.ref],
      reason,
      policyInput: buildVerificationGatePolicyInput({
        manifest: input.manifest,
        gateId,
        status: "stale",
        posture: input.manifest.posture.stale,
        evidenceRefs: [latest.ref],
        reason,
      }),
    };
  }
  if (latest.status === "failed") {
    const reason = `verification_gate_failed:${input.manifest.adapter}:${latest.ref}`;
    return {
      gateId,
      adapter: input.manifest.adapter,
      status: "failed",
      posture: input.manifest.posture.failed,
      evidenceRefs: [latest.ref],
      reason,
      policyInput: buildVerificationGatePolicyInput({
        manifest: input.manifest,
        gateId,
        status: "failed",
        posture: input.manifest.posture.failed,
        evidenceRefs: [latest.ref],
        reason,
      }),
    };
  }
  return {
    gateId,
    adapter: input.manifest.adapter,
    status: "ok",
    posture: "advisory",
    evidenceRefs: [latest.ref],
  };
}

export function resolveAdvisoryExtensionManifests(
  candidates: readonly AdvisoryExtensionManifestCandidate[],
): AdvisoryExtensionManifestResolution {
  const accepted = new Map<
    string,
    {
      readonly manifest: AdvisoryExtensionManifest;
      readonly precedence: AdvisoryExtensionPrecedence;
    }
  >();
  const diagnostics: AdvisoryExtensionManifestDiagnostic[] = [];
  const ordered = [...candidates].toSorted(
    (left, right) => PRECEDENCE_RANK[left.precedence] - PRECEDENCE_RANK[right.precedence],
  );

  for (const candidate of ordered) {
    const parsed = parseAdvisoryExtensionManifest(candidate.manifest);
    if (!parsed.ok) {
      diagnostics.push(
        ...parsed.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          precedence: candidate.precedence,
        })),
      );
      continue;
    }
    const key = `${parsed.manifest.slot}:${parsed.manifest.name}`;
    const existing = accepted.get(key);
    if (existing) {
      diagnostics.push({
        code: "shadowed_manifest",
        message: `Manifest ${key} from ${candidate.precedence} is shadowed by ${existing.precedence}.`,
        slot: parsed.manifest.slot,
        name: parsed.manifest.name,
        precedence: candidate.precedence,
        shadowedBy: existing.precedence,
      });
      continue;
    }
    accepted.set(key, { manifest: parsed.manifest, precedence: candidate.precedence });
  }

  return {
    manifests: [...accepted.values()].map((entry) => entry.manifest),
    diagnostics,
  };
}

function manifestError(
  prefix: string,
  diagnostics: readonly AdvisoryExtensionManifestDiagnostic[],
): Error {
  return new Error(`${prefix}:${diagnostics.map((diagnostic) => diagnostic.message).join("; ")}`);
}

function parseHostedAdvisoryManifest(
  plugin: HostedExtensionPluginDefinition,
): AdvisoryExtensionManifest {
  const rawManifest = plugin.advisoryManifest;
  if (rawManifest === undefined) {
    throw new Error(`hosted_extension_advisory_manifest_required:${plugin.name}`);
  }
  const parsed = parseAdvisoryExtensionManifest(rawManifest);
  if (!parsed.ok) {
    throw manifestError(
      `hosted_extension_advisory_manifest_invalid:${plugin.name}`,
      parsed.diagnostics,
    );
  }
  if (parsed.manifest.name !== plugin.name) {
    throw new Error(
      `hosted_extension_advisory_manifest_name_mismatch:${plugin.name}:${parsed.manifest.name}`,
    );
  }
  return parsed.manifest;
}

function parseHostedVerificationGateManifests(
  plugin: HostedExtensionPluginDefinition,
): readonly VerificationGateManifest[] {
  const rawManifests = plugin.verificationGateManifests ?? [];
  return rawManifests.map((rawManifest) => {
    const parsed = parseVerificationGateManifest(rawManifest);
    if (!parsed.ok) {
      throw manifestError(
        `hosted_extension_verification_gate_manifest_invalid:${plugin.name}`,
        parsed.diagnostics,
      );
    }
    return parsed.manifest;
  });
}

function assertAdvisoryManifestAllowsCapabilities(input: {
  readonly pluginName: string;
  readonly manifest: AdvisoryExtensionManifest;
  readonly capabilities: readonly RuntimePluginCapability[];
}): void {
  const allowed = new Set(ADVISORY_SLOT_CAPABILITIES[input.manifest.slot]);
  const disallowed = input.capabilities.filter((capability) => !allowed.has(capability));
  if (disallowed.length > 0) {
    throw new Error(
      `hosted_extension_manifest_capability_violation:${input.pluginName}:${input.manifest.slot}:${disallowed.join(",")}`,
    );
  }
}

function assertVerificationGateManifestsAllowedForSlot(input: {
  readonly pluginName: string;
  readonly manifest: AdvisoryExtensionManifest;
  readonly verificationGateManifests: readonly VerificationGateManifest[];
}): void {
  if (input.verificationGateManifests.length === 0 || input.manifest.slot === "verifier.adapter") {
    return;
  }
  throw new Error(
    `hosted_extension_verification_gate_manifest_slot_violation:${input.pluginName}:${input.manifest.slot}`,
  );
}

function assertAdvisoryManifestAllowsCapability(input: {
  readonly pluginName: string;
  readonly manifest: AdvisoryExtensionManifest;
  readonly capability: RuntimePluginCapability;
  readonly operation: string;
}): void {
  if (ADVISORY_SLOT_CAPABILITIES[input.manifest.slot].includes(input.capability)) {
    return;
  }
  throw new Error(
    `hosted_extension_manifest_capability_violation:${input.pluginName}:${input.manifest.slot}:${input.operation}:${input.capability}`,
  );
}

function assertAdvisoryManifestAllowsEvent(input: {
  readonly pluginName: string;
  readonly manifest: AdvisoryExtensionManifest;
  readonly event: string;
}): void {
  if (ADVISORY_SLOT_EVENTS[input.manifest.slot].includes(input.event)) {
    return;
  }
  throw new Error(
    `hosted_extension_manifest_event_violation:${input.pluginName}:${input.manifest.slot}:${input.event}`,
  );
}

function createManifestGuardedExtensionApi(input: {
  readonly pluginName: string;
  readonly manifest: AdvisoryExtensionManifest;
  readonly api: HostedExtensionApi;
}): HostedExtensionApi {
  const { pluginName, manifest, api } = input;
  return {
    ...api,
    on(event, handler) {
      assertAdvisoryManifestAllowsEvent({ pluginName, manifest, event });
      api.on(event, handler);
    },
    registerTool(tool) {
      assertAdvisoryManifestAllowsCapability({
        pluginName,
        manifest,
        capability: "tool_registration.write",
        operation: "registerTool",
      });
      api.registerTool(tool);
    },
    registerCommand(name, command) {
      assertAdvisoryManifestAllowsCapability({
        pluginName,
        manifest,
        capability: "tool_registration.write",
        operation: "registerCommand",
      });
      api.registerCommand(name, command);
    },
    sendMessage(message, options) {
      assertAdvisoryManifestAllowsCapability({
        pluginName,
        manifest,
        capability: "assistant_message.enqueue",
        operation: "sendMessage",
      });
      api.sendMessage(message, options);
    },
    sendUserMessage(content, options) {
      assertAdvisoryManifestAllowsCapability({
        pluginName,
        manifest,
        capability: "user_message.enqueue",
        operation: "sendUserMessage",
      });
      api.sendUserMessage(content, options);
    },
    setActiveTools(toolNames) {
      assertAdvisoryManifestAllowsCapability({
        pluginName,
        manifest,
        capability: "tool_surface.write",
        operation: "setActiveTools",
      });
      api.setActiveTools(toolNames);
    },
    refreshTools() {
      assertAdvisoryManifestAllowsCapability({
        pluginName,
        manifest,
        capability: "tool_surface.write",
        operation: "refreshTools",
      });
      api.refreshTools();
    },
  };
}

export interface HostedExtensionManifestCollection {
  readonly advisory: AdvisoryExtensionManifestResolution;
  readonly verificationGateManifests: readonly VerificationGateManifest[];
  readonly diagnostics: readonly AdvisoryExtensionManifestDiagnostic[];
}

export function collectHostedExtensionManifests(
  plugins: readonly InternalHostPlugin[] | undefined,
): HostedExtensionManifestCollection {
  const hostedPlugins = (plugins ?? []) as readonly HostedExtensionPlugin[];
  const candidates = hostedPlugins.flatMap((plugin): AdvisoryExtensionManifestCandidate[] =>
    plugin.advisoryManifest
      ? [
          {
            precedence: plugin.advisoryManifestPrecedence ?? "package",
            manifest: plugin.advisoryManifest,
          },
        ]
      : [],
  );
  const advisory = resolveAdvisoryExtensionManifests(candidates);
  return {
    advisory,
    verificationGateManifests: hostedPlugins.flatMap(
      (plugin) => plugin.verificationGateManifests ?? [],
    ),
    diagnostics: advisory.diagnostics,
  };
}

export function defineHostedExtensionPlugin(
  plugin: HostedExtensionPluginDefinition,
): HostedExtensionPlugin {
  const advisoryManifest = parseHostedAdvisoryManifest(plugin);
  const verificationGateManifests = parseHostedVerificationGateManifests(plugin);
  const advisoryManifestPrecedence = plugin.advisoryManifestPrecedence ?? "package";
  assertAdvisoryManifestAllowsCapabilities({
    pluginName: plugin.name,
    manifest: advisoryManifest,
    capabilities: plugin.capabilities,
  });
  assertVerificationGateManifestsAllowedForSlot({
    pluginName: plugin.name,
    manifest: advisoryManifest,
    verificationGateManifests,
  });

  const hostedPlugin: HostedExtensionPlugin = {
    name: plugin.name,
    capabilities: plugin.capabilities,
    advisoryManifest,
    advisoryManifestPrecedence,
    ...(verificationGateManifests.length > 0 ? { verificationGateManifests } : {}),
    register(api) {
      return plugin.register(
        createManifestGuardedExtensionApi({
          pluginName: plugin.name,
          manifest: advisoryManifest,
          api,
        }),
      );
    },
  };
  return defineSubstrateHostPlugin(hostedPlugin) as HostedExtensionPlugin;
}

export type {
  LocalHookNote,
  LocalHookPhase,
  LocalHookPort,
  LocalHookPostReceiptInput,
  LocalHookPostReceiptResult,
  LocalHookPostRollbackInput,
  LocalHookPostRollbackResult,
  LocalHookPostTerminalInput,
  LocalHookPostTerminalResult,
  LocalHookPreAdmissionInput,
  LocalHookPreAdmissionResult,
  LocalHookPreEffectInput,
  LocalHookPreEffectResult,
  LocalHookRecommendation,
  LocalHookResult,
} from "../hosted/internal/hooks/local-hook-port.js";
