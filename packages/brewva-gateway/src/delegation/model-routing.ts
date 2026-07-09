import { resolveBrewvaAgentDir } from "@brewva/brewva-runtime/config";
import type { BrewvaModelCatalog } from "@brewva/brewva-substrate/provider";
import type { BrewvaModelPreset, BrewvaModelRoleAlias } from "@brewva/brewva-substrate/session";
import type { DelegationPacket, SubagentExecutionShape } from "@brewva/brewva-tools/contracts";
import type { DelegationModelRouteRecord } from "@brewva/brewva-vocabulary/delegation";
import { createHostedModelCatalog, resolvePresetRoleModel } from "../hosted/api.js";
import { resolveBrewvaModelSelection } from "../policy/model-routing/api.js";
import type { HostedDelegationTarget } from "./targets.js";

type RegisteredModel = ReturnType<BrewvaModelCatalog["getAll"]>[number];

export interface DelegationModelRoutingContext {
  availableModels: RegisteredModel[];
  activePreset?: BrewvaModelPreset;
  getActivePreset?: () => BrewvaModelPreset | undefined;
}

export interface ResolvedDelegationModelRoute {
  model?: string;
  modelRole?: BrewvaModelRoleAlias;
  modelRoute?: DelegationModelRouteRecord;
}

function resolveDelegationRoleAlias(input: {
  target: HostedDelegationTarget;
  effectiveSkillName?: string;
}): BrewvaModelRoleAlias | undefined {
  switch (input.target.modelCategory) {
    case "fast-evidence":
      return "smol";
    case "isolated-execution":
      return "task";
    case "deep-reasoning":
      return input.effectiveSkillName === "plan" ||
        input.effectiveSkillName === "office-hours" ||
        input.target.consultKind === "design" ||
        input.target.consultKind === "diagnose"
        ? "plan"
        : "slow";
    case "verification":
    case "knowledge":
      return undefined;
    default:
      return undefined;
  }
}

function isBrewvaModelRoleAlias(value: string): value is BrewvaModelRoleAlias {
  return (
    value === "default" ||
    value === "smol" ||
    value === "slow" ||
    value === "plan" ||
    value === "commit" ||
    value === "task"
  );
}

function readRouteRole(
  route: DelegationModelRouteRecord | undefined,
): BrewvaModelRoleAlias | undefined {
  const role = route?.role;
  return typeof role === "string" && isBrewvaModelRoleAlias(role) ? role : undefined;
}

function presetMissRoute(input: {
  activePresetName: string | undefined;
  category: string;
  role: BrewvaModelRoleAlias | undefined;
  reason: string | undefined;
}): ResolvedDelegationModelRoute {
  return {
    ...(input.role ? { modelRole: input.role } : {}),
    ...(input.reason
      ? {
          modelRoute: {
            category: input.category,
            ...(input.role ? { role: input.role } : {}),
            source: "preset",
            mode: "auto",
            presetName: input.activePresetName,
            reason: input.reason,
          },
        }
      : {}),
  };
}

function formatSelectedModel(input: {
  provider: string;
  id: string;
  thinkingLevel?: string;
}): string {
  const base = `${input.provider}/${input.id}`;
  return input.thinkingLevel ? `${base}:${input.thinkingLevel}` : base;
}

function createRegistryAdapter(
  availableModels: RegisteredModel[],
): Pick<BrewvaModelCatalog, "getAll"> {
  return {
    getAll() {
      return availableModels;
    },
  };
}

function resolveModelTextAgainstInventory(
  modelText: string,
  context: DelegationModelRoutingContext | undefined,
): string {
  if (!context || context.availableModels.length === 0) {
    return modelText;
  }
  const selection = resolveBrewvaModelSelection(
    modelText,
    createRegistryAdapter(context.availableModels),
  );
  if (!selection.model) {
    throw new Error(`Model "${modelText}" was not found in the configured Brewva model registry.`);
  }
  return formatSelectedModel({
    provider: selection.model.provider,
    id: selection.model.id,
    thinkingLevel: selection.thinkingLevel,
  });
}

