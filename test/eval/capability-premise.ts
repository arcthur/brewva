import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  loadCapabilityRegistry,
  selectCapabilities,
  type CapabilityManifest,
  type CapabilitySelectionReceipt,
} from "../../packages/brewva-gateway/src/hosted/internal/session/tools/capability-registry.js";
import { extractExplicitCapability } from "../../packages/brewva-gateway/src/hosted/internal/session/tools/capability-selection.js";
import type { EvalCapabilitySelectionPremise, EvalScenario } from "./types.js";

// Premise gate for generic runtime scenarios that stage capability manifests.
//
// It re-runs the REAL production selection path (`loadCapabilityRegistry` +
// `selectCapabilities`, the same wiring as `selectCapabilityReceiptForPrompt`
// in capability-selection.ts: staged workspace as cwd, the composed --print
// prompt as intent text) and fails LOUDLY when the scenario's declared premise
// does not hold. Selection is deterministic given (manifests, policy, prompt),
// so this static check predicts the hermetic run's first-turn receipt without
// spending the turn. History that motivates it: the capability-request
// scenario silently scored 0% for months of one measurement day because the
// scorer's stopword-free tokenizer matched `use/for/to/the` in
// `selection.when_to_use` against ordinary prompt prose, so the capability
// was ALREADY selected and the rubric failed the model's truthful answer.

/** Catalog cap mirrored from capability-selection.ts SELECTABLE_CAPABILITY_LIMIT. */
const SELECTABLE_CAPABILITY_LIMIT = 8;

interface StagedCapabilityConfig {
  roots: string[];
  policy: {
    agentScope: string[];
    workspaceScope: string[];
    allowedAccounts: string[];
    defaults: Record<string, string>;
  };
}

function premiseError(scenarioId: string, message: string): Error {
  return new Error(`Scenario ${scenarioId}: capability-selection premise violated — ${message}`);
}

function readStringArray(value: unknown, scenarioId: string, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw premiseError(scenarioId, `${field} must be a string array.`);
  }
  return [...new Set(value as string[])].toSorted((left, right) => left.localeCompare(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : fallback;
}

/**
 * Read capability roots/policy from the scenario-carried config, the same file
 * the runtime passes as --config. Roots are required verbatim: guessing the
 * config loader's defaults here would let the premise check and the live run
 * silently diverge. Policy fields read leniently (empty defaults); an
 * over-strict empty scope cannot pass unnoticed because the selectable
 * assertion below fails loudly on a policy-filtered manifest.
 */
function readStagedCapabilityConfig(
  scenarioId: string,
  workspaceDir: string,
): StagedCapabilityConfig {
  const configPath = join(workspaceDir, ".brewva", "brewva.json");
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    throw premiseError(
      scenarioId,
      "the premise requires a scenario-carried .brewva/brewva.json (hermetic capability policy; the runtime passes it as --config).",
    );
  }
  const parsed: unknown = JSON.parse(raw);
  const capabilities =
    isRecord(parsed) && isRecord(parsed.capabilities) ? parsed.capabilities : undefined;
  if (!capabilities) {
    throw premiseError(
      scenarioId,
      "the staged .brewva/brewva.json declares no capabilities block.",
    );
  }
  const roots = readOptionalStringArray(capabilities.roots, []);
  if (roots.length === 0) {
    throw premiseError(
      scenarioId,
      "the staged capabilities block must declare explicit roots (the premise check refuses to guess loader defaults).",
    );
  }
  const policy = isRecord(capabilities.policy) ? capabilities.policy : {};
  const defaults = isRecord(capabilities.defaults)
    ? Object.fromEntries(
        Object.entries(capabilities.defaults).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};
  return {
    roots,
    policy: {
      agentScope: readOptionalStringArray(policy.agentScope, []),
      workspaceScope: readOptionalStringArray(policy.workspaceScope, []),
      allowedAccounts: readOptionalStringArray(policy.allowedAccounts, []),
      defaults,
    },
  };
}

/**
 * Advisory diagnostics only — the verdict comes from the real selector above.
 * Mirrors textTokens/manifestTokens in capability-registry.ts so a violation
 * names the exact tokens to scrub from the manifest or the prompt.
 */
