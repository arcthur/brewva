# Operator Conventions

Brewva already loads a global instructions layer: `CLAUDE.md` or `AGENTS.md` in
the agent directory (`~/.brewva` by default) enters every session's system
prompt as `source: "global"`, before ancestor and workspace instructions. Most
operators never populate it — and then every greenfield or foreign-workspace
session runs with zero norms: no documentation expectations, no warning
policy, no language conventions. A side-by-side harness audit showed exactly
this gap: the same model produced a README, zero warnings, and a proper bundle
identifier under one harness and none of them under another, purely because
one side injected operator conventions and the other had none to inject.

Conventions are advisory prompt context. They grant no tools and no authority;
they state what "done" looks like to you.

## What belongs here

- Output language and tone for explanations versus code.
- Documentation expectations (README on new projects, setup steps for anything
  needing permissions or credentials).
- Quality bar: warning policy, verification depth expectations, test
  expectations for non-trivial changes.
- Naming/identity defaults (bundle identifiers, license headers).

What does not: repository-specific rules (those live in the repo's own
`AGENTS.md`), secrets, or anything that changes per project.

## Starter template

Create `~/.brewva/AGENTS.md`:

```markdown
# Operator Conventions

## Language

- Explanations and discussion: <your language>.
- Code, comments, identifiers, commit messages: English.

## New projects

- Ship a README covering build, run, and first-run setup (permissions,
  credentials, environment) — a single-turn build has no "later".
- Use a real bundle/package identifier, never `com.example.*`.

## Quality bar

- Zero compiler/linter warnings, or each remaining one disclosed with a
  justification.
- A passing build is the `exit_code` verification rung, not completion. New
  applications require artifact-level checks and a requirements re-derivation
  from the code before claiming done.

## Verification

- Record verification outcomes with `verification_record` so Work Card
  Evidence and run reports see them.
```

## Verifying it loaded

Run any session and check the system prompt provenance: instruction files are
loaded global-first (`resource-loader` `source: "global"`), and
`brewva inspect --diagnostic` surfaces the composed context. If the file
exists and is readable it is in the prompt.

## Retro distillation: run-report -> retro -> trap library

Operator conventions state what "done" looks like going in. The trap library
(`@brewva/brewva-tools/trap-library`) is the matching mechanism coming out: it
compiles hindsight from audited runs into deterministic, phase-gated recall
that fires on future prompts, diffs, and files. This section is the standard
operator flow that keeps that library growing from evidence instead of
vibes — the same "no lesson without concrete evidence" bar the `retro` skill
holds already, applied specifically to trap authoring.

**1. Read the run report.** After an audited run — one with at least one
independent verification receipt or a recorded review finding —
`brewva inspect --session <id> --run-report` projects the tape into the same
evidence every other consumer (Work Card, `retro`) sees: verification receipt
count and latest rung, the authored/independent perspective split, findings
recorded, and whether the tape's latest receipt leaves review debt. Nothing
here is inferred from generation memory; it is folded from recorded events.

**2. Judge findings against requirements, not against each other.** The
distillation question is not "which findings were correct" — the report
predates that verdict. It is: which review findings had strong runtime
evidence behind them (a receipt, a reproducible command, a concrete file
pointer), and separately, which stated requirements had **no** runtime
evidence anywhere in the tape — no receipt, no finding, no independent
perspective touching them at all. That second category is the gap a trap
exists to close: an implicit requirement that only surfaced late, or didn't
surface at all until someone went looking.

**3. Compile new entries with real provenance and a retirement condition.**
Entries live in
`packages/brewva-tools/src/shared/trap-library/entries.ts` as
`TrapEntry` values matched by the pure `matchTraps` engine (see the module doc
comment in `packages/brewva-tools/src/shared/trap-library/index.ts` for the
full trigger/phase contract). Every new entry MUST carry:

- `provenance` — the actual trace or run it was distilled from (e.g. a tape
  path or run identifier), not a generic description. A trap with no traceable
  origin cannot be evaluated for retirement later and should not be added.
- `retirement` — a concrete, checkable condition under which the entry should
  be removed (typically: "retire when a deterministic adapter checks this
  directly"). A trap without a retirement condition is a permanent tax on
  every future match; name the condition at authoring time, not later.

**4. Remember what a trap actually does.** An `orient`-phase entry injects an
`atomCore` onto the task ledger — a requirement atom, stated before code
exists. A `write`/`verify`-phase entry surfaces a **lens**: advisory
"look here with this stance" text for whoever reviews the match next. A lens
firing is not a verdict — it fires on correct code and incorrect code alike
(the canonical case: an event-tap lens fires on every `CGEvent.tapCreate`
site, including a properly scoped one). Telling correct from incorrect is
deliberately not this layer's job; that precision guard is the W3 fitness
join, which reasons over verification evidence, not over trigger matches. Do
not encode "only fire on the broken variant" logic into a lens-surfacing
entry — write the trigger to find the _topic_, and let evidence adjudicate
the _verdict_.

## From visible debt to a blocking gate

`verification_record` claim-time annotates a contradicted `pass` with graded
`discrepancies[]` (`deterministic_conflict` | `advisory_conflict`) — visible on
the Work Card fitness line and `inspect run-report`'s Fitness section, never
blocking. When the SAME `deterministic_conflict` recurs on a high-risk atom
and an operator decides visible debt is no longer enough for that specific
risk, promote it into a `VerificationGateManifest` entry — the existing single
blocking path (axiom 18), never a new one. `advisory_conflict` (LLM-derived)
findings are never gate-eligible; only deterministic evidence can back a gate.
See "The Gate-Bridge Recipe" in `docs/reference/extensions.md` for the
field-by-field promotion.