export function createDelegationModelRoutingContext(
  registry: Pick<BrewvaModelCatalog, "getAll">,
  options: {
    getActivePreset?: () => BrewvaModelPreset | undefined;
  } = {},
): DelegationModelRoutingContext {
  return {
    availableModels: registry.getAll(),
    getActivePreset: options.getActivePreset,
  };
}

export function createDelegationModelRoutingContextFromAgentDir(
  agentDir = resolveBrewvaAgentDir(),
): DelegationModelRoutingContext {
  return createDelegationModelRoutingContext(createHostedModelCatalog(agentDir));
}

export function resolveDelegationModelRoute(input: {
  target: HostedDelegationTarget;
  packet: DelegationPacket;
  executionShape?: SubagentExecutionShape;
  modelRouting?: DelegationModelRoutingContext;
  preselectedModelRoute?: DelegationModelRouteRecord;
}): ResolvedDelegationModelRoute {
  if (input.preselectedModelRoute) {
    return {
      model: input.preselectedModelRoute.selectedModel,
      modelRole: readRouteRole(input.preselectedModelRoute),
      modelRoute: input.preselectedModelRoute,
    };
  }

  const activePreset = input.modelRouting?.getActivePreset?.() ?? input.modelRouting?.activePreset;
  const category = input.target.modelCategory;
  const effectiveSkillName = input.target.skillName;
  const role = resolveDelegationRoleAlias({ target: input.target, effectiveSkillName });
  const presetModel = role ? resolvePresetRoleModel(activePreset, role) : undefined;
  const presetMissReason =
    activePreset && !presetModel
      ? role
        ? `Preset "${activePreset.name}" has no configured model for role "${role}" mapped from delegation category "${category}".`
        : `Preset "${activePreset.name}" has no public role mapping for delegation category "${category}".`
      : undefined;
  if (activePreset && role && presetModel) {
    const selectedModel = resolveModelTextAgainstInventory(presetModel, input.modelRouting);
    return {
      model: selectedModel,
      modelRole: role,
      modelRoute: {
        selectedModel,
        category,
        role,
        source: "preset",
        mode: "explicit",
        reason: `Model selected by preset "${activePreset.name}" for role "${role}" mapped from delegation category "${category}".`,
        presetName: activePreset.name,
      },
    };
  }

  if (!input.modelRouting || input.modelRouting.availableModels.length === 0) {
    return presetMissRoute({
      activePresetName: activePreset?.name,
      category,
      role,
      reason: presetMissReason,
    });
  }

  // Advisory model hint: when the packet carries one that resolves against the
  // configured registry, the gateway honors it. The decision stays gateway-
  // owned — an unresolvable hint is ignored and routing falls through to the
  // category→role→target default rather than failing the run. A preset-explicit
  // mapping (handled above) still outranks the hint.
  const modelHint = input.packet.modelHint?.trim();
  if (modelHint) {
    try {
      const selectedModel = resolveModelTextAgainstInventory(modelHint, input.modelRouting);
      return {
        model: selectedModel,
        modelRole: role,
        modelRoute: {
          selectedModel,
          category,
          ...(role ? { role } : {}),
          source: "hint",
          mode: "explicit",
          reason: `Model selected from the advisory request hint "${modelHint}".`,
          ...(presetMissReason ? { presetMissReason } : {}),
        },
      };
    } catch {
      // Unresolvable hint: ignore it and fall through to the target default.
    }
  }

  // No preset-explicit mapping and no resolvable hint: the delegation category's
  // role maps to the target's own default model. Model choice is negotiated
  // through presets and the advisory hint, never guessed from objective keywords.
  return presetMissRoute({
    activePresetName: activePreset?.name,
    category,
    role,
    reason: presetMissReason,
  });
}
