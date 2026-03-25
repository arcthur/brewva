import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ManagedToolMode } from "@brewva/brewva-runtime";
import type {
  DelegationPacket,
  SubagentContextBudget,
  SubagentExecutionBoundary,
  SubagentResultMode,
} from "@brewva/brewva-tools";
import { getCanonicalSubagentPrompt } from "./protocol.js";

export type HostedSubagentBuiltinToolName = "read" | "edit" | "write";

export interface HostedSubagentProfile {
  name: string;
  description: string;
  resultMode: SubagentResultMode;
  prompt?: string;
  boundary?: SubagentExecutionBoundary;
  model?: string;
  entrySkill?: string;
  builtinToolNames?: HostedSubagentBuiltinToolName[];
  managedToolNames?: string[];
  defaultContextBudget?: SubagentContextBudget;
  managedToolMode?: ManagedToolMode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value
    .map((item) => asString(item))
    .filter((item): item is string => item !== undefined);
  return entries.length > 0 ? entries : undefined;
}

function asBuiltinToolArray(value: unknown): HostedSubagentBuiltinToolName[] | undefined {
  const entries = asStringArray(value);
  if (!entries) {
    return undefined;
  }
  const normalized = entries.filter(
    (entry): entry is HostedSubagentBuiltinToolName =>
      entry === "read" || entry === "edit" || entry === "write",
  );
  return normalized.length > 0 ? normalized : undefined;
}

function asBoundary(value: unknown): SubagentExecutionBoundary | undefined {
  return value === "safe" || value === "effectful" ? value : undefined;
}

function asManagedToolMode(value: unknown): ManagedToolMode | undefined {
  return value === "extension" || value === "direct" ? value : undefined;
}

function asResultMode(value: unknown): SubagentResultMode | undefined {
  return value === "exploration" ||
    value === "review" ||
    value === "verification" ||
    value === "patch"
    ? value
    : undefined;
}

function asContextBudget(value: unknown): SubagentContextBudget | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const maxInjectionTokens =
    typeof value.maxInjectionTokens === "number" && Number.isFinite(value.maxInjectionTokens)
      ? Math.max(1, Math.trunc(value.maxInjectionTokens))
      : undefined;
  const maxTurnTokens =
    typeof value.maxTurnTokens === "number" && Number.isFinite(value.maxTurnTokens)
      ? Math.max(1, Math.trunc(value.maxTurnTokens))
      : undefined;
  if (!maxInjectionTokens && !maxTurnTokens) {
    return undefined;
  }
  return {
    maxInjectionTokens,
    maxTurnTokens,
  };
}

const REMOVED_LEGACY_SUBAGENT_PROFILES = {
  researcher: "explore",
  reviewer: "review",
  verifier: "review",
} as const satisfies Record<string, string>;

function getRemovedLegacySubagentProfileReplacement(name: string): string | undefined {
  return Object.hasOwn(REMOVED_LEGACY_SUBAGENT_PROFILES, name)
    ? REMOVED_LEGACY_SUBAGENT_PROFILES[name as keyof typeof REMOVED_LEGACY_SUBAGENT_PROFILES]
    : undefined;
}

const BOUNDARY_RANK: Record<SubagentExecutionBoundary, number> = {
  safe: 0,
  effectful: 1,
};

function assertSubset(
  profileName: string,
  fieldName: string,
  base: readonly string[] | undefined,
  candidate: readonly string[] | undefined,
): void {
  if (!base || !candidate) {
    return;
  }
  const allowed = new Set(base);
  const widened = candidate.filter((entry) => !allowed.has(entry));
  if (widened.length > 0) {
    throw new Error(
      `invalid_subagent_profile:${profileName}:${fieldName} widens the base profile with ${widened.join(", ")}`,
    );
  }
}

function assertBudgetTightening(
  profileName: string,
  fieldName: keyof NonNullable<HostedSubagentProfile["defaultContextBudget"]>,
  baseValue: number | undefined,
  candidateValue: number | undefined,
): void {
  if (baseValue === undefined || candidateValue === undefined) {
    return;
  }
  if (candidateValue > baseValue) {
    throw new Error(
      `invalid_subagent_profile:${profileName}:defaultContextBudget.${fieldName} widens the base budget`,
    );
  }
}

