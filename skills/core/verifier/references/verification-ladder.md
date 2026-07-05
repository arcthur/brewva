# Verification Ladder

Verification depth is a ladder, not a boolean. Each rung subsumes the ones below
it. A completion claim states the rung it reached and why that rung is
sufficient for the task shape. "The build passed" is the bottom rung, not the
finish line.

## Rungs

| Rung              | Question it answers                                       | Typical evidence                                                                                                            |
| ----------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **exit_code**     | Did the toolchain accept the change?                      | Build/test command exit 0                                                                                                   |
| **diagnostics**   | Did the toolchain accept it _cleanly_?                    | Zero warnings, or each remaining diagnostic disclosed with a justification                                                  |
| **artifact**      | Is the produced artifact structurally what was asked for? | Bundle layout, manifest keys, signatures, min-OS/platform metadata, entry points                                            |
| **requirements**  | Does the code satisfy each stated requirement?            | Requirement-by-requirement re-derivation from the code, each with a file:line pointer — not from memory of what was written |
| **runtime_smoke** | Does it behave when actually executed?                    | Side-effect-free launch, probe of the primary flow, captured output                                                         |

## Choosing the target rung

- Library or utility change inside a tested repo: `diagnostics` plus the repo's
  configured checks is usually sufficient.
- New application, new package, or greenfield workspace: `artifact` and
  `requirements` are the floor. Nothing else in the workspace will catch what
  the compiler cannot see.
- Behavior disputed, regression-prone, or user-facing flows changed:
  `runtime_smoke` when a side-effect-free probe exists.

## Recording

Commit the reached rung with the `verification_record` tool. The receipt is the
canonical `verification.outcome.recorded` event: Work Card Evidence, stall
adjudication, and `inspect run-report` all read it. An unrecorded verification
did not happen, no matter what the transcript says.

At `requirements` rung or above, a `pass` outcome is cross-checked against the
requirement-fitness projection and the result text may carry a `fitness:`
summary line and a `review_debt:` marker. Reaching the rung is not the finish
line for the final answer either: see `SKILL.md` Phase 4 for the disclosure
this receipt obligates — the rung says what was checked, the receipt's own
markers say what is still unverified or unreviewed, and the final answer
must state both, not just the rung.

## Evidence grade

A rung says how DEEP the check went; the grade says how the check KNOWS — the two
are orthogonal. Three grades, weakest to strongest:

- `presence` — a token or pattern is there (a grep of the source). It cannot see a
  MISSING guard: grepping `keyCode` proves nothing about whether suppression is
  actually keycode-scoped.
- `static_guard` — a deterministic predicate ran over the real source and checked
  the failure mode's absence directly, the negative property presence cannot see.
  At the `requirements` rung, `verification_record` runs these static-guard
  adapters itself over the fresh-touched source and records the results as
  `evidenceItems` on the receipt — the grade is earned by the predicate RUNNING,
  so a model cannot fabricate it.
- `behavioral` — the property was observed at runtime (the `runtime_smoke` rung).

A requirement whose risk class is `runtime` or `security` cannot reach `satisfied`
on `presence`-grade evidence alone: a re-grep that a failure-mode atom "looks
present" is exactly how the counterexample below shipped. Such an atom caps at
`likelySatisfied` and surfaces in the receipt's `insufficientGradeAtoms` — an
honest "verified, but not at the grade this risk demands", never a fake pass. A
`static_guard` FAIL is a real `deterministic_conflict`; the fitness projection,
not the grep, owns that verdict.

## The counterexample to remember

A 711-line macOS app once shipped at `exit_code` green with nine latent defects:
an event-tap guard that swallowed unrelated modifier keys, a permanently dying
tap with no re-enable path, a first-run dead end after permission grant, a
force-unwrapped user-configurable URL, an over-released CF constant, animations
that silently degraded to snaps, a Makefile that reused stale binaries, an IME
detector that missed third-party input methods, and a race in the overlay
dismiss path. Every one of them passes `exit_code`. The first four fall to an
`artifact` + `requirements` pass; the animation and Makefile defects fall to
`runtime_smoke`.
