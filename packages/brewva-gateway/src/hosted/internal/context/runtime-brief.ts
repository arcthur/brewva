import type { UnverifiedRequirementDebtReason } from "@brewva/brewva-vocabulary/fitness";
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
  /**
   * Estimated token mass of `attention_pin` workbench entries (the retention
   * contract's accounted cost). Rendered only when > 0 and pressure is already
   * being surfaced: under pressure the model should see how much of the window
   * is contract-held and only releasable by an explicit `workbench_evict`.
   */
  readonly pinnedTokens?: number;
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
  const pinned =
    (input.pinnedTokens ?? 0) > 0
      ? `; pinned ~${formatTokens(input.pinnedTokens ?? 0)} tokens held by attention_pin (explicit evict releases)`
      : "";
  return {
    key: "context",
    salience: "high",
    line: `context: ${head}; ${hint}${pinned}`,
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

export interface RequirementDebtInput {
  /** `must`-modality atoms still unverified (the below-requirements ladder/coverage debt). */
  readonly unverifiedMustCount: number;
  /** Why the ladder/coverage debt fires, or null when there is none. */
  readonly debtReason: UnverifiedRequirementDebtReason | null;
  /** High-risk atoms whose only positive coverage is presence-grade (R3 grade debt). */
  readonly insufficientGradeCount: number;
}

/**
 * Requirement-debt posture (R4): surfaces to the PRODUCING model, at turn tail,
 * the debt run-report already computes for the operator — so "done" is not
 * declared blind (the up4 failure: the model never saw its own seven unverified
 * must atoms). Relevance-gated: silent when there is neither ladder/coverage debt
 * NOR a presence-only high-risk atom (nothing to act on). Inform-only; the sole
 * gate stays the operator-promoted verification-gate manifest (axiom 18).
 */
export function renderRequirementDebtSection(
  input: RequirementDebtInput,
): RuntimeBriefSection | null {
  const hasLadderDebt = input.debtReason !== null && input.unverifiedMustCount > 0;
  const hasGradeDebt = input.insufficientGradeCount > 0;
  if (!hasLadderDebt && !hasGradeDebt) {
    return null;
  }
  const parts: string[] = [];
  if (hasLadderDebt) {
    parts.push(`${input.unverifiedMustCount} must atom(s) unverified (${input.debtReason})`);
  }
  if (hasGradeDebt) {
    parts.push(`${input.insufficientGradeCount} high-risk atom(s) on presence-only evidence`);
  }
  const body = parts.join("; ");
  return {
    key: "requirements",
    salience: "normal",
    line: `requirements: ${body} — dispatch an independent review or climb to a behavioral check before finalizing`,
    stub: `requirements: ${body}`,
  };
}

export interface DelegationAdvisoryInput {
  /**
   * Context pressure is at the ADVISORY tier (`workbench_compact_soon`), NOT the
   * gate tier. At the advisory tier delegation is a pressure-relief instrument:
   * broad remaining work is cheaper in a fresh child window than in this one.
   * (At the gate tier the imperative is `workbench_compact` now — naming
   * delegation there would compete with the gate, so the caller passes false.)
   */
  readonly pressureRelief: boolean;
  /**
   * Open review debt exists on the tape (fresh code written, a `requirements`+
   * pass claimed, but no independent receipt that matches-and-covers). The one
   * `independent`-perspective receipt the model cannot mint for itself; a
   * `review_request` delegation is the closure path.
   */
  readonly reviewDebtClosure: boolean;
  /**
   * High-risk `must` atom IDs that reached turn close with NO independent OR
   * deterministic pass at the risk-floor grade (`FitnessProjection.independenceDebtAtoms`).
   * They owe an independent read AT grade — the perspective the author cannot mint
   * on its own work. A sub-floor independent receipt MAY exist, so the surface says
   * "at grade", never "no independent receipt".
   *
   * Carried as the atom-ID list (not a boolean) so the advisory can name the count
   * AND enumerate the atoms, per the RFC's information-channel thesis: the model can
   * only steer on a gap it can perceive, so the surface reads "N high-risk must-atoms
   * ... (atom ids)". Empty ⇒ no independence debt (the reason is silent).
   */
  readonly independenceDebtAtoms: readonly string[];
}

/**
 * Delegation advisory posture (Lever 2, axiom 18): names delegation as an
 * instrument at turn tail when — and only when — it is the cheaper or the only
 * path forward. THREE independent reasons, silent when NONE applies (an advisory
 * nobody can act on is noise):
 *
 *  - pressure-relief: at the ADVISORY pressure tier, broad remaining exploration
 *    or verification is cheaper in a child session than in a window already
 *    under advisory pressure. An orthogonal economic ask — always its own clause.
 *  - independence-debt: high-risk `must` atoms reached close with no independent
 *    read at grade. The atom-named "an independent read is owed" ask; it names the
 *    count and enumerates the atoms so the model can perceive (thus steer on) the gap.
 *  - review-debt-closure: with open review debt, a `review_request` is the one
 *    `independent`-perspective receipt the model cannot mint for itself.
 *
 * FOLD (RFC Open Question 3): independence-debt is the finer, atom-named form of
 * the review-debt ask, so when it is live it SUBSUMES the coarser review-debt line
 * — the two never render the same ask twice. Both the line and the stub lead with
 * independence when it applies (and the caller's cadence key does too, so what the
 * model reads and what telemetry keys agree). pressure-relief never folds.
 *
 * Inform-only — it derives NO gate (the sole gate stays the operator-promoted
 * verification-gate manifest). Lowest salience: an instrument suggestion sits
 * below the pressure/requirement postures it complements, so it demotes first
 * under budget. Suppression that would make the advisory recommend an action the
 * parallel gate will refuse (pending delegation, exhausted budget, no store)
 * lives in the caller (`buildDelegationAdvisorySection`), not here — this
 * renderer is a pure function of its three reasons.
 */
export function renderDelegationAdvisorySection(
  input: DelegationAdvisoryInput,
): RuntimeBriefSection | null {
  const independenceDebtCount = input.independenceDebtAtoms.length;
  const independenceDebt = independenceDebtCount > 0;
  if (!input.pressureRelief && !input.reviewDebtClosure && !independenceDebt) {
    return null;
  }
  const parts: string[] = [];
  if (input.pressureRelief) {
    parts.push(
      "broad remaining exploration or verification is cheaper in a child session than in a window already under advisory pressure",
    );
  }
  if (independenceDebt) {
    // Name the count AND enumerate the atoms (RFC information-channel thesis: the
    // model steers only on a gap it can perceive). All atoms are listed — under
    // budget the whole section demotes to its count-only stub, so the list is never
    // truncated mid-structure.
    parts.push(
      `${independenceDebtCount} high-risk must-atom(s) have no independent read at grade ` +
        `(${input.independenceDebtAtoms.join(", ")}) — a fresh-context review is the ` +
        "perspective you cannot mint on your own work",
    );
  }
  // Fold (RFC Open Question 3, resolved by this feature's own independent review):
  // independence debt is the finer, atom-named form of "an independent read is
  // owed", so when it is live it SUBSUMES the coarser tape-derived review-debt line
  // — the two never render the same ask twice. This matches the stub, which already
  // leads with independence; folding the line too avoids the odd "two asks at full,
  // one ask when demoted" shape. pressure-relief stays independent (an orthogonal
  // economic reason, not the same ask).
  if (input.reviewDebtClosure && !independenceDebt) {
    parts.push(
      "open review debt closes with a `review_request` — the one independent-perspective receipt you cannot mint for yourself",
    );
  }
  return {
    key: "delegation",
    salience: "low",
    line: `delegation: ${parts.join("; ")}`,
    // Independence debt names specific high-risk atoms, so it leads the stub over
    // the coarser review-debt / pressure fallbacks when it is the live reason. The
    // stub carries the COUNT but not the atom list — it is the budget-demoted form,
    // so it stays compact; the full line above enumerates the atoms.
    stub: independenceDebt
      ? `delegation: ${independenceDebtCount} high-risk must-atom(s) owe an independent read at grade`
      : input.reviewDebtClosure
        ? "delegation: `review_request` closes open review debt"
        : "delegation: a child session can relieve context pressure",
  };
}

export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) {
    return "0";
  }
  return count >= 1000 ? `${Math.round(count / 1000)}k` : `${Math.trunc(count)}`;
}