function assertOverlayTightening(
  base: HostedSubagentProfile,
  candidate: HostedSubagentProfile,
): void {
  if (candidate.resultMode !== base.resultMode) {
    throw new Error(
      `invalid_subagent_profile:${candidate.name}:resultMode cannot replace the base profile mode`,
    );
  }
  const baseBoundary = base.boundary ?? "safe";
  const candidateBoundary = candidate.boundary ?? baseBoundary;
  if (BOUNDARY_RANK[candidateBoundary] > BOUNDARY_RANK[baseBoundary]) {
    throw new Error(
      `invalid_subagent_profile:${candidate.name}:boundary cannot widen beyond the base profile`,
    );
  }
  assertSubset(
    candidate.name,
    "builtinToolNames",
    base.builtinToolNames,
    candidate.builtinToolNames,
  );
  assertSubset(
    candidate.name,
    "managedToolNames",
    base.managedToolNames,
    candidate.managedToolNames,
  );
  assertBudgetTightening(
    candidate.name,
    "maxInjectionTokens",
    base.defaultContextBudget?.maxInjectionTokens,
    candidate.defaultContextBudget?.maxInjectionTokens,
  );
  assertBudgetTightening(
    candidate.name,
    "maxTurnTokens",
    base.defaultContextBudget?.maxTurnTokens,
    candidate.defaultContextBudget?.maxTurnTokens,
  );
  if (base.managedToolMode === "direct" && candidate.managedToolMode === "extension") {
    throw new Error(
      `invalid_subagent_profile:${candidate.name}:managedToolMode cannot widen beyond direct`,
    );
  }
}

function toProfile(
  source: Record<string, unknown>,
  defaults?: HostedSubagentProfile,
): HostedSubagentProfile | undefined {
  if (Object.hasOwn(source, "posture")) {
    throw new Error("posture has been removed; use boundary with safe or effectful");
  }
  const name = asString(source.name) ?? defaults?.name;
  const description = asString(source.description) ?? defaults?.description;
  const resultMode = asResultMode(source.resultMode) ?? defaults?.resultMode;
  const prompt =
    asString(source.prompt) ??
    defaults?.prompt ??
    (resultMode ? getCanonicalSubagentPrompt(resultMode) : undefined);
  if (!name || !description || !resultMode) {
    return undefined;
  }

  return {
    name,
    description,
    resultMode,
    prompt,
    boundary: asBoundary(source.boundary) ?? defaults?.boundary ?? "safe",
    model: asString(source.model) ?? defaults?.model,
    entrySkill: asString(source.entrySkill) ?? defaults?.entrySkill,
    builtinToolNames: asBuiltinToolArray(source.builtinToolNames) ?? defaults?.builtinToolNames,
    managedToolNames: asStringArray(source.managedToolNames) ?? defaults?.managedToolNames,
    defaultContextBudget:
      asContextBudget(source.defaultContextBudget) ?? defaults?.defaultContextBudget,
    managedToolMode: asManagedToolMode(source.managedToolMode) ?? defaults?.managedToolMode,
  };
}

export const BUILTIN_SUBAGENT_PROFILES: Readonly<Record<string, HostedSubagentProfile>> = {
  explore: {
    name: "explore",
    description:
      "Canonical read-only exploration profile for cross-file investigation and impact discovery.",
    resultMode: "exploration",
    prompt: getCanonicalSubagentPrompt("exploration"),
    boundary: "safe",
    builtinToolNames: ["read"],
    managedToolNames: [
      "grep",
      "read_spans",
      "look_at",
      "toc_search",
      "toc_document",
      "ast_grep_search",
      "lsp_diagnostics",
      "lsp_find_references",
      "lsp_goto_definition",
      "lsp_symbols",
      "output_search",
      "ledger_query",
      "tape_search",
      "task_view_state",
      "workflow_status",
    ],
    defaultContextBudget: {
      maxInjectionTokens: 1800,
      maxTurnTokens: 6000,
    },
    managedToolMode: "direct",
  },
  plan: {
    name: "plan",
    description:
      "Canonical read-only planning profile for shaping execution slices, risks, and verification intent.",
    resultMode: "exploration",
    prompt:
      "Turn the delegated objective into a concise execution plan. Identify the critical path, likely risks, verification checkpoints, and delegation opportunities without editing code.",
    boundary: "safe",
    builtinToolNames: ["read"],
    managedToolNames: [
      "grep",
      "read_spans",
      "look_at",
      "toc_search",
      "toc_document",
      "ast_grep_search",
      "lsp_diagnostics",
      "lsp_find_references",
      "lsp_goto_definition",
      "lsp_symbols",
      "output_search",
      "ledger_query",
      "tape_search",
      "task_view_state",
      "workflow_status",
    ],
    defaultContextBudget: {
      maxInjectionTokens: 1800,
      maxTurnTokens: 6500,
    },
    managedToolMode: "direct",
  },
  review: {
    name: "review",
    description: "Canonical read-only review profile for correctness, regressions, and test risk.",
    resultMode: "review",
    prompt: getCanonicalSubagentPrompt("review"),
    boundary: "safe",
    builtinToolNames: ["read"],
    managedToolNames: [
      "grep",
      "read_spans",
      "look_at",
      "toc_search",
      "toc_document",
      "ast_grep_search",
      "lsp_diagnostics",
      "lsp_find_references",
      "lsp_goto_definition",
      "lsp_symbols",
      "ledger_query",
      "output_search",
      "tape_search",
      "task_view_state",
      "workflow_status",
    ],
    defaultContextBudget: {
      maxInjectionTokens: 2000,
      maxTurnTokens: 7000,
    },
    managedToolMode: "direct",
  },
  general: {
    name: "general",
    description:
      "Canonical general-purpose delegated profile for bounded read-only work when no sharper posture fits.",
    resultMode: "exploration",
    prompt:
      "Handle the delegated objective with a bounded, read-only assistant posture. Gather only the context you need, state assumptions explicitly, and keep the result concise and merge-friendly.",
    boundary: "safe",
    builtinToolNames: ["read"],
    managedToolNames: [
      "grep",
      "read_spans",
      "look_at",
      "toc_search",
      "toc_document",
      "ast_grep_search",
      "lsp_diagnostics",
      "lsp_find_references",
      "lsp_goto_definition",
      "lsp_symbols",
      "output_search",
      "ledger_query",
      "tape_search",
      "task_view_state",
      "workflow_status",
    ],
    defaultContextBudget: {
      maxInjectionTokens: 1600,
      maxTurnTokens: 5500,
    },
    managedToolMode: "direct",
  },
  verification: {
    name: "verification",
    description:
      "Canonical read-only verification profile for checks, evidence, and confidence gaps.",
    resultMode: "verification",
    prompt: getCanonicalSubagentPrompt("verification"),
    boundary: "safe",
    builtinToolNames: ["read"],
    managedToolNames: [
      "grep",
      "read_spans",
      "look_at",
      "toc_search",
      "toc_document",
      "ast_grep_search",
      "lsp_diagnostics",
      "lsp_find_references",
      "lsp_goto_definition",
      "lsp_symbols",
      "ledger_query",
      "output_search",
      "tape_search",
      "task_view_state",
      "workflow_status",
    ],
    defaultContextBudget: {
      maxInjectionTokens: 2000,
      maxTurnTokens: 7000,
    },
    managedToolMode: "direct",
  },
  "patch-worker": {
    name: "patch-worker",
    description:
      "Isolated patch worker that can read and edit files inside a snapshot-backed workspace.",
    resultMode: "patch",
    prompt: getCanonicalSubagentPrompt("patch"),
    boundary: "effectful",
    builtinToolNames: ["read", "edit", "write"],
    managedToolNames: [
      "grep",
      "read_spans",
      "look_at",
      "toc_search",
      "toc_document",
      "ast_grep_search",
      "lsp_diagnostics",
      "lsp_find_references",
      "lsp_goto_definition",
      "lsp_symbols",
      "ledger_query",
      "output_search",
      "tape_search",
      "task_view_state",
    ],
    defaultContextBudget: {
      maxInjectionTokens: 2000,
      maxTurnTokens: 8000,
    },
    managedToolMode: "direct",
  },
} as const;

