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
