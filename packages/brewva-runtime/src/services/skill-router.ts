import type {
  SkillPreselection,
  SkillRoutingResult,
  SkillRoutingSelectionTrace,
  SkillRoutingTrace,
  SkillSelection,
  SkillSelectionBreakdownEntry,
  SkillSelectionSignal,
  SkillSelectorConfig,
  SkillsIndexEntry,
} from "../types.js";
import { sha256 } from "../utils/hash.js";

const ROUTER_VERSION = "deterministic-router.v1";
const MIN_SELECTION_SCORE = 10;
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "before",
  "but",
  "by",
  "do",
  "for",
  "from",
  "help",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "me",
  "need",
  "of",
  "on",
  "or",
  "please",
  "show",
  "that",
  "the",
  "this",
  "to",
  "use",
  "want",
  "with",
  "you",
]);

interface RouteSkillsInput {
  promptText: string;
  index: SkillsIndexEntry[];
  activeSkillName?: string | null;
  availableOutputs?: Iterable<string>;
  preselection?: SkillPreselection;
}

interface ScoreTermsInput {
  promptTokens: Set<string>;
  terms: string[];
  signal: SkillSelectionSignal;
  delta: number;
  cap: number;
  breakdown: SkillSelectionBreakdownEntry[];
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function expandTokenVariants(token: string): string[] {
  const out = new Set<string>();
  const trimmed = token.trim().toLowerCase();
  if (trimmed.length === 0) return [];
  out.add(trimmed);
  if (trimmed.endsWith("ies") && trimmed.length > 4) {
    out.add(`${trimmed.slice(0, -3)}y`);
  }
  if (trimmed.endsWith("ing") && trimmed.length > 5) {
    out.add(trimmed.slice(0, -3));
  }
  if (trimmed.endsWith("ed") && trimmed.length > 4) {
    out.add(trimmed.slice(0, -2));
  }
  if (trimmed.endsWith("es") && trimmed.length > 4) {
    out.add(trimmed.slice(0, -2));
  }
  if (trimmed.endsWith("s") && trimmed.length > 3) {
    out.add(trimmed.slice(0, -1));
  }
  return [...out].filter((entry) => entry.length > 1);
}

function extractTokens(value: string): string[] {
  const raw = normalizeText(value).match(/[a-z0-9]+/g) ?? [];
  const out = new Set<string>();
  for (const token of raw) {
    for (const variant of expandTokenVariants(token)) {
      out.add(variant);
    }
  }
  return [...out];
}

function extractScoringTerms(value: string): string[] {
  return extractTokens(value).filter((token) => !STOP_WORDS.has(token));
}

function normalizeOutputKey(value: string): string {
  return normalizeText(value).replace(/\s+/g, "_");
}

function scoreTerms(input: ScoreTermsInput): number {
  const seen = new Set<string>();
  let total = 0;
  for (const term of input.terms) {
    if (seen.has(term) || !input.promptTokens.has(term)) continue;
    if (total >= input.cap) break;
    const applied = Math.min(input.delta, input.cap - total);
    if (applied <= 0) break;
    input.breakdown.push({
      signal: input.signal,
      term,
      delta: applied,
    });
    total += applied;
    seen.add(term);
  }
  return total;
}

function buildExactNameMatch(
  promptText: string,
  skillName: string,
  breakdown: SkillSelectionBreakdownEntry[],
): number {
  const normalizedPrompt = normalizeText(promptText);
  const normalizedSkillName = normalizeText(skillName);
  if (!normalizedPrompt || !normalizedSkillName) return 0;
  if (!normalizedPrompt.includes(normalizedSkillName)) return 0;
  breakdown.push({
    signal: "name_exact",
    term: normalizedSkillName,
    delta: 12,
  });
  return 12;
}

function buildAvailableOutputScore(
  entry: SkillsIndexEntry,
  availableOutputs: string[],
  breakdown: SkillSelectionBreakdownEntry[],
): number {
  const available = new Set(availableOutputs.map((output) => normalizeOutputKey(output)));
  if (available.size === 0) return 0;
  let total = 0;
  for (const consume of entry.consumes) {
    const normalizedConsume = normalizeOutputKey(consume);
    if (!available.has(normalizedConsume) || total >= 8) continue;
    breakdown.push({
      signal: "available_output",
      term: normalizedConsume,
      delta: 4,
    });
    total += 4;
  }
  return total;
}

function resolveSelectionTrace(input: {
  reason: string;
  routingOutcome: SkillRoutingResult["routingOutcome"];
  selected: SkillSelection[];
}): SkillRoutingSelectionTrace {
  if (input.routingOutcome === "failed") {
    return {
      status: "failed",
      reason: input.reason,
      selectedCount: 0,
      selectedSkills: [],
    };
  }
  if (input.selected.length === 0) {
    return {
      status: "empty",
      reason: input.reason,
      selectedCount: 0,
      selectedSkills: [],
    };
  }
  return {
    status: "selected",
    reason: input.reason,
    selectedCount: input.selected.length,
    selectedSkills: input.selected.map((entry) => entry.name),
  };
}

function stableConfigHash(config: SkillSelectorConfig): string {
  return sha256(
    JSON.stringify({
      mode: config.mode,
      k: config.k,
    }),
  );
}

function stableIndexHash(index: SkillsIndexEntry[]): string {
  return sha256(
    JSON.stringify(
      index.map((entry) => ({
        name: entry.name,
        tier: entry.tier,
        description: entry.description,
        outputs: entry.outputs,
        toolsRequired: entry.toolsRequired,
        consumes: entry.consumes,
        dispatch: entry.dispatch,
      })),
    ),
  );
}

export class SkillRouterService {
  constructor(private readonly config: SkillSelectorConfig) {}