export async function loadHostedSubagentProfiles(
  workspaceRoot: string,
): Promise<Map<string, HostedSubagentProfile>> {
  const profiles = new Map<string, HostedSubagentProfile>(
    Object.values(BUILTIN_SUBAGENT_PROFILES).map((profile) => [profile.name, profile] as const),
  );
  const root = resolve(workspaceRoot, ".brewva", "subagents");
  if (!existsSync(root)) {
    return profiles;
  }

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const filePath = resolve(root, entry.name);
    const raw = await readFile(filePath, "utf8");
    if (!raw.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `invalid_subagent_profile:${entry.name}:${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!isRecord(parsed)) {
      throw new Error(`invalid_subagent_profile:${entry.name}:root must be an object`);
    }
    const explicitBaseName = asString(parsed.extends);
    if (explicitBaseName) {
      const replacement = getRemovedLegacySubagentProfileReplacement(explicitBaseName);
      if (replacement) {
        throw new Error(
          `invalid_subagent_profile:${entry.name}:legacy profile '${explicitBaseName}' has been removed; use '${replacement}' instead`,
        );
      }
    }
    const sameNameBase = asString(parsed.name) ? profiles.get(asString(parsed.name)!) : undefined;
    const defaultProfile = explicitBaseName ? profiles.get(explicitBaseName) : sameNameBase;
    const profile = toProfile(parsed, defaultProfile);
    if (!profile) {
      throw new Error(`invalid_subagent_profile:${entry.name}:missing required fields`);
    }
    const replacement = getRemovedLegacySubagentProfileReplacement(profile.name);
    if (replacement) {
      throw new Error(
        `invalid_subagent_profile:${entry.name}:legacy profile '${profile.name}' has been removed; use '${replacement}' instead`,
      );
    }
    const overlayBase = profiles.get(profile.name);
    if (overlayBase) {
      assertOverlayTightening(overlayBase, profile);
    }
    profiles.set(profile.name, profile);
  }

  return profiles;
}

export function mergeDelegationPacketWithProfileDefaults(
  profile: HostedSubagentProfile,
  packet: DelegationPacket | undefined,
): DelegationPacket | undefined {
  if (!packet) {
    return undefined;
  }
  return {
    ...packet,
    entrySkill: packet.entrySkill ?? profile.entrySkill,
    contextBudget: {
      ...profile.defaultContextBudget,
      ...packet.contextBudget,
    },
    effectCeiling: {
      boundary: packet.effectCeiling?.boundary ?? profile.boundary ?? "safe",
    },
  };
}
