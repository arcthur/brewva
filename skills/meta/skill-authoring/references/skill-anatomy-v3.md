# Skill Anatomy v3

This is the canonical reference for writing and rewriting Brewva skills.

## Foundational Principle

SkillCards are advisory (authority posture `none`), so a skill's entire
constraint force comes from the normative power of its wording — the wording
IS the governance. v3 therefore separates what a skill says by how it ages:

- **Kernel** — content that appreciates as models get stronger: the trigger
  surface (description), non-derivable domain and project facts,
  external-effect gates, honesty contracts, handoff expectations, and outcome
  boundaries. The kernel is the SKILL.md body: short, stable, and true for
  any model.
- **Scaffold** — countermeasures for observed model deficits: step workflows,
  count budgets, rationalization tables, detailed checklists. Scaffolds live
  in `references/` (the lazy-loading layer), name the failure mode they
  counter, and earn default-loading only while paired evaluation shows they
  help. Strict-era material is relocated into scaffolds, never deleted.
- **Deterministic capability** — `scripts/` and `invariants/` that read the
  world or apply stable rule sets, unchanged from v2.

Govern effects, not thought paths: a kernel states what must be true and
what must never happen; a scaffold suggests how a model with known weak spots
should get there. Only the first is written in absolute register.

## Three Content Types (unchanged from v2)

| Type                               | Where it lives | Examples                                                                           |
| ---------------------------------- | -------------- | ---------------------------------------------------------------------------------- |
| **Executable deterministic logic** | `scripts/`     | Classification logic, validation, routing, convergence checks, payload constraints |
| **Read-only deterministic rules**  | `invariants/`  | Rule tables, gates, classifiers, and schemas for skills without `local_exec`       |
| **Judgment**                       | SKILL.md body  | When to ask, how to rank, what to recommend, when to stop                          |
| **Knowledge**                      | `references/`  | Taxonomies, schema tables, protocol details, scaffolds, large tables               |

## The Rule Manifest

Every load-bearing rule in a skill gets a stable identity, a tier, and — for
controlled exceptions — the evidence class an exception must cite. Rules,
receipts, calibration, and any future strictness profile all bind to the
`ruleId`. The manifest lives in a `## Rules` section of the SKILL.md body.

### Three tiers

1. `non-negotiable` — permissions, external side effects, secrets, persisted
   formats, honesty-of-claims. No self-exemption; wording stays absolute.
2. `controlled-exception` — high-impact cognitive process rules (root-cause
   before a shipped fix, precedent consult before high-risk planning,
   independent review before release). Exceptions are legal but must cite
   the `ruleId` plus the manifest's required evidence class, or explicit
   operator approval — an exception needs evidence, not eloquence.
3. `adaptive-heuristic` — fanout width, retrieval depth, hypothesis count,
   step budgets. The model tunes freely; the skill states the default and
   why. No disclosure obligation (mandatory disclosure here would be new
   ritual).

### Manifest grammar

One bullet per rule inside `## Rules`:

```markdown
## Rules

- `debugging.confirmed-cause-before-shipped-fix` (controlled-exception) — No
  shipped fix without a confirmed root cause. Exception evidence: a probe
  receipt (declared hypothesis, expected observation, revert) or explicit
  operator approval.
- `debugging.no-fabricated-evidence` (non-negotiable) — Never present
  unverified speculation as observed fact.
- `debugging.active-hypothesis-count` (adaptive-heuristic) — Default: as many
  active hypotheses as you can name a next falsification step for.
```

- `ruleId` is `<skill-name>.<rule-slug>`, kebab-case segments joined by a
  dot; it never changes once receipts may reference it (retire and mint a
  new id instead of renaming).
- The tier sits in parentheses immediately after the backticked id.
- A `controlled-exception` rule MUST contain an `Exception evidence:` clause
  naming the evidence class (receipt kind, artifact, or operator approval).
- An `adaptive-heuristic` rule SHOULD state its default with a `Default:`
  clause and the reason the default is what it is.

`quick_validate.py` and the rule-manifest fitness enforce this grammar. A
deviation from a `controlled-exception` rule is declared in the produced
artifact citing the `ruleId` — that citation is what makes deviations
countable from the tape.

## SKILL.md Kernel Anatomy

```markdown
YAML frontmatter (SkillCard only: name, description, selection, references, scripts, invariants)

# Skill Name

## The Iron Law

## When to Use / When NOT to Use

## Workflow

## Rules

## Invariants or Scripts

## Decision Protocol

## Handoff Expectations

## Stop Conditions
```

`## Rules` is required once a skill's rules carry receipts (the pilot skills
first, the corpus as it migrates). `## Red Flags` and
`## Common Rationalizations` are scaffold material in v3: keep them only as
one-line links into `references/`, or move the content there outright. The
Concrete Example section stays a one-line link to `references/example.md`.

### Body limit: 150 lines (excluding frontmatter)

The kernel target is well under the limit; if the body approaches 150 lines,
workflow detail or tables belong in a scaffold reference.

## Section Patterns

### The Iron Law

One hard rule in a code block, and it must be classifiable: an Iron Law is
either `non-negotiable` (safety, honesty, external effects — absolute
register is correct) or `controlled-exception` (a discipline default — the
law text itself names the legal exception path). Do not write an efficiency
heuristic in non-negotiable register; the model cannot tell calibrated
defaults from safety boundaries unless the wording distinguishes them.

```
NO SHIPPED FIX WITHOUT CONFIRMED ROOT CAUSE — probes are legal: declare the
hypothesis and expected observation, revert after.
```

