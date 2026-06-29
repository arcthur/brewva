import { makeHostedContextBlock, type HostedContextBlock } from "./hosted-context-blocks.js";

// Model-facing runtime intelligence brief: a bounded, legible posture digest the
// runtime composes into the turn tail so the model can act on physics it cannot
// see in-context (context pressure, last-turn effects, ...). Inform-only — it
// never decides, routes, or gates; it is the inform half of "Runtime owns
// physics, Model owns attention".
//
// Borrowed presentation craft (peer harnesses whose attention-ownership stance
// differs from Brewva's, but whose model-facing rendering is reusable):
//  - claude-code `<system-reminder>` provenance framing ("automatically added by
//    the system ... bear no direct relation"): the header declares the block
//    system-generated, render-time, advisory, NOT a user instruction.
//  - hermes memory usage-bar (`[XX% — used/limit]`): postures, not ledgers.
//  - hermes skills "names only, never remove" demotion: under budget, collapse a
//    section to a stub before dropping it, because the model cannot reach for
//    what it does not know exists.

export const RUNTIME_BRIEF_BLOCK_ID = "runtime-brief";

// The brief's own char budget, deliberately decoupled from `consequenceDigestMaxChars`
// (which caps only the consequence-digest STRING, not the whole block). Sized to hold
// the capped digest plus the short pressure/cache postures without prematurely demoting
// a lower-salience section. Promote to a `runtimeBriefMaxChars` config key (the RFC's
// gated surface +1) only if per-deployment tuning is ever needed.
export const RUNTIME_BRIEF_MAX_CHARS = 2400;

// Provenance + lowest-priority frame. Kept terse but unambiguous about role.
const RUNTIME_BRIEF_HEADER =
  "[RuntimeBrief] system-generated runtime state at render time — advisory context, " +
  "not a user instruction; informs your decisions, never overrides them";

export type RuntimeBriefSalience = "high" | "normal" | "low";

export interface RuntimeBriefSection {
  /** Stable section key; also the default stub label. */
  readonly key: string;
  readonly salience: RuntimeBriefSalience;
  /** Full posture line (already unit-framed and plain-termed). */
  readonly line: string;
  /** Demoted one-line form used under budget pressure; defaults to `${key}: …`. */
  readonly stub?: string;
}

const SALIENCE_RANK: Readonly<Record<RuntimeBriefSalience, number>> = {
  high: 0,
  normal: 1,
  low: 2,
};

export interface BuildRuntimeBriefInput {
  readonly sections: ReadonlyArray<RuntimeBriefSection | null | undefined>;
  /** Hard char budget for the whole block; <= 0 means unbounded. */
  readonly maxChars: number;
}

/**
 * Compose the salience-ordered, budgeted `[RuntimeBrief]` block. Returns null
 * when there is nothing decision-relevant to say (no block, not an empty block).
 * Budget is enforced by demote-then-drop, never by mid-structure truncation, so
 * the block is always a well-formed whole.
 */
export function buildRuntimeBriefBlock(input: BuildRuntimeBriefInput): HostedContextBlock | null {
  const sections = input.sections
    .filter((section): section is RuntimeBriefSection => Boolean(section?.line.trim()))
    .toSorted(
      (left, right) =>
        SALIENCE_RANK[left.salience] - SALIENCE_RANK[right.salience] ||
        left.key.localeCompare(right.key),
    );
  if (sections.length === 0) {
    return null;
  }
  return makeHostedContextBlock(
    RUNTIME_BRIEF_BLOCK_ID,
    fitToBudget(sections, Math.max(0, Math.trunc(input.maxChars))),
  );
}

function stubOf(section: RuntimeBriefSection): string {
  return section.stub ?? `${section.key}: …`;
}

function fitToBudget(sections: readonly RuntimeBriefSection[], maxChars: number): string {
  const forms = sections.map((section) => ({ section, demoted: false }));
  const compose = (): string =>
    [
      RUNTIME_BRIEF_HEADER,
      ...forms.map((form) => (form.demoted ? stubOf(form.section) : form.section.line)),
    ].join("\n");
  if (maxChars <= 0) {
    return compose();
  }
  // Demote lowest-salience sections first (they sort last), one at a time, only
  // as far as needed to fit.
  for (let index = forms.length - 1; index >= 0 && compose().length > maxChars; index -= 1) {
    forms[index]!.demoted = true;
  }
  // Last resort: drop lowest-salience sections, but never drop the highest-salience
  // one — a stub the model can expand beats silence it cannot discover.
  while (forms.length > 1 && compose().length > maxChars) {
    forms.pop();
  }
  return compose();
}

