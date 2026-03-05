# Governance Priority Matrix

## Objective

Prioritize governance-kernel work by risk and leverage so non-essential adaptive logic does not block critical trust boundaries.

## P0 (must land first)

| Item                                                        | Risk | Expected Outcome                                               |
| ----------------------------------------------------------- | ---- | -------------------------------------------------------------- |
| Enforce Verification Gate command-backed checks             | High | `standard/strict` levels execute real verification commands    |
| Enforce Skill outputs completion lifecycle                  | High | unfinished active skills are detected and cannot silently pass |
| Enforce tool/cost boundary gates fail-closed under pressure | High | no silent over-budget or unauthorized execution path           |

Completion criteria:

- observable behavior change is present
- reproducible verification evidence exists
- rollback path is defined

## P1 (after P0 stabilization)

| Item                                                                                                   | Risk        | Expected Outcome                                                              |
| ------------------------------------------------------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------- |
| Harden deterministic context boundary path (compaction gate + arena SLO + governance integrity checks) | Medium-High | deterministic context behavior under pressure and long sessions               |
| Align evidence quality labeling with actual tool semantics                                             | Medium      | evidence can distinguish deterministic/native output from heuristic fallbacks |
| Complete memory projection + replay lifecycle                                                          | Medium      | projection state and replay checkpoints stay consistent across long sessions  |

Completion criteria:

- legacy cognitive/recall paths are absent from the control flow
- critical paths have regression verification

## P2 (hardening and governance)

| Item                                        | Risk   | Expected Outcome                                                  |
| ------------------------------------------- | ------ | ----------------------------------------------------------------- |
| Ledger checkpoint/compaction                | Medium | long-running sessions remain size-bounded                         |
| Skill regression test harness               | Medium | high-value skills are repeatably validated                        |
| Sanitization hardening and secret redaction | Medium | lower prompt-injection and data-leak risk                         |
| Governance event observability hardening    | Medium | anomaly, verification, integrity signals are queryable by default |

Completion criteria:

- minimum viable implementation is usable
- implementation is minimally invasive to existing flow

## Decision Rules

1. Always execute in P0 -> P1 -> P2 order.
2. Within same priority, complete dependency prerequisites first.
3. A task is never marked done without executable verification.

## Minimum Delivery Packet

Each completed task must include:

- change summary (what changed)
- verification evidence (how it was proven)
- residual risk statement (what remains uncovered)
