---
name: design
description: Turn a request into a bounded design and executable plan, choosing the
  right implementation mode without over-designing trivial work.
stability: stable
intent:
  outputs:
    - design_spec
    - execution_plan
    - execution_mode_hint
    - risk_register
    - implementation_targets
  output_contracts:
    design_spec:
      kind: text
      min_words: 4
      min_length: 24
    execution_plan:
      kind: json
      min_items: 2
      item_contract:
        kind: json
        min_keys: 5
        required_fields:
          - step
          - intent
          - owner
          - exit_criteria
          - verification_intent
        field_contracts:
          step:
            kind: text
            min_words: 2
            min_length: 16
          intent:
            kind: text
            min_words: 2
            min_length: 16
          owner:
            kind: text
            min_words: 1
            min_length: 8
          exit_criteria:
            kind: text
            min_words: 3
            min_length: 20
          verification_intent:
            kind: text
            min_words: 3
            min_length: 20
    execution_mode_hint:
      kind: enum
      values:
        - direct_patch
        - test_first
        - coordinated_rollout
    risk_register:
      kind: json
      min_items: 1
      item_contract:
        kind: json
        min_keys: 6
        required_fields:
          - risk
          - category
          - severity
          - mitigation
          - required_evidence
          - owner_lane
        field_contracts:
          risk:
            kind: text
            min_words: 3
            min_length: 20
          category:
            kind: enum
            values:
              - authn
              - authz
              - credential_handling
              - secret_io
              - external_input
              - network_boundary
              - permission_policy
              - wal_replay
              - rollback
              - scheduler
              - queueing
              - async_ordering
              - cross_session_state
              - multi_writer_state
              - cli_surface
              - config_schema
              - public_api
              - export_map
              - persisted_format
              - wire_protocol
              - package_boundary
              - hot_path
              - indexing_scan
              - fanout_parallelism
              - queue_growth
              - artifact_volume
              - storage_churn
          severity:
            kind: enum
            values:
              - critical
              - high
              - medium
              - low
          mitigation:
            kind: text
            min_words: 3
            min_length: 20
          required_evidence:
            kind: json
            min_items: 1
            item_contract:
              kind: text
              min_words: 1
              min_length: 6
          owner_lane:
            kind: enum
            values:
              - review-correctness
              - review-boundaries
              - review-operability
              - review-security
              - review-concurrency
              - review-compatibility
              - review-performance
              - qa
              - implementation
              - operator
    implementation_targets:
      kind: json
      min_items: 1
      item_contract:
        kind: json
        min_keys: 4
        required_fields:
          - target
          - kind
          - owner_boundary
          - reason
        field_contracts:
          target:
            kind: text
            min_words: 1
            min_length: 8
          kind:
            kind: text
            min_words: 1
            min_length: 4
          owner_boundary:
            kind: text
            min_words: 1
            min_length: 8
          reason:
            kind: text
            min_words: 3
            min_length: 20
effects:
  allowed_effects:
    - workspace_read
    - runtime_observe
  denied_effects:
    - workspace_write
    - local_exec
resources:
  default_lease:
    max_tool_calls: 90
    max_tokens: 180000
  hard_ceiling:
    max_tool_calls: 130
    max_tokens: 240000
execution_hints:
  preferred_tools:
    - read
    - grep
  fallback_tools:
    - glob
    - lsp_symbols
    - lsp_find_references
    - ledger_query
    - skill_complete
references:
  - skills/meta/skill-authoring/references/authored-behavior.md
  - references/executable-evidence-bridge.md
  - references/oracle-consultation-protocol.md
  - references/plan-output-template.md
consumes:
  - problem_frame
  - user_pains
  - scope_recommendation
  - design_seed
  - open_questions
  - planning_posture
  - strategy_review
  - scope_decision
  - strategic_risks
  - repository_snapshot
  - impact_map
  - knowledge_brief
  - precedent_refs
  - preventive_checks
  - precedent_query_summary
  - precedent_consult_status
  - root_cause
  - runtime_trace
requires: []
---

# Design Skill

## Intent

