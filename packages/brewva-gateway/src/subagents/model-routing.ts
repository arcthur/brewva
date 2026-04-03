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
  score(input: {
    target: HostedDelegationTarget;
    packet: DelegationPacket;
    keywordText: string;
    effectiveSkillName?: string;
  }): number;
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
): Pick<PiModelRegistry, "getAll"> {
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
    candidateModels: ["anthropic/claude-opus-4.1", "openai/gpt-5.4:high"],
    score({ keywordText, effectiveSkillName }) {
      const keywordMatches = countKeywordMatches(keywordText, FRONTEND_KEYWORDS);
      if (keywordMatches === 0) {
        return 0;
      }
      return (
        keywordMatches +
        (effectiveSkillName === "design" || effectiveSkillName === "frontend" ? 2 : 0)
      );
    },
  },
  {
    id: "deep-reasoning",
    reason: "Reasoning-heavy delegation should prefer a frontier reasoning model.",
    candidateModels: ["openai/gpt-5.4:high", "openai/gpt-5.4-mini:high"],
    score({ target, keywordText, effectiveSkillName }) {
      if (effectiveSkillName === "design" || target.resultMode === "plan") {
        return 8;
      }
      if (target.resultMode !== "exploration") {
        return 0;
      }
      const keywordMatches = countKeywordMatches(keywordText, DEEP_REASONING_KEYWORDS);
      return keywordMatches > 0 ? 4 + keywordMatches : 0;
    },
  },
  {
    id: "review-and-verification",
    reason: "Review and QA work should bias toward higher-fidelity reasoning.",
    candidateModels: ["openai/gpt-5.4:medium", "openai/gpt-5.4-mini:medium"],
    score({ target, effectiveSkillName }) {
      return target.resultMode === "review" ||
        target.resultMode === "qa" ||
        effectiveSkillName === "review" ||
        effectiveSkillName === "qa"
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
  const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
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

  const keywordText = normalizeKeywordText(normalizeObjectiveText(input.packet));
  const effectiveSkillName = input.target.skillName ?? input.packet.activeSkillName;
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
            modelRoute: {
              selectedModel,
              requestedModel: candidateModel,
              source: "policy",
              mode: "auto",
              reason: policy.reason,
              policyId: policy.id,
            },
          };
        }
        break;
      } catch {
        // Try the next candidate pattern before falling back to the target defaults.
      }
    }
  }

  return resolvedRoute ?? {};
}