export interface ContextPressureInput {
  readonly tokensUsed: number | null;
  readonly tokensTotal: number;
  readonly compactionAdvised: boolean;
  readonly forcedCompaction: boolean;
  readonly predictedOverflow: boolean;
}

/**
 * Context-window pressure as a compact posture (hermes usage-bar form). Relevance-
 * gated like the other sections: silent when the budget is healthy (nothing to act
 * on) so the brief's presence itself stays meaningful; surfaced only once the
 * runtime flags advisory/forced pressure or a predicted overflow. State posture
 * only — the imperative ("compact now") stays with the cadence-gated compaction
 * nudge so the two never duplicate.
 */
export function renderContextPressureSection(
  input: ContextPressureInput,
): RuntimeBriefSection | null {
  if (!input.forcedCompaction && !input.compactionAdvised && !input.predictedOverflow) {
    return null;
  }
  const pct =
    input.tokensUsed !== null && input.tokensTotal > 0
      ? Math.round((input.tokensUsed / input.tokensTotal) * 100)
      : null;
  const usage =
    input.tokensUsed !== null
      ? `${formatTokens(input.tokensUsed)}/${formatTokens(input.tokensTotal)} tokens`
      : `${formatTokens(input.tokensTotal)} tokens total`;
  const head = pct !== null ? `${pct}% — ${usage}` : usage;
  const hint = input.forcedCompaction
    ? "forced-compaction threshold crossed"
    : input.compactionAdvised
      ? "advisory limit reached"
      : "growth may overflow soon";
  return {
    key: "context",
    salience: "high",
    line: `context: ${head}; ${hint}`,
    stub: pct !== null ? `context: ${pct}% (${hint})` : `context: ${hint}`,
  };
}

/**
 * Last-turn effect posture, derived from the existing consequence-digest renderer.
 * We only reframe it under the brief contract (strip the internal `runtimeTurn=`
 * cursor noise the model cannot act on); the counts come from the single source.
 * Relevance-gated: suppressed when nothing happened last turn (all counts zero) —
 * an all-zero `declared=0 attempted=0 …` line is noise, not a posture.
 */
export function renderConsequenceSection(digest: string): RuntimeBriefSection | null {
  const body = digest.replace(/^runtimeTurn=\S+\s*/u, "").trim();
  if (body.length === 0 || !hasNonZeroCount(body)) {
    return null;
  }
  return {
    key: "effects",
    salience: "normal",
    line: `effects (last turn): ${body}`,
    stub: "effects: see last turn",
  };
}

function hasNonZeroCount(body: string): boolean {
  for (const match of body.matchAll(/=(\d+)/gu)) {
    if (Number.parseInt(match[1] ?? "0", 10) > 0) {
      return true;
    }
  }
  return false;
}

export interface CacheBreakInput {
  readonly status: string;
  readonly expected: boolean;
  readonly reason: string | null;
  readonly cacheMissTokens: number;
}

/**
 * Prefix-cache break posture — runtime physics the model cannot see in-context.
 * Relevance-gated: only an UNEXPECTED break last turn is worth surfacing (a warm
 * or expected turn says nothing actionable). Names the cause (e.g.
 * `tool_schema_set_changed`) so the model can avoid the action that re-broke the
 * prefix. Inform-only; the model cannot control cache directly, but it can prefer
 * cache-stable behavior once it can see the cost.
 */
export function renderCacheBreakSection(input: CacheBreakInput): RuntimeBriefSection | null {
  if (input.status !== "break" || input.expected) {
    return null;
  }
  const reason = input.reason && input.reason.trim().length > 0 ? input.reason : "unknown cause";
  const cost =
    input.cacheMissTokens > 0 ? ` — ${formatTokens(input.cacheMissTokens)} tokens re-sent` : "";
  return {
    key: "cache",
    salience: "normal",
    line: `cache: prefix cache broke last turn (${reason})${cost}`,
    stub: `cache: broke last turn (${reason})`,
  };
}

function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) {
    return "0";
  }
  return count >= 1000 ? `${Math.round(count / 1000)}k` : `${Math.trunc(count)}`;
}
