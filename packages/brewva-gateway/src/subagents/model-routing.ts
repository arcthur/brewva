import { join } from "node:path";
import type { DelegationModelRouteRecord } from "@brewva/brewva-runtime";
import { resolveBrewvaAgentDir } from "@brewva/brewva-runtime";
import type { DelegationPacket, SubagentExecutionShape } from "@brewva/brewva-tools";
import { resolveBrewvaModelSelection } from "@brewva/brewva-tools";
import {
  AuthStorage,
  ModelRegistry,
  type ModelRegistry as PiModelRegistry,
} from "@mariozechner/pi-coding-agent";
import type { HostedDelegationTarget } from "./targets.js";

type RegisteredModel = ReturnType<PiModelRegistry["getAll"]>[number];

interface DelegationRoutingPolicy {
  id: string;
  reason: string;
  candidateModels: readonly string[];
  matches(input: {
    target: HostedDelegationTarget;
    packet: DelegationPacket;
    objectiveText: string;
    effectiveSkillName?: string;
  }): boolean;
}

export interface DelegationModelRoutingContext {
  availableModels: RegisteredModel[];
}

export interface ResolvedDelegationModelRoute {
  model?: string;
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

function hasAnyKeyword(haystack: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => haystack.includes(keyword));
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
): Pick<PiModelRegistry, "getAll"> & PiModelRegistry {
  return {
    getAll() {
      return availableModels;
    },
  } as Pick<PiModelRegistry, "getAll"> & PiModelRegistry;
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
    candidateModels: [
      "anthropic/claude-opus-4.1",
      "claude-opus-4.1",
      "opus",
      "openai/gpt-5.4:high",
      "gpt-5.4:high",
    ],
    matches({ objectiveText }) {
      return hasAnyKeyword(objectiveText, FRONTEND_KEYWORDS);
    },
  },
  {
    id: "deep-reasoning",
    reason: "Reasoning-heavy delegation should prefer a frontier reasoning model.",
    candidateModels: [
      "openai/gpt-5.4:high",
      "gpt-5.4:high",
      "openai/gpt-5.4-mini:high",
      "gpt-5.4-mini:high",
    ],
    matches({ target, objectiveText, effectiveSkillName }) {
      return (
        effectiveSkillName === "design" ||
        (target.resultMode === "exploration" &&
          hasAnyKeyword(objectiveText, DEEP_REASONING_KEYWORDS))
      );
    },
  },
  {
    id: "review-and-verification",
    reason: "Review and verification work should bias toward higher-fidelity reasoning.",
    candidateModels: [
      "openai/gpt-5.4:medium",
      "gpt-5.4:medium",
      "openai/gpt-5.4-mini:medium",
      "gpt-5.4-mini:medium",
    ],
    matches({ target, effectiveSkillName }) {
      return (
        target.resultMode === "review" ||
        target.resultMode === "verification" ||
        effectiveSkillName === "review" ||
        effectiveSkillName === "qa"
      );
    },
  },
  {
    id: "fast-patch-loop",
    reason: "Execution-first patch work should prefer a fast coding-oriented model.",
    candidateModels: [
      "openai/gpt-5.3-codex-spark:high",
      "gpt-5.3-codex-spark:high",
      "openai/gpt-5.3-codex:medium",
      "gpt-5.3-codex:medium",
      "openai/gpt-5.4-mini:medium",
      "gpt-5.4-mini:medium",
    ],
    matches({ target, objectiveText, effectiveSkillName }) {
      return (
        target.resultMode === "patch" ||
        effectiveSkillName === "implementation" ||
        effectiveSkillName === "ship" ||
        hasAnyKeyword(objectiveText, EXECUTION_KEYWORDS)
      );
    },
  },
] as const;

export function createDelegationModelRoutingContext(
  registry: Pick<PiModelRegistry, "getAll">,
): DelegationModelRoutingContext {
  return {
    availableModels: registry.getAll(),
  };
}

export function createDelegationModelRoutingContextFromAgentDir(
  agentDir = resolveBrewvaAgentDir(),
): DelegationModelRoutingContext {
  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
  return createDelegationModelRoutingContext(modelRegistry);
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
      modelRoute: input.preselectedModelRoute,
    };
  }

  const explicitModel = input.executionShape?.model?.trim();
  if (explicitModel) {
    const selectedModel = resolveModelTextAgainstInventory(explicitModel, input.modelRouting);
    return {
      model: selectedModel,
      modelRoute: {
        selectedModel,
        requestedModel: explicitModel,
        source: "execution_shape",
        mode: "explicit",
        reason: "Explicit executionShape model override.",
      },
    };
  }

  const targetModel = input.target.model?.trim();
  if (targetModel) {
    const selectedModel = resolveModelTextAgainstInventory(targetModel, input.modelRouting);
    return {
      model: selectedModel,
      modelRoute: {
        selectedModel,
        requestedModel: targetModel,
        source: "target",
        mode: "explicit",
        reason: "Model pinned by the delegated target envelope.",
      },
    };
  }

  if (!input.modelRouting || input.modelRouting.availableModels.length === 0) {
    return {};
  }

  const objectiveText = normalizeObjectiveText(input.packet);
  const effectiveSkillName = input.target.skillName ?? input.packet.activeSkillName;
  for (const policy of ROUTING_POLICIES) {
    if (
      !policy.matches({
        target: input.target,
        packet: input.packet,
        objectiveText,
        effectiveSkillName,
      })
    ) {
      continue;
    }
    for (const candidateModel of policy.candidateModels) {
      try {
        const selectedModel = resolveModelTextAgainstInventory(candidateModel, input.modelRouting);
        return {
          model: selectedModel,
          modelRoute: {
            selectedModel,
            requestedModel: candidateModel,
            source: "policy",
            mode: "auto",
            reason: policy.reason,
            policyId: policy.id,
          },
        };
      } catch {
        // Try the next candidate pattern before falling back to the target defaults.
      }
    }
  }

  return {};
}
