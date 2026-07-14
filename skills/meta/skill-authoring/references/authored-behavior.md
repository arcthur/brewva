# Authored Behavior Patterns

High-quality skills need more than frontmatter metadata.

The SkillCard tells Brewva when advisory context may be useful. The
ProducerContract tells Brewva which artifacts the skill can emit. Capability
manifests tell Brewva which external actions may be authorized. The skill body
tells the model how a capable specialist should behave while doing the work.
Strong skills keep those boundaries separate.

A skill's rules are tiered (see the anatomy's rule manifest): non-negotiable
rules admit no self-exemption; controlled-exception rules may be deviated
from with cited evidence; adaptive heuristics are the model's to tune. The
two behavior rules below — deviation with evidence, and reality arbitration —
apply across every skill.

## v3 Anatomy Reference

For the canonical kernel/scaffold structure, content-type classification
(deterministic / judgment / knowledge), the rule manifest and its three
tiers, wording registers, and the validator authority ceiling, see
`references/skill-anatomy-v3.md`.

The patterns below remain valid and complement the v3 anatomy. Skills should
use both: v3 anatomy for structure, authored-behavior patterns for specialist
depth.

## Deviation With Evidence

Skills are advisory; their force is in their wording. That force is
calibrated, not absolute:

- A `non-negotiable` rule (permissions, external side effects, secrets,
  persisted formats, honesty-of-claims) is never self-exempted. If it seems
  wrong, escalate — do not deviate.
- A `controlled-exception` rule may be deviated from, but the deviation is a
  commitment and leaves a receipt: declare it in the produced artifact,
  citing the `ruleId` and the evidence class its manifest entry requires (or
  an explicit operator approval). An exception needs evidence, not
  eloquence. A silent skip is not a deviation; it is a violation.
- An `adaptive-heuristic` is the model's to tune. State nothing beyond what
  the work itself shows; no disclosure ritual.

Cited `ruleId`s make deviations attributable inside produced artifacts and
fixture-countable in the current self-eval harness. Tape-level conduct
accounting is deliberately deferred until a typed receipt can bind the
selection, rule, disposition, and evidence references; free-text grep is not
retirement evidence.

## Reality Arbitration

When skill text and observed reality disagree, arbitrate by the kind of
claim, not by which document is louder:

