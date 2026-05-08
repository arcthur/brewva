# Skill Playbook

This guide is a human-readable operating map for Brewva skills. Runtime routing
truth remains in skill frontmatter, runtime contracts, and workflow status. This
file does not introduce automatic cascades, aliases, or `suggested_chains`.

## Trigger Table

| Group         | Skills                                                                                                              | Use When                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-build     | `repository-analysis`, `architecture`, `office-hours`, `discovery`, `strategy`, `learning-research`, `plan`, `prep` | The task needs orientation, idea diagnosis, architecture deepening, scope pressure, precedent, planning, or explicit implementation targets before code changes |
| Build         | `implementation`, `goal-loop`, `ci-iteration`, `frontend-design`, `extract`                                         | The task is bounded execution, repeated improvement, CI repair, UI-specific design, or structured data extraction                                               |
| Post-build    | `review`, `qa`, `ship`, `retro`, `knowledge-capture`                                                                | The change needs risk review, executable verification, release handoff, retrospective analysis, or durable lesson capture                                       |
| Diagnostic    | `debugging`, `runtime-forensics`, `predict-review`                                                                  | The task needs root cause, runtime trace reconstruction, or pre-merge adversarial prediction                                                                    |
| Operator/Data | `git`, `github`, `telegram`, `agent-browser`                                                                        | The work centers on repository operations, GitHub workflow, Telegram delivery, or browser observation                                                           |

## Pre-Build Frame Choice

Use this table before choosing among `office-hours`, `discovery`, and
`strategy`. These skills are intentionally separate because they answer
different questions; do not merge them mentally into a generic framing step.

| Signal                                                                                                                             | Choose                | Why                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------- |
| The prompt is a new product, startup, side-project, hackathon, learning, or "worth building" idea before a concrete request exists | `office-hours`        | Diagnose the premise, target human, status quo, and next evidence assignment before framing a product request |
| The prompt is an existing repo/product/operator request, but the pain, non-goals, or real problem are fuzzy                        | `discovery`           | Reframe the stated request into the actual problem and narrowest credible wedge                               |
| A plausible wedge exists, but timing, sequencing, scope posture, or product leverage are still uncertain                           | `strategy`            | Pressure-test whether the wedge should expand, hold, narrow, defer, or proceed                                |
| The hot path or affected code is unknown and blocks all three choices                                                              | `repository-analysis` | Map the working area before product or scope judgment                                                         |
| The module boundary or caller burden is the main concern                                                                           | `architecture`        | Assess seam depth and locality before `plan` resolves trade-offs                                              |
| A chosen path exists and implementation trade-offs remain                                                                          | `plan`                | Select the execution path, rejected options, risks, and implementation targets                                |
| A current plan already emitted `implementation_targets`                                                                            | skip `prep`           | Avoid restating targets; go to `implementation` or the next explicit owner                                    |

Vocabulary:

- `wedge`: the smallest meaningful bet that changes user reality.
- `premise`: the claim that would make the idea worth pursuing.
- `target human`: the specific person or role whose current behavior matters.
- `status quo`: what the target human does today instead.
- `posture`: the scope/timing stance inherited by downstream planning.

`composable_with` is authoring metadata for known-safe concurrent use, not a
runtime lifecycle gate or taxonomy coverage checklist. Absence does not imply
that a skill is less important.

## Manual Chains

Use chains as explicit handoffs, not automatic cascades. Each transition should
be selected by the user, the model, or `workflow_status`.

- `repository-analysis -> discovery -> strategy -> learning-research -> plan -> prep -> implementation -> review -> qa -> ship`
- `office-hours -> discovery -> strategy -> plan` when a new product, startup, side-project, hackathon, or "worth building" idea needs diagnosis before an existing request frame exists
- `office-hours -> strategy -> plan` when office-hours confirms a plausible wedge and the next question is timing, sequencing, or scope posture
- `repository-analysis -> architecture -> plan -> implementation -> review` when the task is to deepen modules, improve testability, or reduce caller burden
- `repository-analysis -> plan -> implementation -> review`
- `frontend-design -> implementation -> qa`
- `frontend-design -> plan -> implementation -> qa` when UI direction changes
  cross-package architecture, data contracts, or product scope.
- `extract -> review -> knowledge-capture`
- `runtime-forensics -> debugging -> plan -> implementation`
- `ship -> retro -> knowledge-capture`

## Escalation Chains

Escalation means the current skill hit a stop condition and names the next owner
explicitly.

- `debugging -> implementation -> review -> qa`: confirmed local root cause with a bounded fix.
- `debugging -> plan`: root cause is confirmed but the repair crosses ownership or public contract boundaries.
- `goal-loop -> plan`: the loop is below the noise floor or the goal contract is still fuzzy.
- `qa -> debugging`: verification found a reproducible failure without confirmed cause.
- `review -> implementation`: findings are actionable and scoped to parent-owned edits.
- `review -> patch-worker`: findings are suitable for delegated patch work.
- `prep -> plan`: scope or success criteria require planning decisions, not just implementation bounds.
- `strategy -> office-hours`: demand, status quo, target human, or wedge evidence is still missing.
- `discovery -> office-hours`: the prompt is a new idea rather than an existing request that can be reframed.

## Stop Rule

Skill switching is explicit. A chain advances only when one of these is true:

- the user selects the next skill
- the model names a stop condition and handoff target
- `workflow_status` shows readiness, stale evidence, or a missing artifact that
  makes the next owner clear

Do not add automatic cascade behavior. Do not infer a hidden chain from this
document. Do not preserve old skill-name aliases.
