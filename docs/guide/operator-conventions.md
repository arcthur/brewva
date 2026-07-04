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