### When to Use / When NOT to Use

Bullet lists of concrete triggers and counter-triggers. Match the SkillCard
`selection.when_to_use` when the skill is selectable, but add the negative
case.

### Workflow

Numbered phases with **explicit failure branches**. A failure branch repairs
the violated precondition and continues; it does not reset to Phase 1 unless
the earlier phases' outputs are actually invalidated.

Stop conditions are evidence conditions, not counters: "stop when the next
attempt would not be informed by anything new from the last one" (the
ci-iteration form), never "stop after N attempts". A count may survive as a
soft self-check trigger ("on the third attempt, ask what is new"), not as a
stop.

When a phase cannot proceed because the current turn is blocked on missing
operator or user input, the failure branch routes to the live `question`
tool. Do not defer a blocking ambiguity into `open_questions` or another
end-of-turn artifact.

### Rules

The rule manifest (grammar above). Keep the statement text short — the
workflow carries the how, the rule carries the what and the tier.

### Decision Protocol

Judgment-only guidance. Questions the Agent should ask itself, ranking
heuristics, classification criteria that genuinely require reasoning. Use
concrete questions, not vague instructions.

### Handoff Expectations

What downstream skills must learn from each artifact.

### Stop Conditions

Concrete conditions. Not "when things are unclear" but "when the issue
cannot be reproduced with current information AND tape/history evidence is
also exhausted".

## Scaffold Design Rules

1. A scaffold file names the failure mode it counters in its first paragraph
   ("models under time pressure guess-and-patch; this protocol counters
   that").
2. Scaffolds are loaded from the kernel by a conditional pointer, not pasted
   inline: "Under time pressure, after repeated failed fixes, or on a
   weak-model profile, load `references/strict-protocol.md` and follow it."
3. A scaffold carries its eval contract: it earns default-loading only while
   the three-arm paired eval (no-skill / kernel-only / kernel+scaffold)
   shows it helps; a strong-tier tax demotes it to on-demand.
4. Rationalization tables live in scaffolds, and every row carries
   provenance: the model generation and date it was observed on. A row
   unfired across consecutive calibration windows on current-tier models
   enters the retirement watchlist — tables are accountable inventories, not
   one-way accumulators.

## Wording Registers

- `non-negotiable`: absolute imperatives (`NEVER`, `NO X WITHOUT Y`). Safety,
  honesty, permissions, external effects only.
- `controlled-exception`: conditional imperatives — the rule text names its
  own exception path ("X requires Y, or a declared exception citing
  evidence Z").
- `adaptive-heuristic`: defaults with reasons ("Default: N, because ….
  Tune freely; the tape shows what you chose.").

## Validator Authority Ceiling

The first filter for a skill script: does its input contain any information
the model does not already possess? World-reading scripts (CI state, file
system, real source) pass. A validator over self-reported data (the model's
own JSON) may exist for format lint and durable state externalization, but it
carries an authority ceiling: **advisory lint at most — never cited as
independent evidence, never a phase gate, never sole authority for a
high-impact verdict.** A skill body must not instruct the model to treat a
self-report validator's output as a stop or escalation authority.

## Description Field Rules (CSO)

The YAML `description` and `selection.when_to_use` fields are trigger
conditions ONLY. Never summarize the workflow. Testing revealed that when a
description summarizes workflow, the model follows the description instead
of reading the skill body.

```yaml
# BAD: Summarizes workflow — model may skip body
description: Assess change risk through multi-lane fan-out and merge safety synthesis.

# GOOD: Trigger conditions only
description: Use when a diff or change plan needs risk review, merge readiness, or conformance checking.
```

Description trigger quality is measured, not assumed: pilot skills carry
should-trigger / should-not-trigger query sets in the eval assets.

## Script Design Rules

1. Scripts take structured input (JSON on stdin or CLI args) and produce
   structured output (JSON on stdout).
2. Scripts are deterministic — same input always produces same output.
3. Scripts handle their own error cases and return structured error JSON.
4. Scripts are executable (`chmod +x`) and declare their interpreter.
5. SKILL.md tells the Agent WHEN to call the script. The script does the
   WHAT.
6. The validator authority ceiling above applies: a self-report validator is
   advisory lint, and the skill body must say so where it references one.

## Invariant Design Rules

1. Invariants describe deterministic rules for skills that cannot execute
   local code.
2. Invariants define inputs, rules, and outputs explicitly.
3. Invariants never say "run this file"; they say "apply this rule set".
4. A numeric invariant (posture formulas, simplicity budgets) is an anchor,
   not a verdict: the model may override it with a one-line reason naming
   the divergence, and downstream triggers key on the final judgment, not
   the raw formula output.
5. If a future host runner turns an invariant into executable code, the
   skill must also gain the corresponding execution effect.

## What NOT to Do

- Contract-only skeletons that describe outputs but not behavior
- Efficiency heuristics written in non-negotiable register
- Count budgets as stop conditions (evidence conditions or soft self-checks)
- Self-report validators positioned as gates or escalation authority
- Giant inline tables that belong in `references/`
- Pseudocode in Markdown that should be an actual script
- Vague instructions like "be thorough" or "interrogate the proposal"
- Examples that list artifact names without showing content
- Workflow steps without failure branches
- Description fields that summarize the workflow
- `open_questions`-style artifacts used as a dumping ground for blocking
  ambiguity that should have triggered the live `question` tool
- Deleting strict material instead of relocating it into a scaffold