Choose the minimum correct solution shape and turn it into an execution-ready plan.

## Trigger

Use this skill when:

- the task has multiple viable approaches
- a change crosses package or module boundaries
- implementation mode is not obvious

## Workflow

### Step 1: Validate planning posture

Start from upstream `planning_posture` if it exists. If posture is missing,
default conservatively instead of silently assuming triviality.

### Step 2: Compare approaches

Offer 1-3 materially different approaches with trade-offs, then choose one.

### Step 3: Reuse or intentionally reject precedent

Use retrieved repository precedents when they fit. If you deliberately diverge
from a consulted precedent, explain why the current case is materially
different.

### Step 4: Force the key decisions into the open

Make boundary ownership, migration posture, verification posture, rollback
assumptions, and preventive checks explicit before emitting the final plan.

### Step 5: Emit bounded artifacts

Produce:

- `design_spec`: objective, boundaries, and chosen approach
- `execution_plan`: ordered steps and verification intent
- `execution_mode_hint`: `direct_patch`, `test_first`, or `coordinated_rollout`
- `risk_register`: concrete risks and mitigations
- `implementation_targets`: concrete path-scoped files or directories the executor must touch

## Interaction Protocol

- Ask questions only when the answer changes the primary architecture choice,
  effect boundary, or acceptance criteria.
- If context may be stale, briefly re-ground the request in current repository
  reality before recommending a path.
- When user input is needed, recommend one primary path and one bounded
  alternative instead of presenting an open menu of possibilities.
- Treat `planning_posture` and precedent consultation as upstream inputs to
  planning, not as optional afterthoughts once design is already decided.

## Design Questions

Use these questions to keep planning first-principles-driven:

- Which boundary actually owns this change?
- Which option minimizes blast radius without weakening the outcome?
- What verification evidence would prove this path was the right one?
- What migration, rollback, or operator cost is being hidden by the most
  attractive-looking option?

## Decision Protocol

- Start with at most three viable approaches.
- Compare them on boundary ownership, blast radius, migration or rollback cost,
  verification strength, and operational risk.
- Choose one path explicitly. Do not leave the main design undecided unless the
  missing choice genuinely belongs to the user.
- Prefer complete but bounded work over shortcut plans that defer obvious edge
  cases into follow-up churn.

## Plan Emission Gate

- [ ] The chosen path is explicit.
- [ ] Deferred or rejected scope is named explicitly.
- [ ] Verification posture is concrete, not implied.
- [ ] Migration or rollback assumptions are visible to downstream skills.

## Handoff Expectations

- `design_spec` should tell implementation what is changing, what is not
  changing, which modules own the work, and which constraints are non-negotiable.
- `design_spec` should also state which precedents were reused and where the
  plan intentionally deviates from prior repository guidance.
- `execution_plan` should be ordered, concrete, and verification-aware so the
  implementation skill can execute without redesigning the task.
- `execution_plan` entries must stay structured enough that review and QA can
  consume step ownership, exit criteria, and verification intent without
  re-parsing prose.
- `execution_mode_hint` should be evidence-based. Use `direct_patch` only for
  truly local work, `test_first` when behavior needs pinning, and
  `coordinated_rollout` when change spans multiple boundaries.
- `risk_register` should be ranked by likely impact and should name the signals
  that review or verification must watch later.
- `risk_register` must name canonical change categories, required evidence, and
  the owner lane responsible for closing each risk.
- `implementation_targets` should name the highest-value path-scoped files or
  directories, not vague areas of the codebase.

## Stop Conditions

- a critical requirement is missing and changes the primary architecture choice
- all viable options violate hard constraints
- the real blocker is lack of repository understanding

## Anti-Patterns

- forcing design on an obvious one-file fix
- skipping trade-offs and presenting one option as inevitable
- producing a plan that is not tied to real path-scoped files or directories
- emitting generic architecture prose that does not help the next skill act

## Example

Input: "Refactor skill routing to add profile-aware filtering without weakening runtime governance."

Output: `design_spec`, `execution_plan`, `execution_mode_hint`, `risk_register`, `implementation_targets`.
