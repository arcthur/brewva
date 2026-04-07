# Skill Routing

This document describes how Brewva routes tasks to skills and how skills
transition to one another during a session. It is the canonical reference for
routing philosophy; deterministic routing logic lives in scripts and runtime
context providers, not in this prose.

## Three Routing Mechanisms

Brewva uses three cooperating mechanisms. None works alone.

| Mechanism                                          | When it fires                                                | What it decides                                                         |
| -------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| **Skill-first recommendation** (runtime, per-turn) | Every turn when no skill is active                           | "Which skill best matches the current prompt and task spec?"            |
| **Routing context provider** (runtime, per-turn)   | When no skill is active and at least one skill has completed | "Given what has been produced so far, which skills are unblocked next?" |
| **Selection metadata** (frontmatter, design-time)  | During recommendation scoring                                | "Under what conditions should this skill be considered?"                |

Skill-first recommendation handles cold starts (first skill selection).
Routing context handles warm transitions (next skill after completion).
Selection metadata is the data substrate for both.

## Phase Lifecycle

Every task moves through phases. Skills declare which phases they serve via
`selection.phases` in their frontmatter.

```
align ──→ investigate ──→ execute ──→ verify ──→ done
  │            │              │          │
  └── blocked ←┘──── blocked ←┘── blocked┘
```

| Phase         | Purpose                                          | Typical skills                         |
| ------------- | ------------------------------------------------ | -------------------------------------- |
| `align`       | Frame the problem, challenge scope, set strategy | discovery, strategy-review             |
| `investigate` | Understand the repository, research approaches   | repository-analysis, learning-research |
| `execute`     | Design, implement, iterate                       | design, implementation, goal-loop      |
| `verify`      | Review, QA, ship-readiness                       | review, qa, ship                       |
| `blocked`     | Escalation, debugging, forensics                 | debugging, runtime-forensics           |
| `done`        | Retrospective, knowledge capture                 | retro, knowledge-capture               |

Phase membership is a routing signal, not a hard gate. A skill can activate
outside its declared phases when the model has strong evidence.

## Consumption Graph

Skills declare `consumes` and `requires` in their frontmatter. These define
a directed graph of artifact flow:

```
discovery ──→ strategy-review ──→ design ──→ implementation ──→ review ──→ ship
  │                                  │              │               │
  │  problem_frame                   │  design_spec │  change_set   │  review_report
  │  user_pains                      │  exec_plan   │  files_changed│  merge_decision
  │  scope_recommendation            │  risk_register│  verification │
  │  design_seed                     │              │  _evidence     │
  └──────────────────────────────────┘              └───────────────┘
```

A skill is **consumption-ready** when all of its `requires` outputs exist in
the session and at least one of its `consumes` outputs exists.

A skill is **consumption-blocked** when any of its `requires` outputs are
missing.

The routing context provider computes consumption readiness per turn and
surfaces it to the model. The model does not need to compute this manually.

## Transition Heuristics

### After skill completion

When a skill completes via `skill_complete`, the routing context provider:

1. Lists the newly available output keys.
2. Identifies skills that became consumption-ready.
3. Surfaces the top candidates ordered by: full `requires` satisfaction first,
   then number of satisfied `consumes`, then phase alignment.

The model should prefer the highest-ranked candidate unless the user's intent
or task spec clearly points elsewhere.

### Escalation transitions

Some transitions are escalations, not progressions:

| From           | To                | Trigger                                                             |
| -------------- | ----------------- | ------------------------------------------------------------------- |
| Any skill      | debugging         | Unexpected failure, test regression, unclear root cause             |
| Any skill      | runtime-forensics | Runtime crash, artifact corruption, session anomaly                 |
| goal-loop      | design            | 3+ consecutive `below_noise_floor` iterations                       |
| implementation | design            | Scope drift detected (files_changed exceeds implementation_targets) |
| review         | implementation    | Findings require code changes before merge                          |
| qa             | debugging         | QA failure with unclear root cause                                  |

Escalations bypass the normal consumption graph. The model should name the
escalation trigger when switching.

### Return transitions

After an escalation resolves, the model should return to the skill that
triggered the escalation, not restart the lifecycle. The routing context
preserves the session's completion history to support this.

## Canonical Lifecycle Chains

### Feature development (full)

```
discovery → strategy-review → design → implementation → review → qa → ship
```

### Bug fix

```
debugging → implementation → review → qa
```

### Investigation / research

```
discovery → learning-research → knowledge-capture
```

### Performance optimization (iterative)

```
design → goal-loop → [implementation ↔ review] → ship
```

### Repository onboarding

```
repository-analysis → discovery → design
```

Not every task uses every skill. The shortest chain that satisfies the task
is the correct chain.

## Anti-Patterns

| Anti-pattern                                                          | Why it fails                                                                        |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Skipping `design` and jumping to `implementation` on complex tasks    | No design_spec means no scope boundary, no risk register, no implementation_targets |
| Running `review` without `verification_evidence`                      | Review cannot assess merge readiness without execution evidence                     |
| Restarting the lifecycle after an escalation                          | Wastes completed artifacts; return to the interrupted skill instead                 |
| Loading a skill "just in case" without checking consumption readiness | Skill will lack required inputs and produce shallow outputs                         |
| Ignoring routing context recommendations                              | The consumption graph reflects actual artifact availability, not opinion            |

## Relationship to `skill-first.ts`

`skill-first.ts` scores skills by matching prompt tokens, task spec, selection
examples, phase alignment, and path patterns. It runs every turn and produces
the `[Brewva Skill-First Policy]` block.

The routing context provider is complementary: it focuses on **what has already
been produced** rather than what the prompt says. Together they cover cold
starts (skill-first) and warm transitions (routing context).

When both recommend the same skill, confidence is high. When they disagree,
the model should prefer the routing context for lifecycle transitions and
skill-first for fresh tasks.
