import { resolveBrewvaAgentDir } from "@brewva/brewva-runtime/config";
import type { BrewvaModelCatalog } from "@brewva/brewva-substrate/provider";
import type { BrewvaModelPreset, BrewvaModelRoleAlias } from "@brewva/brewva-substrate/session";
import type { DelegationPacket, SubagentExecutionShape } from "@brewva/brewva-tools/contracts";
import type { DelegationModelRouteRecord } from "@brewva/brewva-vocabulary/delegation";
import { createHostedModelCatalog, resolvePresetRoleModel } from "../hosted/api.js";
import { resolveBrewvaModelSelection } from "../policy/model-routing/api.js";
import type { HostedDelegationTarget } from "./targets.js";

type RegisteredModel = ReturnType<BrewvaModelCatalog["getAll"]>[number];

interface DelegationRoutingPolicy {
  id: string;
  reason: string;
  candidateModels: readonly string[];
  score(input: {
    target: HostedDelegationTarget;
    packet: DelegationPacket;
    keywordText: string;
    effectiveSkillName?: string;
  }): number;
}

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

const FRONTEND_KEYWORDS = [
  "frontend",
  "ui",
  "ux",
  "design system",
  "css",
  "tailwind",
  "react",
  "component",
  "layout",
  "animation",
  "typography",
] as const;

const DEEP_REASONING_KEYWORDS = [
  "architecture",
  "design",
  "office hours",
  "startup",
  "demand",
  "wedge",
  "premise",
  "strategy",
  "tradeoff",
  "root cause",
  "migration",
  "rfc",
  "reasoning",
] as const;

const EXECUTION_KEYWORDS = [
  "fix",
  "patch",
  "edit",
  "implement",
  "refactor",
  "ci",
  "test failure",
  "lint",
  "compile",
  "ship",
] as const;

function normalizeKeywordText(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return normalized.length > 0 ? ` ${normalized} ` : " ";
}

function countKeywordMatches(haystack: string, keywords: readonly string[]): number {
  let matches = 0;
  for (const keyword of keywords) {
    if (haystack.includes(normalizeKeywordText(keyword))) {
      matches += 1;
    }
  }
  return matches;
}

function normalizeObjectiveText(packet: DelegationPacket): string {
  return [
    packet.objective,
    packet.deliverable,
    ...(packet.constraints ?? []),
    ...(packet.sharedNotes ?? []),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
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

const ROUTING_POLICIES: readonly DelegationRoutingPolicy[] = [
  {
    id: "frontend-design",
    reason: "Frontend-heavy delegation benefits from a design-strong route when available.",
    candidateModels: ["anthropic/claude-opus-4.1", "openai/gpt-5.5:high"],
    score({ keywordText, effectiveSkillName }) {
      const keywordMatches = countKeywordMatches(keywordText, FRONTEND_KEYWORDS);
      if (keywordMatches === 0) {
        return 0;
      }
      return (
        keywordMatches +
        (effectiveSkillName === "plan" || effectiveSkillName === "frontend" ? 2 : 0)
      );
    },
  },
  {
    id: "deep-reasoning",
    reason: "Reasoning-heavy delegation should prefer a frontier reasoning model.",
    candidateModels: ["openai/gpt-5.5:high", "openai/gpt-5.4-mini:high"],
    score({ target, keywordText, effectiveSkillName }) {
      if (
        effectiveSkillName === "plan" ||
        effectiveSkillName === "office-hours" ||
        target.consultKind === "design" ||
        target.consultKind === "diagnose"
      ) {
        return 8;
      }
      if (target.resultMode !== "consult") {
        return 0;
      }
      const keywordMatches = countKeywordMatches(keywordText, DEEP_REASONING_KEYWORDS);
      return keywordMatches > 0 ? 4 + keywordMatches : 0;
    },
  },
  {
    id: "review-and-verification",
    reason: "Review and Verifier work should bias toward higher-fidelity reasoning.",
    candidateModels: ["openai/gpt-5.5:medium", "openai/gpt-5.4-mini:medium"],
    score({ target, effectiveSkillName }) {
      return target.consultKind === "review" ||
        target.resultMode === "verifier" ||
        effectiveSkillName === "review" ||
        effectiveSkillName === "verifier"
        ? 8
        : 0;
    },
  },
  {
    id: "fast-patch-loop",
    reason: "Execution-first patch work should prefer a fast coding-oriented model.",
    candidateModels: [
      "openai/gpt-5.3-codex-spark:high",
      "openai/gpt-5.3-codex:medium",
      "openai/gpt-5.4-mini:medium",
    ],
    score({ target, keywordText, effectiveSkillName }) {
      const keywordMatches = countKeywordMatches(keywordText, EXECUTION_KEYWORDS);
      let score = 0;
      if (target.resultMode === "patch") {
        score += 3;
      }
      if (effectiveSkillName === "implementation" || effectiveSkillName === "ship") {
        score += 2;
      }
      score += keywordMatches * 4;
      return score;
    },
  },
] as const;

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
  // keyword policies below rather than failing the run. A preset-explicit
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
      // Unresolvable hint: ignore it and let keyword policies decide.
    }
  }

  const keywordText = normalizeKeywordText(normalizeObjectiveText(input.packet));
  let resolvedRoute: ResolvedDelegationModelRoute | undefined;
  let resolvedScore = 0;

  // Choose the highest-signal policy instead of relying on fragile array order.
  // Execution cues intentionally outrank surface-domain keywords when both are present.
  for (const policy of ROUTING_POLICIES) {
    const score = policy.score({
      target: input.target,
      packet: input.packet,
      keywordText,
      effectiveSkillName,
    });
    if (score <= 0) {
      continue;
    }
    for (const candidateModel of policy.candidateModels) {
      try {
        const selectedModel = resolveModelTextAgainstInventory(candidateModel, input.modelRouting);
        if (score > resolvedScore) {
          resolvedScore = score;
          resolvedRoute = {
            model: selectedModel,
            modelRole: role,
            modelRoute: {
              selectedModel,
              category,
              ...(role ? { role } : {}),
              source: "policy",
              mode: "auto",
              reason: policy.reason,
              policyId: policy.id,
              ...(presetMissReason ? { presetMissReason } : {}),
            },
          };
        }
        break;
      } catch {
        // Try the next candidate pattern before falling back to the target defaults.
      }
    }
  }

  return (
    resolvedRoute ??
    presetMissRoute({
      activePresetName: activePreset?.name,
      category,
      role,
      reason: presetMissReason,
    })
  );
}
