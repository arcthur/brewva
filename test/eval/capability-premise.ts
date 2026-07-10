import { loadBrewvaConfigResolution } from "@brewva/brewva-runtime/config";
import {
  manifestTokens,
  textTokens,
  type CapabilityManifest,
  type CapabilitySelectionReceipt,
} from "../../packages/brewva-gateway/src/hosted/internal/session/tools/capability-registry.js";
import {
  selectableCapabilities,
  selectCapabilityReceiptForPrompt,
} from "../../packages/brewva-gateway/src/hosted/internal/session/tools/capability-selection.js";
import type { EvalCapabilitySelectionPremise, EvalScenario } from "./types.js";

// Premise gate for generic runtime scenarios that stage capability manifests.
//
// Fidelity is the whole design: the gate runs the REAL production pieces —
// `loadBrewvaConfigResolution` (the same JSONC parse + normalization the
// spawned CLI applies to --config), `selectCapabilityReceiptForPrompt` (the
// exact selection wiring `beforeAgentStart` runs on the turn prompt), and
// `selectableCapabilities` (the exact catalog projection the prompt block
// renders) — against the staged workspace and the composed --print prompt.
// Selection is deterministic given (config, manifests, prompt), so this
// static check predicts the hermetic run's first-turn receipt without
// spending the turn. History that motivates it: the capability-request
// scenario silently scored 0% because the scorer's stopword-free tokenizer
// matched `use/for/to/the` in `selection.when_to_use` against ordinary
// prompt prose, so the capability was ALREADY selected and the rubric failed
// the model's truthful answer.

/**
 * The exact workspace_files key that makes the generic runtime pass --config
 * to the spawned CLI. The premise gate keys off the SAME literal so it can
 * never validate a config the live run does not load.
 */
export const SCENARIO_CARRIED_CONFIG_KEY = ".brewva/brewva.json";

export interface CapabilitySelectionPremiseCheck {
  /** Names the real selector actually selected (sorted, deduplicated). */
  selectedCapabilityNames: string[];
  /** The exact selectable catalog the prompt block would render, in order. */
  selectableCapabilityNames: string[];
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

/**
 * Advisory diagnostics only — the verdict comes from the real selector.
 * Uses the production tokenizer so the error names the exact tokens to scrub
 * from the manifest or the prompt.
 */
function promptManifestTokenOverlap(prompt: string, manifest: CapabilityManifest): string[] {
  const tokens = manifestTokens(manifest);
  return [...textTokens(prompt)]
    .filter((token) => tokens.has(token))
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

/** Advisory diagnostics: echo why the receipt keeps a name out of the catalog. */
function describeCatalogExclusion(
  name: string,
  receipt: CapabilitySelectionReceipt,
  selectedNames: ReadonlySet<string>,
): string {
  if (selectedNames.has(name)) {
    return "it is SELECTED this turn";
  }
  const filtered = receipt.filtered_out.find((entry) => entry.name === name);
  if (filtered) {
    return `the receipt filtered it out (reason: ${filtered.reason})`;
  }
  const conflict = receipt.conflicts.find((entry) => entry.candidates.includes(name));
  if (conflict) {
    return `it sits in a conflict group (${conflict.reason})`;
  }
  return "it fell outside the rendered catalog (entry cap or missing manifest)";
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

  if (!Object.hasOwn(input.scenario.context.workspace_files ?? {}, SCENARIO_CARRIED_CONFIG_KEY)) {
    throw premiseError(
      scenarioId,
      `the premise requires a scenario-carried config under the exact workspace_files key "${SCENARIO_CARRIED_CONFIG_KEY}" — that literal key is what makes the runtime pass --config, so any other spelling would validate a config the live run never loads.`,
    );
  }
  const resolution = loadBrewvaConfigResolution({
    cwd: input.workspaceDir,
    configPath: SCENARIO_CARRIED_CONFIG_KEY,
  });
  const { registry, receipt } = selectCapabilityReceiptForPrompt({
    runtime: {
      identity: { cwd: input.workspaceDir, workspaceRoot: input.workspaceDir },
      config: { capabilities: resolution.config.capabilities },
    },
    prompt: input.prompt,
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
  const catalogNames = selectableCapabilities({
    receipt,
    manifests: registry.manifests,
  }).map((entry) => entry.name);
  for (const name of expectedSelectable) {
    if (!catalogNames.includes(name)) {
      throw premiseError(
        scenarioId,
        `capability '${name}' does not render in the selectable catalog [${catalogNames.join(", ")}] because ${describeCatalogExclusion(
          name,
          receipt,
          selectedSet,
        )}; fix the staged policy, manifest, or catalog pressure.`,
      );
    }
  }
  return { selectedCapabilityNames: actualSelected, selectableCapabilityNames: catalogNames };
}
