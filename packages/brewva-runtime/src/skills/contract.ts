import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { CONTROL_PLANE_TOOLS } from "../security/control-plane-tools.js";
import type { SkillContract, SkillContractOverride, SkillDocument, SkillTier } from "../types.js";
import { normalizeToolName } from "../utils/tool-name.js";

interface ParsedFrontmatter {
  body: string;
  data: Record<string, unknown>;
}

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

function parseFrontmatter(markdown: string): ParsedFrontmatter {
  const match = markdown.match(FRONTMATTER_REGEX);
  if (!match) {
    return { body: markdown, data: {} };
  }

  const yamlText = match[1] ?? "";
  const body = match[2] ?? "";
  const parsed = parseYaml(yamlText);
  const data =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};

  return { body, data };
}

function failSkillContract(filePath: string, message: string): never {
  throw new Error(`[skill_contract] ${filePath}: ${message}`);
}

function requireRecordField(
  data: Record<string, unknown>,
  key: string,
  filePath: string,
): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(data, key)) {
    failSkillContract(filePath, `missing required frontmatter field '${key}'.`);
  }
  const value = data[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failSkillContract(filePath, `frontmatter field '${key}' must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireStringArrayField(
  data: Record<string, unknown>,
  key: string,
  filePath: string,
): string[] {
  if (!Object.prototype.hasOwnProperty.call(data, key)) {
    failSkillContract(filePath, `missing required frontmatter field '${key}'.`);
  }
  const value = data[key];
  if (!Array.isArray(value)) {
    failSkillContract(filePath, `frontmatter field '${key}' must be a string array.`);
  }
  const out: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") {
      failSkillContract(
        filePath,
        `frontmatter field '${key}[${index}]' must be a string (got ${typeof item}).`,
      );
    }
    const normalized = item.trim();
    if (!normalized) {
      failSkillContract(filePath, `frontmatter field '${key}[${index}]' cannot be empty.`);
    }
    out.push(normalized);
  }
  return out;
}

function requireNumericField(
  data: Record<string, unknown>,
  keys: readonly string[],
  filePath: string,
  label: string,
): number {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
    const value = data[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      failSkillContract(filePath, `frontmatter field '${key}' must be a finite number.`);
    }
    return value;
  }
  failSkillContract(filePath, `missing required frontmatter field '${label}'.`);
}

function normalizeToolListStrict(values: string[], filePath: string, fieldPath: string): string[] {
  return values.map((toolName, index) => {
    const normalized = normalizeToolName(toolName);
    if (!normalized) {
      failSkillContract(
        filePath,
        `frontmatter field '${fieldPath}[${index}]' is not a valid tool.`,
      );
    }
    return normalized;
  });
}

function toString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeDispatchPolicy(
  data: Record<string, unknown>,
  filePath: string,
): SkillContract["dispatch"] | undefined {
  if (!Object.prototype.hasOwnProperty.call(data, "dispatch")) {
    return {
      gateThreshold: 10,
      autoThreshold: 16,
      defaultMode: "suggest",
    };
  }

  const rawDispatch = requireRecordField(data, "dispatch", filePath);
  if (Object.prototype.hasOwnProperty.call(rawDispatch, "gateThreshold")) {
    failSkillContract(
      filePath,
      "dispatch.gateThreshold is not supported. Use dispatch.gate_threshold.",
    );
  }
  if (Object.prototype.hasOwnProperty.call(rawDispatch, "autoThreshold")) {
    failSkillContract(
      filePath,
      "dispatch.autoThreshold is not supported. Use dispatch.auto_threshold.",
    );
  }
  if (Object.prototype.hasOwnProperty.call(rawDispatch, "defaultMode")) {
    failSkillContract(
      filePath,
      "dispatch.defaultMode is not supported. Use dispatch.default_mode.",
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(rawDispatch, "gate_threshold") &&
    (typeof rawDispatch.gate_threshold !== "number" || !Number.isFinite(rawDispatch.gate_threshold))
  ) {
    failSkillContract(filePath, "dispatch.gate_threshold must be a finite number.");
  }
  if (
    Object.prototype.hasOwnProperty.call(rawDispatch, "auto_threshold") &&
    (typeof rawDispatch.auto_threshold !== "number" || !Number.isFinite(rawDispatch.auto_threshold))
  ) {
    failSkillContract(filePath, "dispatch.auto_threshold must be a finite number.");
  }
  if (
    Object.prototype.hasOwnProperty.call(rawDispatch, "default_mode") &&
    typeof rawDispatch.default_mode !== "string"
  ) {
    failSkillContract(filePath, "dispatch.default_mode must be a string.");
  }

  const gateThreshold = normalizePositiveInteger(rawDispatch.gate_threshold, 10);
  const autoThreshold = Math.max(
    gateThreshold,
    normalizePositiveInteger(rawDispatch.auto_threshold, 16),
  );
  const modeCandidate = rawDispatch.default_mode;
  if (
    Object.prototype.hasOwnProperty.call(rawDispatch, "default_mode") &&
    modeCandidate !== "gate" &&
    modeCandidate !== "auto" &&
    modeCandidate !== "suggest"
  ) {
    failSkillContract(filePath, "dispatch.default_mode must be one of: suggest | gate | auto.");
  }
  const defaultMode =
    modeCandidate === "gate" || modeCandidate === "auto" ? modeCandidate : "suggest";

  return {
    gateThreshold,
    autoThreshold,
    defaultMode,
  };
}

function normalizeContract(
  name: string,
  tier: SkillTier,
  data: Record<string, unknown>,
  filePath: string,
): SkillContract {
  const tools = requireRecordField(data, "tools", filePath);
  const budget = requireRecordField(data, "budget", filePath);
  if (Object.prototype.hasOwnProperty.call(budget, "maxToolCalls")) {
    failSkillContract(filePath, "budget.maxToolCalls is not supported. Use budget.max_tool_calls.");
  }
  if (Object.prototype.hasOwnProperty.call(budget, "maxTokens")) {
    failSkillContract(filePath, "budget.maxTokens is not supported. Use budget.max_tokens.");
  }

  const required = normalizeToolListStrict(
    requireStringArrayField(tools, "required", filePath),
    filePath,
    "tools.required",
  );
  const optional = normalizeToolListStrict(
    requireStringArrayField(tools, "optional", filePath),
    filePath,
    "tools.optional",
  );
  const controlPlaneToolSet = new Set(
    CONTROL_PLANE_TOOLS.map((tool) => normalizeToolName(tool)).filter((tool) => tool.length > 0),
  );
  const denied = normalizeToolListStrict(
    requireStringArrayField(tools, "denied", filePath),
    filePath,
    "tools.denied",
  ).filter((tool) => !controlPlaneToolSet.has(tool));

  const maxToolCalls = Math.trunc(
    requireNumericField(budget, ["max_tool_calls"], filePath, "budget.max_tool_calls"),
  );
  if (maxToolCalls < 1) {
    failSkillContract(filePath, "budget.max_tool_calls must be >= 1.");
  }

  const maxTokens = Math.trunc(
    requireNumericField(budget, ["max_tokens"], filePath, "budget.max_tokens"),
  );
  if (maxTokens < 1000) {
    failSkillContract(filePath, "budget.max_tokens must be >= 1000.");
  }

  const outputs = requireStringArrayField(data, "outputs", filePath);
  if (Object.prototype.hasOwnProperty.call(data, "composableWith")) {
    failSkillContract(
      filePath,
      "frontmatter field 'composableWith' is not supported. Use 'composable_with'.",
    );
  }
  const composableWith = Object.prototype.hasOwnProperty.call(data, "composable_with")
    ? requireStringArrayField(data, "composable_with", filePath)
    : [];
  const consumes = requireStringArrayField(data, "consumes", filePath);
  const dispatch = normalizeDispatchPolicy(data, filePath);

  return {
    name,
    tier,
    description: typeof data.description === "string" ? data.description : undefined,
    dispatch,
    tools: {
      required,
      optional,
      denied,
    },
    budget: {
      maxToolCalls: Math.max(1, Math.trunc(maxToolCalls)),
      maxTokens: Math.max(1000, Math.trunc(maxTokens)),
    },
    outputs,
    composableWith,
    consumes,
    maxParallel:
      typeof data.max_parallel === "number"
        ? Math.max(1, Math.trunc(data.max_parallel))
        : undefined,
    stability:
      data.stability === "experimental" || data.stability === "deprecated"
        ? data.stability
        : "stable",
    costHint: data.cost_hint === "high" || data.cost_hint === "low" ? data.cost_hint : "medium",
  };
}

export function tightenContract(
  base: SkillContract,
  override: SkillContractOverride,
): SkillContract {
  const baseDenied = new Set([...base.tools.denied].map((tool) => normalizeToolName(tool)));
  const baseAllowed = new Set(
    [...base.tools.required, ...base.tools.optional]
      .map((tool) => normalizeToolName(tool))
      .filter((tool) => tool.length > 0)
      .filter((tool) => !baseDenied.has(tool)),
  );

  const denied = new Set(baseDenied);
  for (const tool of override.tools?.denied ?? []) {
    const normalized = normalizeToolName(tool);
    if (normalized) denied.add(normalized);
  }

  const required = new Set(
    [...base.tools.required].map((tool) => normalizeToolName(tool)).filter(Boolean),
  );
  for (const tool of override.tools?.required ?? []) {
    const normalized = normalizeToolName(tool);
    if (!normalized) continue;
    if (baseAllowed.has(normalized)) {
      required.add(normalized);
    }
  }

  const optionalSource = override.tools?.optional ?? base.tools.optional;
  const optional = new Set<string>();
  for (const tool of optionalSource) {
    const normalized = normalizeToolName(tool);
    if (!normalized) continue;
    if (!baseAllowed.has(normalized)) continue;
    if (denied.has(normalized)) continue;
    if (required.has(normalized)) continue;
    optional.add(normalized);
  }

  const maxToolCalls =
    typeof override.budget?.maxToolCalls === "number"
      ? Math.min(base.budget.maxToolCalls, override.budget.maxToolCalls)
      : base.budget.maxToolCalls;
  const maxTokens =
    typeof override.budget?.maxTokens === "number"
      ? Math.min(base.budget.maxTokens, override.budget.maxTokens)
      : base.budget.maxTokens;
  const maxParallel =
    typeof override.maxParallel === "number"
      ? Math.min(base.maxParallel ?? override.maxParallel, override.maxParallel)
      : base.maxParallel;

  const dispatch = (() => {
    const baseDispatch = base.dispatch ?? {
      gateThreshold: 10,
      autoThreshold: 16,
      defaultMode: "suggest" as const,
    };
    const overrideDispatch = override.dispatch;
    if (!overrideDispatch) return base.dispatch;
    const gateThreshold =
      typeof overrideDispatch.gateThreshold === "number"
        ? Math.max(baseDispatch.gateThreshold, Math.floor(overrideDispatch.gateThreshold))
        : baseDispatch.gateThreshold;
    const autoThreshold =
      typeof overrideDispatch.autoThreshold === "number"
        ? Math.max(baseDispatch.autoThreshold, Math.floor(overrideDispatch.autoThreshold))
        : baseDispatch.autoThreshold;
    const defaultMode =
      overrideDispatch.defaultMode === "auto" ||
      overrideDispatch.defaultMode === "gate" ||
      overrideDispatch.defaultMode === "suggest"
        ? overrideDispatch.defaultMode
        : baseDispatch.defaultMode;
    return {
      gateThreshold,
      autoThreshold: Math.max(gateThreshold, autoThreshold),
      defaultMode,
    };
  })();

  return {
    ...base,
    dispatch,
    outputs: override.outputs ?? base.outputs,
    composableWith: override.composableWith ?? base.composableWith,
    consumes: override.consumes ?? base.consumes,
    maxParallel,
    tools: {
      required: [...required],
      optional: [...optional],
      denied: [...denied],
    },
    budget: {
      maxToolCalls,
      maxTokens,
    },
  };
}

export function parseSkillDocument(filePath: string, tier: SkillTier): SkillDocument {
  const raw = readFileSync(filePath, "utf8");
  const { body, data } = parseFrontmatter(raw);
  if (Object.prototype.hasOwnProperty.call(data, "tier")) {
    failSkillContract(
      filePath,
      "frontmatter field 'tier' is not allowed. Tier is derived from skill directory layout.",
    );
  }

  const inferredName = toString(data.name, basename(dirname(filePath)) ?? "skill");
  const description = toString(data.description, `${inferredName} skill`);
  const contract = normalizeContract(inferredName, tier, data, filePath);

  return {
    name: inferredName,
    description,
    tier,
    filePath,
    baseDir: dirname(filePath),
    markdown: body.trim(),
    contract,
  };
}