  route(input: RouteSkillsInput): SkillRoutingResult {
    const startedAt = Date.now();
    const promptHash = sha256(normalizeText(input.promptText));
    const skillsIndexHash = stableIndexHash(input.index);
    const configHash = stableConfigHash(this.config);
    const activeSkillName = input.activeSkillName?.trim() || null;
    const availableOutputs = [...(input.availableOutputs ?? [])];

    try {
      if (input.preselection) {
        const routingOutcome =
          input.preselection.routingOutcome ??
          (input.preselection.selected.length > 0 ? "selected" : "empty");
        const trace = this.buildTrace({
          selectorMode: this.config.mode,
          source: "external_preselection",
          promptHash,
          skillsIndexHash,
          configHash,
          latencyMs: Date.now() - startedAt,
          routingOutcome,
          selectionReason:
            routingOutcome === "failed"
              ? "external_preselection_failed"
              : input.preselection.selected.length > 0
                ? "external_preselection_selected"
                : "external_preselection_empty",
          selected: input.preselection.selected,
          activeSkillName,
          availableOutputs,
        });
        return {
          selected: input.preselection.selected,
          routingOutcome,
          trace,
        };
      }

      if (this.config.mode === "external_only") {
        const trace = this.buildTrace({
          selectorMode: this.config.mode,
          source: "external_preselection",
          promptHash,
          skillsIndexHash,
          configHash,
          latencyMs: Date.now() - startedAt,
          routingOutcome: "empty",
          selectionReason: "external_only_no_preselection",
          selected: [],
          activeSkillName,
          availableOutputs,
        });
        return {
          selected: [],
          routingOutcome: "empty",
          trace,
        };
      }

      const promptTokens = new Set(extractTokens(input.promptText));
      const candidates: SkillSelection[] = [];
      for (const entry of input.index) {
        if (activeSkillName && entry.name === activeSkillName) {
          continue;
        }
        const breakdown: SkillSelectionBreakdownEntry[] = [];
        let score = 0;
        score += buildExactNameMatch(input.promptText, entry.name, breakdown);
        score += scoreTerms({
          promptTokens,
          terms: extractScoringTerms(entry.name),
          signal: "name_token",
          delta: 6,
          cap: 12,
          breakdown,
        });
        score += scoreTerms({
          promptTokens,
          terms: extractScoringTerms(entry.description),
          signal: "description_token",
          delta: 2,
          cap: 8,
          breakdown,
        });
        score += scoreTerms({
          promptTokens,
          terms: entry.outputs.flatMap((output) => extractScoringTerms(output)),
          signal: "output_token",
          delta: 4,
          cap: 8,
          breakdown,
        });
        score += scoreTerms({
          promptTokens,
          terms: entry.consumes.flatMap((consume) => extractScoringTerms(consume)),
          signal: "consume_token",
          delta: 3,
          cap: 6,
          breakdown,
        });
        score += scoreTerms({
          promptTokens,
          terms: entry.toolsRequired.flatMap((toolName) => extractScoringTerms(toolName)),
          signal: "tool_token",
          delta: 2,
          cap: 4,
          breakdown,
        });
        score += buildAvailableOutputScore(entry, availableOutputs, breakdown);
        if (score < MIN_SELECTION_SCORE) {
          continue;
        }
        candidates.push({
          name: entry.name,
          score,
          reason: breakdown.map((item) => `${item.signal}:${item.term}`).join(", "),
          breakdown,
        });
      }

      const selected = candidates
        .toSorted((left, right) => {
          if (right.score !== left.score) return right.score - left.score;
          return left.name.localeCompare(right.name);
        })
        .slice(0, Math.max(1, this.config.k));
      const routingOutcome = selected.length > 0 ? "selected" : "empty";
      const trace = this.buildTrace({
        selectorMode: this.config.mode,
        source: "deterministic_router",
        promptHash,
        skillsIndexHash,
        configHash,
        latencyMs: Date.now() - startedAt,
        routingOutcome,
        selectionReason:
          routingOutcome === "selected"
            ? "deterministic_router_selected"
            : "deterministic_router_empty",
        selected,
        activeSkillName,
        availableOutputs,
      });
      return {
        selected,
        routingOutcome,
        trace,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown_error";
      const trace = this.buildTrace({
        selectorMode: this.config.mode,
        source:
          this.config.mode === "external_only" ? "external_preselection" : "deterministic_router",
        promptHash,
        skillsIndexHash,
        configHash,
        latencyMs: Date.now() - startedAt,
        routingOutcome: "failed",
        selectionReason: "routing_failed",
        selected: [],
        activeSkillName,
        availableOutputs,
        error: message,
      });
      return {
        selected: [],
        routingOutcome: "failed",
        trace,
      };
    }
  }

  private buildTrace(input: {
    selectorMode: SkillSelectorConfig["mode"];
    source: SkillRoutingTrace["source"];
    promptHash: string;
    skillsIndexHash: string;
    configHash: string;
    latencyMs: number;
    routingOutcome: SkillRoutingResult["routingOutcome"];
    selectionReason: string;
    selected: SkillSelection[];
    activeSkillName: string | null;
    availableOutputs: string[];
    error?: string;
  }): SkillRoutingTrace {
    return {
      routerVersion: ROUTER_VERSION,
      selectorMode: input.selectorMode,
      source: input.source,
      promptHash: input.promptHash,
      skillsIndexHash: input.skillsIndexHash,
      configHash: input.configHash,
      latencyMs: input.latencyMs,
      routingOutcome: input.routingOutcome,
      selection: resolveSelectionTrace({
        reason: input.selectionReason,
        routingOutcome: input.routingOutcome,
        selected: input.selected,
      }),
      candidates: input.selected,
      activeSkillName: input.activeSkillName,
      availableOutputs: [...input.availableOutputs],
      error: input.error,
    };
  }
}