function promptManifestTokenOverlap(prompt: string, manifest: CapabilityManifest): string[] {
  const tokenize = (value: string): Set<string> =>
    new Set(value.toLowerCase().match(/[a-z0-9_-]+/gu) ?? []);
  const manifestTokens = tokenize(
    [
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
      .join(" "),
  );
  return [...tokenize(prompt)]
    .filter((token) => manifestTokens.has(token))
    .toSorted((left, right) => left.localeCompare(right));
}

function describeSelectedCandidates(
  receipt: CapabilitySelectionReceipt,
  manifestsByName: ReadonlyMap<string, CapabilityManifest>,
  prompt: string,
): string {
  return receipt.selected_capabilities
    .map((candidate) => {
      const manifest = manifestsByName.get(candidate.name);
      const overlap = manifest ? promptManifestTokenOverlap(prompt, manifest) : [];
      const overlapNote =
        overlap.length > 0 ? `; prompt∩manifest tokens: ${overlap.join(", ")}` : "";
      return `${candidate.name} (source ${candidate.source}, score ${candidate.score}, "${candidate.reason}"${overlapNote})`;
    })
    .join(" | ");
}

/**
 * Mirrors policyForbiddenNames in capability-selection.ts: only policy filters
 * (scope/account/risk/conflict) forbid; `not_ranked` stays requestable.
 */
function policyForbiddenReasons(receipt: CapabilitySelectionReceipt): Map<string, string> {
  const reasons = new Map<string, string>();
  for (const entry of receipt.filtered_out) {
    if (entry.reason !== "not_ranked") {
      reasons.set(entry.name, entry.reason);
    }
  }
  for (const conflict of receipt.conflicts) {
    for (const name of conflict.candidates) {
      reasons.set(name, `conflict (${conflict.reason})`);
    }
  }
  return reasons;
}

export interface CapabilitySelectionPremiseCheck {
  /** Names the real selector actually selected (sorted, deduplicated). */
  selectedCapabilityNames: string[];
}

/**
 * Enforce the scenario's declared `premise.capability_selection` against the
 * staged workspace and the composed runtime prompt. No premise → no-op
 * (returns undefined). Throwing here surfaces in `EvalResult.error` (and a
 * non-zero eval exit) BEFORE any live turn is spent, so a future scoring
 * change breaks the scenario visibly instead of silently zeroing its pass
 * rate.
 */
export function assertCapabilitySelectionPremise(input: {
  scenario: EvalScenario;
  workspaceDir: string;
  prompt: string;
}): CapabilitySelectionPremiseCheck | undefined {
  const premise: EvalCapabilitySelectionPremise | undefined =
    input.scenario.premise?.capability_selection;
  if (!premise) {
    return undefined;
  }
  const scenarioId = input.scenario.id;
  const expectedSelected = readStringArray(
    premise.selected_capability_names,
    scenarioId,
    "premise.capability_selection.selected_capability_names",
  );
  const expectedSelectable =
    premise.selectable_capability_names === undefined
      ? []
      : readStringArray(
          premise.selectable_capability_names,
          scenarioId,
          "premise.capability_selection.selectable_capability_names",
        );

  const config = readStagedCapabilityConfig(scenarioId, input.workspaceDir);
  const registry = loadCapabilityRegistry({
    roots: config.roots.map((root) => resolve(input.workspaceDir, root)),
  });
  const explicitCapability = extractExplicitCapability(input.prompt);
  const receipt = selectCapabilities({
    manifests: registry.manifests,
    intentText: input.prompt,
    explicitCapability,
    policy: config.policy,
    trigger: explicitCapability ? "explicit_capability" : "user_message",
    registryVersion: registry.registryVersion,
  });
  const manifestsByName = new Map(registry.manifests.map((manifest) => [manifest.name, manifest]));

  const actualSelected = [
    ...new Set(receipt.selected_capabilities.map((candidate) => candidate.name)),
  ].toSorted((left, right) => left.localeCompare(right));
  if (
    actualSelected.length !== expectedSelected.length ||
    actualSelected.some((name, index) => name !== expectedSelected[index])
  ) {
    throw premiseError(
      scenarioId,
      `the real intent scorer selected [${actualSelected.join(", ")}] but the premise declares [${expectedSelected.join(
        ", ",
      )}]. Candidates: ${describeSelectedCandidates(receipt, manifestsByName, input.prompt) || "none"}. ` +
        "Grading this run would score a truthful `already_selected` answer as failure; " +
        "scrub the shared tokens from the staged manifest (identity fields plus selection.when_to_use) or from the scenario prompt.",
    );
  }

  const selectedSet = new Set(actualSelected);
  const forbidden = policyForbiddenReasons(receipt);
  for (const name of expectedSelectable) {
    const manifest = manifestsByName.get(name);
    if (!manifest) {
      throw premiseError(
        scenarioId,
        `selectable capability '${name}' has no manifest under the staged roots [${config.roots.join(", ")}].`,
      );
    }
    if (selectedSet.has(name)) {
      throw premiseError(
        scenarioId,
        `selectable capability '${name}' is SELECTED, so it cannot appear in the selectable catalog.`,
      );
    }
    const forbiddenReason = forbidden.get(name);
    if (forbiddenReason) {
      throw premiseError(
        scenarioId,
        `selectable capability '${name}' is policy-forbidden (${forbiddenReason}) and never renders as selectable; fix the staged policy or manifest scopes.`,
      );
    }
  }
  // The prompt block caps the catalog at 8 entries; membership beyond the cap
  // depends on receipt ordering this check deliberately does not replicate.
  const catalogSize = registry.manifests.filter(
    (manifest) => !selectedSet.has(manifest.name) && !forbidden.has(manifest.name),
  ).length;
  if (expectedSelectable.length > 0 && catalogSize > SELECTABLE_CAPABILITY_LIMIT) {
    throw premiseError(
      scenarioId,
      `${catalogSize} capabilities compete for the ${SELECTABLE_CAPABILITY_LIMIT}-entry selectable catalog; stage fewer manifests so selectable membership stays decidable.`,
    );
  }
  return { selectedCapabilityNames: actualSelected };
}
