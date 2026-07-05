---
name: greenfield
description: Standing up a new project in an empty or foreign workspace with staged writes and
  ladder-based verification.
selection:
  when_to_use: Use when implementing a new application or package in an empty or foreign workspace
    where no repository conventions, checks, or instructions exist yet.
references:
  - ../verifier/references/verification-ladder.md
---

# Greenfield

## The Iron Law

```
PROBE THE TOOLCHAIN BEFORE TRUSTING A SINGLE ASSUMPTION ABOUT IT
```

An empty workspace has no tests, no lint, no CI, and no instructions. Every
safety net the implementation loop normally leans on is absent. The compiler is
the only reviewer that shows up by default — and it only checks the bottom rung.

## When to Use

- The workspace is empty or contains no build system for the requested stack.
- The task creates a new application, service, or package from scratch.
- Repository instructions, configured checks, and project skills are absent.

**Do NOT use when:**

- The change lands inside an existing project — use `implementation`.
- The task is exploratory design, not construction — use `prep` or `plan`.

## Workflow

### Phase 1: Probe the toolchain

Before generating substantial code, validate the two assumptions that sink
greenfield builds: the entry-point convention and the build invocation. Write
the minimal manifest plus a compilable stub and build it. Entry-point rules are
toolchain trivia models misremember (attribute-based vs file-named entry
points, executable vs library targets, manifest schema versions); a 30-second
probe converts that risk into evidence.

**If the probe fails**: fix the skeleton first. Do not stack application code
on an unverified foundation.

### Phase 2: Grow in compilable milestones

Land code in units the toolchain can check as you go — per module, per
subsystem, roughly every 150 new lines. Compile between milestones. The first
compiler contact must not happen after everything is already written.

### Phase 3: Verify on the ladder

`exit_code` green is the floor, not the goal. Greenfield completion requires
the `artifact` rung (the produced artifact is structurally what was asked:
layout, metadata, signatures, platform floors) and the `requirements` rung
(each stated requirement re-derived from the code with a concrete pointer, not
recalled from generation memory). Record the reached rung with
`verification_record`.

**Final-answer disclosure**: `verification_record`'s result text is the
disclosure, not a paraphrase target. Never hand off a bare "requirements
pass" — state the `fitness:` line verbatim when the result carries one
(`N satisfied / M unverified (K must) / J violated; D discrepancies (G
deterministic)`), naming every unverified `must`-modality atom by id, and
state the `review_debt:` marker verbatim when present, reporting the
delivery as `pass (authored-only, review debt)` rather than a bare pass — a
freshly built workspace has by construction had no independent review yet.

### Phase 4: Leave the workspace livable

A greenfield deliverable includes the minimum an operator needs to run it:
build and run entry points, first-run setup steps (permissions, credentials,
environment), and known limitations. If operator conventions supply
expectations (README, artifact hygiene, warning policy), honor them — in an
empty workspace they are the only project standards that exist.

## Decision Protocol

- Which toolchain assumption, if wrong, invalidates the most written code?
- What is the smallest stub that proves the build skeleton works?
- Which requirement has no evidence yet besides "I remember writing it"?
- What does the first human who clones this need to know to run it once?

## Red Flags — STOP

- "I'll write the whole thing and build at the end"
- "The entry point surely works like I remember"
- "The build passed, so the requirements are met"
- "A README can come later" — later never arrives in a single-turn build
- Treating generated-code recall as requirement evidence

## Handoff Expectations

- The build skeleton probe result and the milestones actually compiled.
- The verification rung reached, with the artifact and requirements evidence,
  plus the Phase 3 fitness/review-debt disclosure for any `pass` — not a bare
  rung name.
- The operator-facing run/setup notes that shipped with the code.

## Stop Conditions

- The requested stack's toolchain is unavailable in the execution environment.
- Requirements imply an existing codebase that is not actually present.
- The artifact rung cannot be evidenced with available tooling.
