# Skill Anatomy v2

This is the canonical reference for writing and rewriting Brewva skills.

## Foundational Principle

**Violating the letter of these rules is violating the spirit of these rules.**

## Three Content Types

Before writing anything, classify every piece of content:

| Type              | Where it lives | Examples                                                                           |
| ----------------- | -------------- | ---------------------------------------------------------------------------------- |
| **Deterministic** | `scripts/`     | Classification logic, validation, routing, convergence checks, payload constraints |
| **Judgment**      | SKILL.md body  | When to ask, how to rank, what to recommend, when to stop                          |
| **Knowledge**     | `references/`  | Taxonomies, schema tables, protocol details, field definitions (100+ lines)        |

If content is deterministic, it MUST be a script. Do not describe executable
logic in prose and ask the Agent to "follow" it.

## SKILL.md Anatomy

```
YAML frontmatter (contracts, effects, resources, output_contracts — unchanged)

# Skill Name

## The Iron Law
## When to Use / When NOT to Use
## Workflow
## Scripts
## Decision Protocol
## Red Flags — STOP
## Common Rationalizations
## Concrete Example
## Handoff Expectations
## Stop Conditions
```

### Body limit: 150 lines (excluding frontmatter)

If the body exceeds 150 lines, content must move to `references/` or
`scripts/`. Tables, schema definitions, and protocol details are the first
candidates for extraction.

## Section Patterns

### The Iron Law

One hard rule in a code block. No exceptions, no softening.

```
NO MERGE DECISION WITHOUT EVIDENCE FROM EVERY ACTIVATED LANE
```

The Iron Law captures the single most important constraint. If the Agent
remembers nothing else, it must remember this.

### When to Use / When NOT to Use

Bullet lists of concrete triggers and counter-triggers. Match the frontmatter
`selection.when_to_use` but add the negative case.

### Workflow

Numbered phases with **explicit failure branches**.

### Phase 1: Reproduce the failure

Capture the failing command, first error line, and affected boundary.

**If not reproducible**: Stop. Record the gap. Do not guess.
**If reproducible**: Proceed to Phase 2.

### Step 1: Reproduce the failure

Capture the failing command, first error line, and affected boundary.

### Step 2: Rank hypotheses

Every phase-to-phase transition must say what happens on failure.

### Scripts

List each script with its purpose and invocation. The Agent calls scripts
for deterministic work; it does not re-implement the logic mentally.

```markdown
## Scripts

- `scripts/activate-lanes.py` — Input: change_categories JSON, changed_file_classes JSON.
  Output: activated lane list. Run before Step 2.
- `scripts/synthesize-dispositions.py` — Input: lane outcomes array.
  Output: merge_decision. Run after all lanes report.
```

### Decision Protocol

Judgment-only guidance. Questions the Agent should ask itself, ranking
heuristics, classification criteria that genuinely require reasoning.

Use concrete questions, not vague instructions:

- What user-visible behavior can fail now that could not fail before? - Which contract does the diff rely on without proving?
- Review for architecture issues. - Check whether the root cause is clear.

### Red Flags — STOP

Self-check triggers. When the Agent catches itself thinking any of these,
it must stop and return to an earlier phase.

```markdown
## Red Flags — STOP

If you catch yourself thinking any of these, STOP and return to Phase 1:

- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "I don't fully understand but this might work"
- "One more fix attempt" (when already tried 2+)
```

### Common Rationalizations

Excuse/reality table. Preempt the model's shortcuts by naming them explicitly.

```markdown
| Excuse                                  | Reality                                                              |
| --------------------------------------- | -------------------------------------------------------------------- |
| "Issue is simple, don't need process"   | Simple issues have root causes too. Process is fast for simple bugs. |
| "Emergency, no time for process"        | Systematic debugging is FASTER than guess-and-check thrashing.       |
| "Just try this first, then investigate" | First fix sets the pattern. Do it right from the start.              |
```

Build this table from observed failures. Every rationalization a model uses
during eval testing becomes a new row.

### Concrete Example

One excellent example with actual artifact content. Not just artifact names.

Input: "Debug why cascade events stop reconciling after session replay."

Output:

```json
{
  "root_cause": "ReplayService emits events with stale session epoch. Cascade reconciler skips events where epoch < current, causing silent drop after replay completes.",
  "fix_strategy": "Pin epoch to post-replay value in ReplayService.finalize(). Add epoch assertion in CascadeReconciler.accept().",
  "investigation_record": {
    "hypotheses_tested": [
      {
        "id": 1,
        "claim": "Reconciler crash on malformed event",
        "status": "falsified",
        "evidence": "No error in event log"
      },
      {
        "id": 2,
        "claim": "Stale epoch after replay",
        "status": "confirmed",
        "evidence": "Event epoch=3, current=5"
      }
    ],
    "failed_attempts": [],
    "root_cause_boundary": "packages/brewva-runtime/src/services/replay.ts"
  }
}
```

Input: "Debug this regression."

Output: `root_cause`, `fix_strategy`, `investigation_record`.

### Handoff Expectations

What downstream skills must learn from each artifact. Keep this section
from the existing skills — it is already well-written in most cases.

### Stop Conditions

Concrete conditions. Not "when things are unclear" but "when the issue
cannot be reproduced with current information".

## Description Field Rules (CSO)

The YAML `description` and `selection.when_to_use` fields are trigger
conditions ONLY. Never summarize the workflow.

Testing revealed that when a description summarizes workflow, the model
follows the description instead of reading the skill body. A description
that says "multi-lane review with fan-out" causes the model to attempt
fan-out without reading the lane activation rules.

```yaml
# BAD: Summarizes workflow — model may skip body
description: Assess change risk through multi-lane fan-out and merge safety synthesis.

# GOOD: Trigger conditions only
description: Use when a diff or change plan needs risk review, merge readiness, or conformance checking.
```

## Script Design Rules

1. Scripts take structured input (JSON on stdin or CLI args) and produce
   structured output (JSON on stdout).
2. Scripts are deterministic — same input always produces same output.
3. Scripts handle their own error cases and return structured error JSON.
4. Scripts are executable (`chmod +x`) and declare their interpreter.
5. SKILL.md tells the Agent WHEN to call the script. The script does the WHAT.

## What NOT to Do

- Contract-only skeletons that describe outputs but not behavior
- Giant inline tables that belong in `references/`
- Pseudocode in Markdown that should be an actual script
- Vague instructions like "be thorough" or "interrogate the proposal"
- Examples that list artifact names without showing content
- Workflow steps without failure branches
- Description fields that summarize the workflow
