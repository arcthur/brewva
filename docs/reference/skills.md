# Reference: Skills

Skill parsing, merge, and selection logic:

- `packages/brewva-runtime/src/skills/contract.ts`
- `packages/brewva-runtime/src/skills/registry.ts`
- `packages/brewva-runtime/src/skills/selector.ts`

## Contract Metadata

Skill frontmatter supports dispatch-focused metadata:

- `triggers.intents/topics/phrases/negatives` for selector matching
- `dispatch.gate_threshold/auto_threshold/default_mode` for routing policy
- `outputs/consumes/composable_with` for deterministic chain planning

Selector execution is deterministic and lexical-first:

1. hard negative filtering (`triggers.negatives` with scope-aware intent/topic matching)
2. lexical scoring (`name/intents/intent-body/phrases/tags`) with structured score breakdown (`anti-tag` penalty + `costHint` adjustment included)
3. lightweight token alias expansion is applied inside lexical matching (for example `review/audit`, `ready/release/ship`) to reduce brittle phrase dependence while staying zero-dependency

`skills_index.json` now carries the normalized `outputs`, `triggers`, and `dispatch` fields for each skill entry.

## Base Skills

- `brainstorming`
- `cartography`
- `compose`
- `debugging`
- `execution`
- `exploration`
- `finishing`
- `git`
- `patching`
- `planning`
- `review`
- `tdd`
- `verification`

## Pack Skills

- `agent-browser`
- `frontend-design`
- `gh-issues`
- `github`
- `skill-creator`
- `telegram-interactive-components`

## Project Skills

- `brewva-project`
- `brewva-self-improve`
- `brewva-session-logs`

## Project Skill Notes

- `brewva-project` orchestrates source-lane analysis, process-evidence diagnosis,
  and delivery flows for runtime-facing work in this monorepo.
- `brewva-session-logs` provides artifact-centric inspection across event store,
  evidence ledger, memory, snapshots, cost traces, and schedule projections.
- `brewva-self-improve` captures reusable learnings and errors, then promotes
  validated patterns into durable assets such as `AGENTS.md`, skills, and docs.

## `brewva-project` Contract Focus

- Baseline tools stay read-first: `read`, `grep`.
- Optional tools are aligned with the `@brewva/brewva-tools` runtime surface
  (LSP, AST, process, ledger/tape/cost, schedule, task ledger, skill lifecycle tools).
- Generic mutation-only tools (`write`, `edit`) remain intentionally excluded;
  code changes are delegated to specialized skills such as `patching`.

## Storage Convention

- `skills/base/<skill>/SKILL.md`
- `skills/packs/<pack>/SKILL.md`
- `skills/project/<skill>/SKILL.md`

Runtime discovery also accepts roots provided via `skills.roots` and executable
sidecar assets. See `docs/reference/configuration.md` (Skill Discovery).