- **Descriptive claims** (paths, behavior descriptions, "the usual root
  cause is X" experience claims): authoritative code/runtime evidence wins.
  Proceed on the evidence and route the contradiction to `self-improve` as a
  candidate correction — a stale claim left in place misleads the next
  session.
- **Normative rules** (safety boundaries, project invariants, protocol
  requirements): observing the rule being violated in the codebase is not
  evidence the rule is wrong — the code may be the regression. A normative
  conflict escalates (the live `question` tool, or a `self-improve`
  candidate); it is never silently overridden in either direction.

Evidence refutes claims; it does not repeal rules.

## What To Encode In The Skill Body

Prefer explicit sections for the following behavior:

### Role Posture

State what kind of specialist the skill is acting as and what it should care
about most.

Examples:

- A planning skill should optimize for bounded decisions and implementation
  readiness, not abstract architecture theater.
- A review skill should optimize for behavioral risk and merge safety, not code
  style commentary.

### Interaction Protocol

Document when the skill should ask questions, when it should proceed on
reasonable assumptions, and how it should re-ground the user when context may be
stale.

Good interaction rules are:

- ask only when the answer changes correctness or the primary path
- provide one recommended path plus one bounded alternative
- avoid open-ended brainstorming once the task is execution-ready

For interactive operator-facing skills, make the blocking path explicit:

- if the current turn is blocked on a missing operator or user decision, use the
  live `question` tool
- reserve `open_questions` or similar output artifacts for non-blocking,
  downstream uncertainty
- do not hide a blocking decision inside prose, a risk register, or a deferred
  follow-up list

### Decision Protocol

Explain how the skill should make choices, not just what outputs it should
produce.

Examples:

- compare 1-3 viable approaches, then choose one
- rank hypotheses and falsify the strongest first
- classify findings by severity and decide whether the next action is fix,
  redesign, or block

### Question-Driven Analysis

When a skill depends on real judgment, convert vague instructions into concrete
questions that focus attention on the right evidence.

Weak:

- review for architecture issues
- check whether the root cause is clear
- ensure the extracted payload is valid

Stronger:

- what user-visible behavior can fail now that could not fail before?
- what single condition must be true for this failure to occur?
- which required field is unsupported by source evidence and therefore should stay null?

Questions work especially well for review, debugging, extraction, and release
audits because they force the model to search for evidence instead of producing
generic commentary.

### Confirmation Gates

If a skill may cross an approval or side-effect boundary, encode an explicit
confirmation gate instead of relying on a vague "be careful" instruction.

Good confirmation gates:

- restate repo, object, and action before a GitHub write
- restate release path before calling something ready to ship
- stop at a draft artifact when the user did not clearly request mutation

Use hard gates for low-reversibility actions, and softer "ask only when" rules
for ordinary ambiguity.

### Handoff Expectations

Every output should make the next skill easier to run.

Document what downstream consumers must learn from each artifact. A weak
ProducerContract rejects placeholders; a strong handoff section tells the model
what the artifact must contain to be useful.

Examples:

- `design_spec` should expose boundaries, non-goals, affected modules, and the
  chosen path
- `verification_evidence` should preserve commands, diagnostics, and observed
  outcomes so debugging or review can continue without re-deriving context
- `review_findings` should identify condition, impact, evidence, and expected
  next action

### Completion And Escalation

State what counts as done, when to stop, and when to escalate instead of
guessing.

Useful escalation rules include:

- stop when the real problem is a different skill territory
- stop when required evidence is unavailable
- stop when the remaining decision belongs to the user or an approval boundary

### Delivery Checklists

For output-heavy skills, add a short final checklist when consistency matters
more than creative freedom.

Good checklist targets:

- UI specs that implementation will follow directly
- release decisions with gating evidence
- structured payloads that downstream tools will parse

The checklist should stay concrete and observable. Avoid slogans like
"ensure quality" when you really mean "all required states are specified."

## Good Skill Structure

For behavior-rich skills, a practical structure is:

1. Intent
2. Trigger
3. Workflow
4. Interaction Protocol
5. Decision Protocol
6. Handoff Expectations
7. Stop Conditions
8. Anti-Patterns
9. Example

Optional add-ons when the domain needs them:

- Question Set
- Confirmation Gate
- Delivery Checklist

Not every skill needs every section, but core skills should generally have at
least explicit interaction, decision, and handoff guidance.

## Overlay Inheritance

Project overlays (`skills/project/overlays/<name>/`) tighten a base skill for a
specific codebase. They do not replace the base skill's authored behavior.

Inheritance rules:

- **Questions, gates, and checklists** from the base skill apply automatically.
  An overlay does not need to repeat them.
- An overlay should add only the **project-specific delta**: questions that
  reference project boundaries, gates that check project invariants, or
  checklists that enforce project conventions.
- If a base-skill gate or checklist is genuinely irrelevant for the project
  context, the overlay may explicitly note the exemption and why.
- An overlay must not weaken a base-skill gate. It may tighten one by adding
  project-specific items.

Example: the base `review` skill has a Merge Readiness Gate. The Brewva review
overlay adds project-specific review questions about package boundaries and
branding consistency, but does not restate the merge gate — the base gate still
applies.

## Cross-Skill Anti-Rationalizations

These excuses apply across all skills. Every skill activation should resist
them. Rows are accountable inventory, not permanent law: per the anatomy's
scaffold rules, a row unfired across consecutive calibration windows on
current-tier models enters the retirement watchlist.

| Excuse                                       | Reality                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| "This skill doesn't apply to my task"        | Check the selection criteria. If ambiguous, prefer the smallest advisory context and do not infer tool authority from a skill.  |
| "I'll skip the skill and just do the work"   | Skills encode hard-won failure modes. If a rule does not fit, deviate with a cited `ruleId` and evidence — never skip silently. |
| "I know the answer, the process is overhead" | The evidence obligations are the non-negotiable part. The path to the evidence is yours to choose; the evidence itself is not.  |
| "The user wants speed, not process"          | Speed pressure never waives a non-negotiable rule — it is a legitimate reason to declare a controlled exception, with evidence. |

## What To Avoid

- metadata-only skeletons that describe outputs but not working behavior
- giant host-specific preambles inside every skill
- vague instructions such as "be thorough" without a concrete protocol
- duplicating runtime authority in skill prose

## Memory Nudge

When a skill completes work that produces reusable insight, the model should
actively consider whether the lesson belongs in a workbench note or durable
knowledge capture.

Good memory candidates:

- a verification strategy that worked reliably in this repository
- a user preference or collaboration pattern observed across interactions
- a recurring failure mode and its proven fix
- a constraint or convention that was not obvious from code alone

The `deliberation_memory` tool is read-only inspection. Memory artifacts are
derived automatically from durable evidence such as producer outputs,
verification outcomes, iteration facts, and task specs. The model does not need
to write memory explicitly. But the model should use `self-improve` or `retro`
to surface lessons worth preserving, because those producer outputs feed the
derivation pipeline.

Do not treat every observation as a systemic lesson. One-off findings stay in
producer outputs; only repeated, evidence-backed patterns earn long-term memory.

## Brewva-Specific Boundary

Absorb authored-behavior patterns aggressively, but keep kernel authority in the
runtime:

- skills may suggest next actions, but they do not create a runtime-owned stage
  machine
- skills may describe approval-sensitive choices, but `effect_commitment`
  remains the proposal boundary
- skills may describe SaaS, CLI, or MCP workflows, but capability selection
  remains the only action authority boundary
- skills should improve specialist behavior without reintroducing hidden control
  loops
