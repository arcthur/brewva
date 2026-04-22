# Skill Routing

Implementation anchors:

- `packages/brewva-gateway/src/runtime-plugins/skill-first.ts`
- `packages/brewva-gateway/src/runtime-plugins/hosted-context-injection-pipeline.ts`
- `packages/brewva-tools/src/skill-load.ts`
- `packages/brewva-tools/src/workflow-status.ts`
- `packages/brewva-runtime/src/services/skill-lifecycle.ts`

This document describes how Brewva routes tasks to skills and how skills
transition to one another during a session. It is the canonical reference for
routing philosophy; deterministic behavior lives in hosted runtime plugins,
runtime inspect/tool surfaces, and skill contract parsing, not in this prose.

`docs/reference/skills.md` owns contract metadata, routing-scope
configuration, and explicit activation semantics. This page owns the turn-level
recommendation and transition heuristics built on top of those contracts.

Routing remains explicit:

- Brewva may recommend a skill
- Brewva does not auto-activate the next skill
- the model or operator still switches through `skill_load`

## Three Routing Mechanisms

Brewva uses three cooperating mechanisms. None works alone.

| Mechanism                                                        | When it fires                                               | What it decides or exposes                                               |
| ---------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Skill-first diagnosis** (hosted control plane, per-turn)       | Every hosted turn when no skill is active                   | "Which skill best matches the current prompt, task spec, and readiness?" |
| **Artifact-aware transition surfaces** (runtime inspect + tools) | On demand after prior skill outputs or workflow state exist | "What inputs, artifacts, and posture are available for the next skill?"  |
| **Selection metadata** (frontmatter, design-time)                | During recommendation scoring                               | "Under what conditions should this skill be considered?"                 |

Skill-first diagnosis handles cold starts (first skill selection).
Artifact-aware transition surfaces handle warm transitions (next skill after
completion).
Selection metadata is the data substrate for cold-start diagnosis. A
directory-derived `routing.scope` is only scope provenance; it is not sufficient
for routability. A skill is routable only when routing is enabled, its scope is
included in `skills.routing.scopes`, and `selection` declares at least one of
`when_to_use`, `examples`, `paths`, or `phases`.

There is no authored `routable` field. `skills_index.json` exposes generated
`routable` state for inspection only.

## Phase Lifecycle

Every task moves through phases. Skills may declare which phases they serve via
`selection.phases` in their frontmatter.

```
align ──→ investigate ──→ execute ──→ verify ──→ ready_for_acceptance ──→ done
  │            │              │             │                    │
  └── blocked ←┘──── blocked ←┘──── blocked ←┘──────── blocked ←┘
```

| Phase                  | Purpose                                          | Typical skills                         |
| ---------------------- | ------------------------------------------------ | -------------------------------------- |
| `align`                | Frame the problem, challenge scope, set strategy | discovery, strategy-review             |
| `investigate`          | Understand the repository, research approaches   | repository-analysis, learning-research |
| `execute`              | Design, implement, iterate                       | design, implementation, goal-loop      |
| `verify`               | Review, QA, and evidence gathering               | review, qa                             |
| `ready_for_acceptance` | Final go/no-go and release posture               | ship                                   |
| `blocked`              | Escalation, debugging, forensics                 | debugging, runtime-forensics           |
| `done`                 | Retrospective, knowledge capture                 | retro, knowledge-capture               |

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

A skill is **available** when no `requires` output is missing, but no declared
`consumes` output has materialized.

For semantic-bound artifacts, these checks run against normalized consumed
outputs rather than raw producer payloads. A target skill may therefore see:

- raw upstream output present but normalized data still partial
- named blocking consumers for Tier B fields that remain unresolved
- non-blocking Tier C drift that should inform judgment but not stop routing

Runtime exposes the relevant warm-transition data through explicit surfaces:

- `runtime.inspect.skills.getReadiness(sessionId, query?)` exposes structured
  `blocked` / `available` / `ready` candidate posture and deterministic scores
- `skill_load` previews `availableConsumedOutputs` for the chosen candidate skill
- `workflow_status` surfaces derived workflow posture and `skillReadiness`
- `runtime.inspect.skills.getConsumedOutputs(sessionId, targetSkillName)` exposes the exact consumed-output materialization for a target skill

Missing `requires` never hard-blocks `skill_load`; the load output renders the
blocked posture and the missing required inputs. `composable_with` remains a
separate lifecycle gate for concurrent skill activation.

These surfaces inform the next choice; they do not auto-switch skills.

## Transition Heuristics

### After skill completion

When a skill completes via `skill_complete`:

1. Brewva records durable `skill_completed` outputs for that session.
2. Candidate next skills can inspect matching prior outputs through
   `runtime.inspect.skills.getReadiness(...)`, `skill_load`, and
   `runtime.inspect.skills.getConsumedOutputs(...)`.
3. `workflow_status` reflects the derived artifact and posture state, which is
   often a better warm-transition signal than prompt text alone.

The model should usually prefer a candidate whose `requires` are fully
satisfied and whose `consumes` now materialize concrete prior outputs, unless
the user's intent or task spec clearly points elsewhere.
Hosted skill diagnosis applies the same rule inside the semantic shortlist:
`ready` candidates outrank `available`, `unknown`, and `blocked` candidates for
the selected position, so a nearby actionable skill is not hidden behind a
blocked semantic leader.

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
triggered the escalation, not restart the lifecycle. Session outputs and
durable `skill_completed` history preserve enough context to resume the
interrupted chain explicitly.

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

`knowledge-capture` in this chain names the skill. The explicit repository
materialization tool remains `knowledge_capture`.

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
| Ignoring `workflow_status` or consumed-output signals                 | Prompt-only routing misses the artifacts and posture already produced               |

## Relationship to `skill-first.ts`

`packages/brewva-runtime/src/context/skill-routing.ts` uses produced skill
outputs, `requires`, and `consumes` to classify candidates as `blocked`,
`available`, or `ready`, then ranks non-blocked candidates for the warm
skill-routing context.

`packages/brewva-gateway/src/runtime-plugins/skill-first.ts` scores only the
routable names reported by the runtime load report. It matches prompt tokens,
TaskSpec content, optional `selection.when_to_use`, selection examples, phase
alignment, and path patterns. It runs on hosted turns when no skill is active
and may produce the `[Brewva Skill-First Policy]` block.

Warm transitions remain model-native decisions, but they are informed by
structured runtime readiness, `workflow_status`, consumed outputs, and the
current session artifact state.

In practice:

- prefer `skill-first` for cold starts and fresh tasks with no prior outputs
- prefer artifact-aware state for warm transitions after one or more skills have completed
