import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { CONTROL_PLANE_TOOLS } from "../security/control-plane-tools.js";
import type {
  SkillCategory,
  SkillContract,
  SkillContractOverride,
  SkillDocument,
  SkillEffectLevel,
  SkillResourceSet,
  SkillRoutingPolicy,
} from "../types.js";
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

function readOptionalStringArrayField(
  data: Record<string, unknown>,
  key: string,
  filePath: string,
): string[] {
  if (!Object.prototype.hasOwnProperty.call(data, key)) {
    return [];
  }
  return requireStringArrayField(data, key, filePath);
}

function readNullableStringArrayField(
  data: Record<string, unknown>,
  key: string,
  filePath: string,
): string[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(data, key)) {
    return undefined;
  }
  return requireStringArrayField(data, key, filePath);
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

function resolveRoutingScope(category: SkillCategory): SkillRoutingPolicy["scope"] | undefined {
  if (
    category === "core" ||
    category === "domain" ||
    category === "operator" ||
    category === "meta"
  ) {
    return category;
  }
  return undefined;
}

function normalizeRoutingPolicy(
  category: SkillCategory,
  data: Record<string, unknown>,
  filePath: string,
): SkillRoutingPolicy | undefined {
  const derivedScope = resolveRoutingScope(category);
  if (!derivedScope) {
    if (Object.prototype.hasOwnProperty.call(data, "routing")) {
      failSkillContract(
        filePath,
        "frontmatter field 'routing' is only supported for core/domain/operator/meta skills.",
      );
    }
    if (Object.prototype.hasOwnProperty.call(data, "continuity_required")) {
      failSkillContract(
        filePath,
        "frontmatter field 'continuity_required' is only supported for routable skills.",
      );
    }
    return undefined;
  }

  let continuityRequired = false;
  if (Object.prototype.hasOwnProperty.call(data, "continuity_required")) {
    if (typeof data.continuity_required !== "boolean") {
      failSkillContract(filePath, "continuity_required must be a boolean.");
    }
    continuityRequired = data.continuity_required;
  }

  if (!Object.prototype.hasOwnProperty.call(data, "routing")) {
    return {
      scope: derivedScope,
      continuityRequired,
    };
  }

  const routing = requireRecordField(data, "routing", filePath);
  if (Object.prototype.hasOwnProperty.call(routing, "scope")) {
    if (routing.scope !== derivedScope) {
      failSkillContract(
        filePath,
        `routing.scope must match the directory-derived scope '${derivedScope}'.`,
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(routing, "continuityRequired")) {
    failSkillContract(
      filePath,
      "routing.continuityRequired is not supported. Use routing.continuity_required.",
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(routing, "continuity_required") &&
    typeof routing.continuity_required !== "boolean"
  ) {
    failSkillContract(filePath, "routing.continuity_required must be a boolean.");
  }

  return {
    scope: derivedScope,
    continuityRequired:
      continuityRequired ||
      (typeof routing.continuity_required === "boolean" ? routing.continuity_required : false),
  };
}

function normalizeResourceSet(data: Record<string, unknown>, filePath: string): SkillResourceSet {
  return {
    references: readOptionalStringArrayField(data, "references", filePath),
    scripts: readOptionalStringArrayField(data, "scripts", filePath),
    heuristics: readOptionalStringArrayField(data, "heuristics", filePath),
    invariants: readOptionalStringArrayField(data, "invariants", filePath),
  };
}

const EFFECT_LEVEL_RANK: Record<SkillEffectLevel, number> = {
  read_only: 0,
  execute: 1,
  mutation: 2,
};

function resolveDefaultEffectLevel(input: {
  required: string[];
  optional: string[];
  denied: string[];
}): SkillEffectLevel {
  const denied = new Set(input.denied);
  const allowed = [...input.required, ...input.optional].filter((tool) => !denied.has(tool));
  if (allowed.some((tool) => tool === "edit" || tool === "write")) {
    return "mutation";
  }
  if (allowed.some((tool) => tool === "exec" || tool === "process")) {
    return "execute";
  }
  return "read_only";
}

function normalizeEffectLevel(
  data: Record<string, unknown>,
  filePath: string,
  fallback: SkillEffectLevel,
): SkillEffectLevel {
  if (Object.prototype.hasOwnProperty.call(data, "effectLevel")) {
    failSkillContract(filePath, "effectLevel is not supported. Use effect_level.");
  }
  if (!Object.prototype.hasOwnProperty.call(data, "effect_level")) {
    return fallback;
  }
  const value = data.effect_level;
  if (value === "read_only" || value === "execute" || value === "mutation") {
    return value;
  }
  failSkillContract(filePath, "effect_level must be one of: read_only | execute | mutation.");
}

function normalizeContract(
  name: string,
  category: SkillCategory,
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

  const outputs =
    category === "overlay"
      ? readNullableStringArrayField(data, "outputs", filePath)
      : requireStringArrayField(data, "outputs", filePath);
  if (Object.prototype.hasOwnProperty.call(data, "composableWith")) {
    failSkillContract(
      filePath,
      "frontmatter field 'composableWith' is not supported. Use 'composable_with'.",
    );
  }
  const composableWith = Object.prototype.hasOwnProperty.call(data, "composable_with")
    ? requireStringArrayField(data, "composable_with", filePath)
    : category === "overlay"
      ? undefined
      : [];
  const consumes =
    category === "overlay"
      ? readNullableStringArrayField(data, "consumes", filePath)
      : requireStringArrayField(data, "consumes", filePath);
  const requires = readOptionalStringArrayField(data, "requires", filePath);
  const effectLevel = normalizeEffectLevel(
    data,
    filePath,
    resolveDefaultEffectLevel({ required, optional, denied }),
  );
  const dispatch = normalizeDispatchPolicy(data, filePath);
  const routing = normalizeRoutingPolicy(category, data, filePath);

  return {
    name,
    category,
    description: typeof data.description === "string" ? data.description : undefined,
    dispatch,
    routing,
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
    requires,
    maxParallel:
      typeof data.max_parallel === "number"
        ? Math.max(1, Math.trunc(data.max_parallel))
        : undefined,
    stability:
      data.stability === "experimental" || data.stability === "deprecated"
        ? data.stability
        : "stable",
    costHint: data.cost_hint === "high" || data.cost_hint === "low" ? data.cost_hint : "medium",
    effectLevel,
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
  const effectLevel =
    override.effectLevel &&
    EFFECT_LEVEL_RANK[override.effectLevel] > EFFECT_LEVEL_RANK[base.effectLevel ?? "read_only"]
      ? override.effectLevel
      : (base.effectLevel ?? "read_only");

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
  const routing = (() => {
    const baseRouting = base.routing;
    const overrideRouting = override.routing;
    if (!baseRouting || !overrideRouting) {
      return baseRouting;
    }
    return {
      scope: baseRouting.scope,
      continuityRequired:
        baseRouting.continuityRequired === true || overrideRouting.continuityRequired === true,
    };
  })();

  return {
    ...base,
    dispatch,
    routing,
    outputs: override.outputs ?? base.outputs,
    composableWith: override.composableWith ?? base.composableWith,
    consumes: override.consumes ?? base.consumes,
    requires: [...new Set([...(base.requires ?? []), ...(override.requires ?? [])])],
    maxParallel,
    effectLevel,
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

export function mergeOverlayContract(
  base: SkillContract,
  overlay: SkillContractOverride,
): SkillContract {
  const denied = new Set(
    [...base.tools.denied, ...(overlay.tools?.denied ?? [])]
      .map((tool) => normalizeToolName(tool))
      .filter((tool) => tool.length > 0),
  );
  const required = new Set(
    [...base.tools.required, ...(overlay.tools?.required ?? [])]
      .map((tool) => normalizeToolName(tool))
      .filter((tool) => tool.length > 0)
      .filter((tool) => !denied.has(tool)),
  );
  const optional = new Set(
    [...base.tools.optional, ...(overlay.tools?.optional ?? [])]
      .map((tool) => normalizeToolName(tool))
      .filter((tool) => tool.length > 0)
      .filter((tool) => !denied.has(tool))
      .filter((tool) => !required.has(tool)),
  );

  const maxToolCalls =
    typeof overlay.budget?.maxToolCalls === "number"
      ? Math.min(base.budget.maxToolCalls, overlay.budget.maxToolCalls)
      : base.budget.maxToolCalls;
  const maxTokens =
    typeof overlay.budget?.maxTokens === "number"
      ? Math.min(base.budget.maxTokens, overlay.budget.maxTokens)
      : base.budget.maxTokens;
  const maxParallel =
    typeof overlay.maxParallel === "number"
      ? Math.min(base.maxParallel ?? overlay.maxParallel, overlay.maxParallel)
      : base.maxParallel;
  const effectLevel =
    overlay.effectLevel &&
    EFFECT_LEVEL_RANK[overlay.effectLevel] > EFFECT_LEVEL_RANK[base.effectLevel ?? "read_only"]
      ? overlay.effectLevel
      : (base.effectLevel ?? "read_only");

  const dispatch = (() => {
    const baseDispatch = base.dispatch ?? {
      gateThreshold: 10,
      autoThreshold: 16,
      defaultMode: "suggest" as const,
    };
    const overlayDispatch = overlay.dispatch;
    if (!overlayDispatch) return base.dispatch;
    const gateThreshold =
      typeof overlayDispatch.gateThreshold === "number"
        ? Math.max(baseDispatch.gateThreshold, Math.floor(overlayDispatch.gateThreshold))
        : baseDispatch.gateThreshold;
    const autoThreshold =
      typeof overlayDispatch.autoThreshold === "number"
        ? Math.max(baseDispatch.autoThreshold, Math.floor(overlayDispatch.autoThreshold))
        : baseDispatch.autoThreshold;
    const defaultMode =
      overlayDispatch.defaultMode === "auto" ||
      overlayDispatch.defaultMode === "gate" ||
      overlayDispatch.defaultMode === "suggest"
        ? overlayDispatch.defaultMode
        : baseDispatch.defaultMode;
    return {
      gateThreshold,
      autoThreshold: Math.max(gateThreshold, autoThreshold),
      defaultMode,
    };
  })();
  const routing = (() => {
    const baseRouting = base.routing;
    const overlayRouting = overlay.routing;
    if (!baseRouting || !overlayRouting) {
      return baseRouting;
    }
    return {
      scope: baseRouting.scope,
      continuityRequired:
        baseRouting.continuityRequired === true || overlayRouting.continuityRequired === true,
    };
  })();

  return {
    ...base,
    dispatch,
    routing,
    outputs: [...new Set([...(base.outputs ?? []), ...(overlay.outputs ?? [])])],
    composableWith: [
      ...new Set([...(base.composableWith ?? []), ...(overlay.composableWith ?? [])]),
    ],
    consumes: [...new Set([...(base.consumes ?? []), ...(overlay.consumes ?? [])])],
    requires: [...new Set([...(base.requires ?? []), ...(overlay.requires ?? [])])],
    maxParallel,
    effectLevel,
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

export function mergeSkillResources(
  base: SkillResourceSet,
  overlay: SkillResourceSet,
): SkillResourceSet {
  return {
    references: [...new Set([...base.references, ...overlay.references])],
    scripts: [...new Set([...base.scripts, ...overlay.scripts])],
    heuristics: [...new Set([...base.heuristics, ...overlay.heuristics])],
    invariants: [...new Set([...base.invariants, ...overlay.invariants])],
  };
}

export function createEmptySkillResources(): SkillResourceSet {
  return {
    references: [],
    scripts: [],
    heuristics: [],
    invariants: [],
  };
}

export function parseSkillDocument(filePath: string, category: SkillCategory): SkillDocument {
  const raw = readFileSync(filePath, "utf8");
  const { body, data } = parseFrontmatter(raw);
  if (Object.prototype.hasOwnProperty.call(data, "tier")) {
    failSkillContract(
      filePath,
      "frontmatter field 'tier' is not allowed. Category is derived from skill directory layout.",
    );
  }
  if (Object.prototype.hasOwnProperty.call(data, "category")) {
    failSkillContract(
      filePath,
      "frontmatter field 'category' is not allowed. Category is derived from skill directory layout.",
    );
  }

  const inferredName = toString(data.name, basename(dirname(filePath)) ?? "skill");
  const description = toString(data.description, `${inferredName} skill`);
  const contract = normalizeContract(inferredName, category, data, filePath);
  const resources = normalizeResourceSet(data, filePath);

  return {
    name: inferredName,
    description,
    category,
    filePath,
    baseDir: dirname(filePath),
    markdown: body.trim(),
    contract,
    resources,
    sharedContextFiles: [],
    overlayFiles: [],
  };
}
